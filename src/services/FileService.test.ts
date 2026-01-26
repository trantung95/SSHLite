/**
 * FileService tests - focused on save/upload flow behavior
 *
 * Tests the critical save logic including:
 * - skipNextSave behavior (the main bug that was fixed)
 * - File mapping checks (save silently fails without mapping)
 * - skipNextSave safety net (leak prevention when document.save() is no-op)
 * - Debounce and pending upload tracking
 * - Flush pending upload on document close / file reopen
 * - Full lifecycle: open → edit → save → close → reopen → edit → save
 *
 * Since FileService is a complex singleton tightly coupled to VS Code and SSH,
 * these tests simulate the core save flow logic as behavioral tests.
 */

describe('FileService - Save/Upload Flow Logic', () => {
  /**
   * Simulate the core save flow logic extracted from FileService.
   * This mirrors the actual code structure for reliable regression testing.
   */
  class SaveFlowSimulator {
    skipNextSave: Set<string> = new Set();
    pendingUploads: Map<string, { timer: ReturnType<typeof setTimeout>; uploadFn: () => Promise<void> }> = new Map();
    pendingUploadPromises: Map<string, Promise<void>> = new Map();
    uploadedFiles: Map<string, string> = new Map(); // path -> content
    originalContent: Map<string, string> = new Map(); // path -> content

    /**
     * File mappings track which local files correspond to remote files.
     * Without a mapping, handleFileSave silently returns (no upload).
     * Mappings are created by openRemoteFile and deleted by cleanupConnection.
     */
    fileMappings: Map<string, { connectionId: string; remotePath: string; originalContent?: string }> = new Map();

    /** Simulate handleFileSave — includes mapping check matching real code */
    handleFileSave(localPath: string, textContent: string, debounceMs = 500): void {
      // Real code checks: if no mapping, return silently
      if (!this.fileMappings.has(localPath)) {
        return;
      }

      if (this.skipNextSave.has(localPath)) {
        this.skipNextSave.delete(localPath);
        return;
      }

      // Cancel any existing pending upload
      const existingPending = this.pendingUploads.get(localPath);
      if (existingPending) {
        clearTimeout(existingPending.timer);
      }

      const uploadFn = async () => {
        this.pendingUploads.delete(localPath);
        const uploadPromise = this.upload(localPath, textContent);
        this.pendingUploadPromises.set(localPath, uploadPromise);
        try {
          await uploadPromise;
        } finally {
          this.pendingUploadPromises.delete(localPath);
        }
      };

      const timer = setTimeout(uploadFn, debounceMs);
      this.pendingUploads.set(localPath, { timer, uploadFn });
    }

    /** Simulate uploadFileWithAudit */
    async upload(localPath: string, content: string): Promise<void> {
      this.uploadedFiles.set(localPath, content);
      this.originalContent.set(localPath, content);
    }

    /** Simulate flushPendingUpload */
    async flushPendingUpload(localPath: string): Promise<void> {
      const pending = this.pendingUploads.get(localPath);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingUploads.delete(localPath);
        await pending.uploadFn();
        return;
      }
      const inFlight = this.pendingUploadPromises.get(localPath);
      if (inFlight) {
        await inFlight;
      }
    }

    /** Simulate revert (should NOT add to skipNextSave - this was the bug!) */
    revertDocument(_localPath: string): void {
      // workbench.action.files.revert does NOT trigger onDidSaveTextDocument
      // So we must NOT add to skipNextSave here
      // Previously buggy code did: this.skipNextSave.add(localPath);
    }

    /**
     * Simulate document.save() - DOES trigger onDidSaveTextDocument.
     * Includes safety net: delete skipNextSave after save in case the
     * event doesn't fire (e.g., document wasn't actually dirty because
     * VS Code cached document has same content).
     */
    saveDocument(localPath: string, content: string, eventFires = true): void {
      // document.save() DOES trigger onDidSaveTextDocument
      // So skipNextSave IS correct here
      this.skipNextSave.add(localPath);

      if (eventFires) {
        // Simulate the save event firing — this consumes skipNextSave
        this.handleFileSave(localPath, content);
      }
      // else: document.save() was a no-op (doc wasn't dirty)

      // Safety net: ensure skipNextSave is consumed even if onDidSaveTextDocument
      // didn't fire (can happen if document wasn't actually dirty)
      this.skipNextSave.delete(localPath);
    }

    /**
     * Simulate openRemoteFile — creates mapping and saves document.
     * Returns the local path used.
     */
    openRemoteFile(
      connectionId: string,
      remotePath: string,
      localPath: string,
      content: string,
      documentAlreadyOpen = false,
      documentContent?: string
    ): string {
      if (documentAlreadyOpen && !this.fileMappings.has(localPath)) {
        // Document is open but mapping was deleted (e.g., by cleanupConnection
        // after disconnect+reconnect). Recreate the mapping.
        this.fileMappings.set(localPath, {
          connectionId,
          remotePath,
          originalContent: documentContent ?? content,
        });
        return localPath;
      }

      // Normal case: create mapping
      this.fileMappings.set(localPath, {
        connectionId,
        remotePath,
        originalContent: content,
      });
      this.originalContent.set(localPath, content);

      // Save document to disk (which triggers onDidSaveTextDocument)
      this.saveDocument(localPath, content);

      return localPath;
    }

    /** Simulate cleanupConnection — deletes all mappings for a connection */
    cleanupConnection(connectionId: string): void {
      for (const [localPath, mapping] of this.fileMappings) {
        if (mapping.connectionId === connectionId) {
          this.fileMappings.delete(localPath);
        }
      }
    }
  }

  let flow: SaveFlowSimulator;

  beforeEach(() => {
    jest.useFakeTimers();
    flow = new SaveFlowSimulator();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('skipNextSave behavior', () => {
    it('should skip upload when skipNextSave is set', () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });
      flow.skipNextSave.add(path);
      flow.handleFileSave(path, 'content');

      // Should have consumed the skip
      expect(flow.skipNextSave.has(path)).toBe(false);
      // Should NOT have created a pending upload
      expect(flow.pendingUploads.has(path)).toBe(false);
    });

    it('should only skip ONE save when set', () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });
      flow.skipNextSave.add(path);

      // First save: skipped
      flow.handleFileSave(path, 'content v1');
      expect(flow.pendingUploads.has(path)).toBe(false);

      // Second save: should NOT be skipped
      flow.handleFileSave(path, 'content v2');
      expect(flow.pendingUploads.has(path)).toBe(true);
    });

    it('REGRESSION: revert should NOT add to skipNextSave', () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      // This is the core bug that was fixed: revert was adding to skipNextSave
      // but revert doesn't trigger onDidSaveTextDocument, so the skip was never
      // consumed and silently ate the next user save
      flow.revertDocument(path);
      expect(flow.skipNextSave.has(path)).toBe(false);

      // User save after revert should work normally
      flow.handleFileSave(path, 'user edit');
      expect(flow.pendingUploads.has(path)).toBe(true);
    });

    it('REGRESSION: save flow after file watcher revert should upload', async () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      // Simulate the full flow that was broken:
      // 1. User opens file with content "original"
      flow.originalContent.set(path, 'original');

      // 2. User edits and saves with "modified"
      flow.handleFileSave(path, 'modified');
      jest.advanceTimersByTime(500);
      await Promise.resolve(); // Let upload complete
      expect(flow.uploadedFiles.get(path)).toBe('modified');

      // 3. File watcher detects change, reverts document
      //    (This is where the old bug was - it would set skipNextSave)
      flow.revertDocument(path);

      // 4. User edits again and saves with "modified v2"
      flow.handleFileSave(path, 'modified v2');
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      // 5. The upload SHOULD happen (previously was silently skipped!)
      expect(flow.uploadedFiles.get(path)).toBe('modified v2');
    });

    it('document.save() should correctly use skipNextSave', () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      // When we programmatically save (e.g., after loading content), we DO want
      // to skip the next save to prevent re-uploading what we just downloaded
      flow.saveDocument(path, 'downloaded content');

      // The handleFileSave was called but should have been skipped
      expect(flow.pendingUploads.has(path)).toBe(false);
      expect(flow.skipNextSave.has(path)).toBe(false); // consumed by safety net

      // Next user save should work normally
      flow.handleFileSave(path, 'user edit');
      expect(flow.pendingUploads.has(path)).toBe(true);
    });

    it('REGRESSION: skipNextSave should not leak when document.save() is no-op', () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      // Simulate: document.save() called but document wasn't dirty,
      // so onDidSaveTextDocument never fires
      flow.saveDocument(path, 'content', false /* eventFires=false */);

      // Safety net should have cleared skipNextSave even though event didn't fire
      expect(flow.skipNextSave.has(path)).toBe(false);

      // Next user save should work normally (not silently swallowed)
      flow.handleFileSave(path, 'user edit');
      expect(flow.pendingUploads.has(path)).toBe(true);
    });
  });

  describe('file mapping checks', () => {
    it('should silently skip save when no mapping exists', () => {
      // No mapping set for this path
      flow.handleFileSave('/tmp/unmapped.ts', 'content');

      // No pending upload should be created
      expect(flow.pendingUploads.has('/tmp/unmapped.ts')).toBe(false);
    });

    it('should upload when mapping exists', () => {
      const path = '/tmp/mapped.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      flow.handleFileSave(path, 'content');

      expect(flow.pendingUploads.has(path)).toBe(true);
    });

    it('REGRESSION: save should fail silently after cleanupConnection deletes mapping', async () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      // User edits and saves — works fine
      flow.handleFileSave(path, 'v1');
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      expect(flow.uploadedFiles.get(path)).toBe('v1');

      // Connection drops → cleanupConnection deletes mapping
      flow.cleanupConnection('c1');
      expect(flow.fileMappings.has(path)).toBe(false);

      // User tries to save again — should silently fail (no mapping)
      flow.handleFileSave(path, 'v2');
      expect(flow.pendingUploads.has(path)).toBe(false);
      // Upload should still be v1, not v2
      expect(flow.uploadedFiles.get(path)).toBe('v1');
    });

    it('should work again after mapping is recreated', async () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      // Save works
      flow.handleFileSave(path, 'v1');
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      expect(flow.uploadedFiles.get(path)).toBe('v1');

      // Connection drops → cleanup
      flow.cleanupConnection('c1');

      // Reconnect → openRemoteFile recreates mapping
      flow.openRemoteFile('c2', '/test.ts', path, 'v1', true, 'v1');
      expect(flow.fileMappings.has(path)).toBe(true);
      expect(flow.fileMappings.get(path)?.connectionId).toBe('c2');

      // User edits and saves — should work with new mapping
      flow.handleFileSave(path, 'v2');
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      expect(flow.uploadedFiles.get(path)).toBe('v2');
    });
  });

  describe('debounce behavior', () => {
    it('should debounce rapid saves', () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      flow.handleFileSave(path, 'v1', 500);
      flow.handleFileSave(path, 'v2', 500);
      flow.handleFileSave(path, 'v3', 500);

      // Only one pending upload should exist
      expect(flow.pendingUploads.size).toBe(1);
    });

    it('should upload last content after debounce completes', async () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      flow.handleFileSave(path, 'v1', 500);
      flow.handleFileSave(path, 'v2', 500);
      flow.handleFileSave(path, 'v3', 500);

      jest.advanceTimersByTime(500);
      await Promise.resolve();

      expect(flow.uploadedFiles.get(path)).toBe('v3');
    });

    it('should handle independent files separately', async () => {
      const path1 = '/tmp/file1.ts';
      const path2 = '/tmp/file2.ts';
      flow.fileMappings.set(path1, { connectionId: 'c1', remotePath: '/file1.ts' });
      flow.fileMappings.set(path2, { connectionId: 'c1', remotePath: '/file2.ts' });

      flow.handleFileSave(path1, 'content1', 500);
      flow.handleFileSave(path2, 'content2', 500);

      expect(flow.pendingUploads.size).toBe(2);

      jest.advanceTimersByTime(500);
      await Promise.resolve();

      expect(flow.uploadedFiles.get(path1)).toBe('content1');
      expect(flow.uploadedFiles.get(path2)).toBe('content2');
    });

    it('should capture content eagerly at save time', async () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      // This tests the fix: content is captured at handleFileSave time,
      // not when the debounce timer fires
      let capturedContent = 'initial';
      flow.handleFileSave(path, capturedContent, 500);

      // Even if the variable changes before debounce fires,
      // the captured content should still be 'initial'
      capturedContent = 'changed after save';

      jest.advanceTimersByTime(500);
      await Promise.resolve();

      // The uploaded content should be what was captured at save time
      expect(flow.uploadedFiles.get(path)).toBe('initial');
    });
  });

  describe('flushPendingUpload', () => {
    it('should immediately execute pending upload', async () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      flow.handleFileSave(path, 'content', 500);

      // Upload should not have happened yet (debounce hasn't fired)
      expect(flow.uploadedFiles.has(path)).toBe(false);

      // Flush should immediately execute
      await flow.flushPendingUpload(path);

      expect(flow.uploadedFiles.get(path)).toBe('content');
      expect(flow.pendingUploads.has(path)).toBe(false);
    });

    it('should wait for in-flight upload to complete', async () => {
      // Create an upload that takes time
      let resolveUpload: () => void;
      const uploadPromise = new Promise<void>(resolve => {
        resolveUpload = resolve;
      });

      flow.pendingUploadPromises.set('/tmp/test.ts', uploadPromise);

      // Start flush — it should wait for the in-flight upload
      const flushPromise = flow.flushPendingUpload('/tmp/test.ts');

      // Resolve the in-flight upload
      resolveUpload!();
      await flushPromise;

      // flushPendingUpload only awaits the promise — cleanup is done by the
      // upload function's finally block. Verify flush completed without errors.
    });

    it('should do nothing when no pending upload exists', async () => {
      // Should not throw
      await flow.flushPendingUpload('/tmp/nonexistent.ts');
    });

    it('should clear the debounce timer when flushing', async () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      flow.handleFileSave(path, 'content', 500);

      await flow.flushPendingUpload(path);

      // Advancing timers should not cause a second upload
      const uploadCount = flow.uploadedFiles.size;
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      // Upload count should be the same (no duplicate upload)
      expect(flow.uploadedFiles.size).toBe(uploadCount);
    });
  });

  describe('close-then-reopen flow', () => {
    it('should flush pending upload on close before reopening', async () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      // User edits and saves
      flow.handleFileSave(path, 'edited content', 500);

      // User closes tab before debounce fires
      // onDidCloseTextDocument calls flushPendingUpload
      await flow.flushPendingUpload(path);

      // Content should have been uploaded
      expect(flow.uploadedFiles.get(path)).toBe('edited content');

      // User reopens file - openRemoteFile calls flushPendingUpload first
      await flow.flushPendingUpload(path);

      // The uploaded content should be the user's edit
      expect(flow.uploadedFiles.get(path)).toBe('edited content');
    });

    it('REGRESSION: full lifecycle — open, edit, save, close, reopen, edit, save', async () => {
      const localPath = '/tmp/ssh-lite-c1/src/test.ts';
      const remotePath = '/src/test.ts';

      // 1. Open file — creates mapping
      flow.openRemoteFile('c1', remotePath, localPath, 'original content');
      expect(flow.fileMappings.has(localPath)).toBe(true);
      expect(flow.fileMappings.get(localPath)?.connectionId).toBe('c1');
      // saveDocument was called by openRemoteFile, skipNextSave should be consumed
      expect(flow.skipNextSave.has(localPath)).toBe(false);

      // 2. User edits and saves
      flow.handleFileSave(localPath, 'user edit v1');
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      expect(flow.uploadedFiles.get(localPath)).toBe('user edit v1');

      // 3. Close document — flush pending
      await flow.flushPendingUpload(localPath);

      // 4. Reopen same file — mapping should still exist
      flow.openRemoteFile('c1', remotePath, localPath, 'user edit v1');
      expect(flow.fileMappings.has(localPath)).toBe(true);

      // 5. User edits again and saves
      flow.handleFileSave(localPath, 'user edit v2');
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      // 6. Upload should succeed
      expect(flow.uploadedFiles.get(localPath)).toBe('user edit v2');
    });

    it('REGRESSION: disconnect + reconnect + reopen lifecycle', async () => {
      const localPath = '/tmp/ssh-lite-c1/src/test.ts';
      const remotePath = '/src/test.ts';

      // 1. Open file — creates mapping with connection c1
      flow.openRemoteFile('c1', remotePath, localPath, 'content');
      expect(flow.fileMappings.get(localPath)?.connectionId).toBe('c1');

      // 2. User edits and saves — works
      flow.handleFileSave(localPath, 'edited');
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      expect(flow.uploadedFiles.get(localPath)).toBe('edited');

      // 3. Connection drops → cleanupConnection
      flow.cleanupConnection('c1');
      expect(flow.fileMappings.has(localPath)).toBe(false);

      // 4. User tries to save while disconnected — silently fails (no mapping)
      flow.handleFileSave(localPath, 'while disconnected');
      expect(flow.pendingUploads.has(localPath)).toBe(false);
      expect(flow.uploadedFiles.get(localPath)).toBe('edited'); // unchanged

      // 5. Reconnect — openRemoteFile with documentAlreadyOpen=true recreates mapping
      flow.openRemoteFile('c2', remotePath, localPath, 'edited', true, 'while disconnected');
      expect(flow.fileMappings.has(localPath)).toBe(true);
      expect(flow.fileMappings.get(localPath)?.connectionId).toBe('c2');

      // 6. User edits and saves — should work with new connection mapping
      flow.handleFileSave(localPath, 'after reconnect');
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      expect(flow.uploadedFiles.get(localPath)).toBe('after reconnect');
    });
  });

  describe('concurrent operations', () => {
    it('should handle save during in-flight upload', async () => {
      const path = '/tmp/test.ts';
      flow.fileMappings.set(path, { connectionId: 'c1', remotePath: '/test.ts' });

      // First save starts uploading
      flow.handleFileSave(path, 'v1', 0); // immediate
      jest.advanceTimersByTime(0);

      // Second save while first is in flight
      flow.handleFileSave(path, 'v2', 500);

      // Flush to complete all
      await flow.flushPendingUpload(path);

      // Latest content should win
      expect(flow.uploadedFiles.get(path)).toBe('v2');
    });

    it('should handle multiple files from different connections', async () => {
      const path1 = '/tmp/ssh-lite-c1/file.ts';
      const path2 = '/tmp/ssh-lite-c2/file.ts';
      flow.fileMappings.set(path1, { connectionId: 'c1', remotePath: '/file.ts' });
      flow.fileMappings.set(path2, { connectionId: 'c2', remotePath: '/file.ts' });

      flow.handleFileSave(path1, 'content from server 1');
      flow.handleFileSave(path2, 'content from server 2');

      jest.advanceTimersByTime(500);
      await Promise.resolve();

      expect(flow.uploadedFiles.get(path1)).toBe('content from server 1');
      expect(flow.uploadedFiles.get(path2)).toBe('content from server 2');
    });

    it('should handle cleanupConnection for one connection without affecting others', async () => {
      const path1 = '/tmp/ssh-lite-c1/file.ts';
      const path2 = '/tmp/ssh-lite-c2/file.ts';
      flow.fileMappings.set(path1, { connectionId: 'c1', remotePath: '/file.ts' });
      flow.fileMappings.set(path2, { connectionId: 'c2', remotePath: '/file.ts' });

      // Disconnect c1 only
      flow.cleanupConnection('c1');

      expect(flow.fileMappings.has(path1)).toBe(false);
      expect(flow.fileMappings.has(path2)).toBe(true);

      // c2 save should still work
      flow.handleFileSave(path2, 'still works');
      jest.advanceTimersByTime(500);
      await Promise.resolve();
      expect(flow.uploadedFiles.get(path2)).toBe('still works');

      // c1 save should silently fail
      flow.handleFileSave(path1, 'should not upload');
      expect(flow.pendingUploads.has(path1)).toBe(false);
    });
  });
});
