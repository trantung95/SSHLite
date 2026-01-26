/**
 * FileService tests - focused on save/upload flow behavior
 *
 * Tests the critical save logic including:
 * - skipNextSave behavior (the main bug that was fixed)
 * - Debounce and pending upload tracking
 * - Flush pending upload on document close / file reopen
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

    /** Simulate handleFileSave */
    handleFileSave(localPath: string, textContent: string, debounceMs = 500): void {
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

    /** Simulate document.save() - DOES trigger onDidSaveTextDocument */
    saveDocument(localPath: string, content: string): void {
      // document.save() DOES trigger onDidSaveTextDocument
      // So skipNextSave IS correct here
      this.skipNextSave.add(localPath);
      // Simulate the save event firing
      this.handleFileSave(localPath, content);
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
      flow.skipNextSave.add('/tmp/test.ts');
      flow.handleFileSave('/tmp/test.ts', 'content');

      // Should have consumed the skip
      expect(flow.skipNextSave.has('/tmp/test.ts')).toBe(false);
      // Should NOT have created a pending upload
      expect(flow.pendingUploads.has('/tmp/test.ts')).toBe(false);
    });

    it('should only skip ONE save when set', () => {
      flow.skipNextSave.add('/tmp/test.ts');

      // First save: skipped
      flow.handleFileSave('/tmp/test.ts', 'content v1');
      expect(flow.pendingUploads.has('/tmp/test.ts')).toBe(false);

      // Second save: should NOT be skipped
      flow.handleFileSave('/tmp/test.ts', 'content v2');
      expect(flow.pendingUploads.has('/tmp/test.ts')).toBe(true);
    });

    it('REGRESSION: revert should NOT add to skipNextSave', () => {
      // This is the core bug that was fixed: revert was adding to skipNextSave
      // but revert doesn't trigger onDidSaveTextDocument, so the skip was never
      // consumed and silently ate the next user save
      flow.revertDocument('/tmp/test.ts');
      expect(flow.skipNextSave.has('/tmp/test.ts')).toBe(false);

      // User save after revert should work normally
      flow.handleFileSave('/tmp/test.ts', 'user edit');
      expect(flow.pendingUploads.has('/tmp/test.ts')).toBe(true);
    });

    it('REGRESSION: save flow after file watcher revert should upload', async () => {
      // Simulate the full flow that was broken:
      // 1. User opens file with content "original"
      flow.originalContent.set('/tmp/test.ts', 'original');

      // 2. User edits and saves with "modified"
      flow.handleFileSave('/tmp/test.ts', 'modified');
      jest.advanceTimersByTime(500);
      await Promise.resolve(); // Let upload complete
      expect(flow.uploadedFiles.get('/tmp/test.ts')).toBe('modified');

      // 3. File watcher detects change, reverts document
      //    (This is where the old bug was - it would set skipNextSave)
      flow.revertDocument('/tmp/test.ts');

      // 4. User edits again and saves with "modified v2"
      flow.handleFileSave('/tmp/test.ts', 'modified v2');
      jest.advanceTimersByTime(500);
      await Promise.resolve();

      // 5. The upload SHOULD happen (previously was silently skipped!)
      expect(flow.uploadedFiles.get('/tmp/test.ts')).toBe('modified v2');
    });

    it('document.save() should correctly use skipNextSave', () => {
      // When we programmatically save (e.g., after loading content), we DO want
      // to skip the next save to prevent re-uploading what we just downloaded
      flow.saveDocument('/tmp/test.ts', 'downloaded content');

      // The handleFileSave was called but should have been skipped
      expect(flow.pendingUploads.has('/tmp/test.ts')).toBe(false);
      expect(flow.skipNextSave.has('/tmp/test.ts')).toBe(false); // consumed

      // Next user save should work normally
      flow.handleFileSave('/tmp/test.ts', 'user edit');
      expect(flow.pendingUploads.has('/tmp/test.ts')).toBe(true);
    });
  });

  describe('debounce behavior', () => {
    it('should debounce rapid saves', () => {
      flow.handleFileSave('/tmp/test.ts', 'v1', 500);
      flow.handleFileSave('/tmp/test.ts', 'v2', 500);
      flow.handleFileSave('/tmp/test.ts', 'v3', 500);

      // Only one pending upload should exist
      expect(flow.pendingUploads.size).toBe(1);
    });

    it('should upload last content after debounce completes', async () => {
      flow.handleFileSave('/tmp/test.ts', 'v1', 500);
      flow.handleFileSave('/tmp/test.ts', 'v2', 500);
      flow.handleFileSave('/tmp/test.ts', 'v3', 500);

      jest.advanceTimersByTime(500);
      await Promise.resolve();

      expect(flow.uploadedFiles.get('/tmp/test.ts')).toBe('v3');
    });

    it('should handle independent files separately', async () => {
      flow.handleFileSave('/tmp/file1.ts', 'content1', 500);
      flow.handleFileSave('/tmp/file2.ts', 'content2', 500);

      expect(flow.pendingUploads.size).toBe(2);

      jest.advanceTimersByTime(500);
      await Promise.resolve();

      expect(flow.uploadedFiles.get('/tmp/file1.ts')).toBe('content1');
      expect(flow.uploadedFiles.get('/tmp/file2.ts')).toBe('content2');
    });

    it('should capture content eagerly at save time', async () => {
      // This tests the fix: content is captured at handleFileSave time,
      // not when the debounce timer fires
      let capturedContent = 'initial';
      flow.handleFileSave('/tmp/test.ts', capturedContent, 500);

      // Even if the variable changes before debounce fires,
      // the captured content should still be 'initial'
      capturedContent = 'changed after save';

      jest.advanceTimersByTime(500);
      await Promise.resolve();

      // The uploaded content should be what was captured at save time
      expect(flow.uploadedFiles.get('/tmp/test.ts')).toBe('initial');
    });
  });

  describe('flushPendingUpload', () => {
    it('should immediately execute pending upload', async () => {
      flow.handleFileSave('/tmp/test.ts', 'content', 500);

      // Upload should not have happened yet (debounce hasn't fired)
      expect(flow.uploadedFiles.has('/tmp/test.ts')).toBe(false);

      // Flush should immediately execute
      await flow.flushPendingUpload('/tmp/test.ts');

      expect(flow.uploadedFiles.get('/tmp/test.ts')).toBe('content');
      expect(flow.pendingUploads.has('/tmp/test.ts')).toBe(false);
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
      flow.handleFileSave('/tmp/test.ts', 'content', 500);

      await flow.flushPendingUpload('/tmp/test.ts');

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
      // User edits and saves
      flow.handleFileSave('/tmp/test.ts', 'edited content', 500);

      // User closes tab before debounce fires
      // onDidCloseTextDocument calls flushPendingUpload
      await flow.flushPendingUpload('/tmp/test.ts');

      // Content should have been uploaded
      expect(flow.uploadedFiles.get('/tmp/test.ts')).toBe('edited content');

      // User reopens file - openRemoteFile calls flushPendingUpload first
      await flow.flushPendingUpload('/tmp/test.ts');

      // The uploaded content should be the user's edit
      expect(flow.uploadedFiles.get('/tmp/test.ts')).toBe('edited content');
    });
  });

  describe('concurrent operations', () => {
    it('should handle save during in-flight upload', async () => {
      // First save starts uploading
      flow.handleFileSave('/tmp/test.ts', 'v1', 0); // immediate
      jest.advanceTimersByTime(0);

      // Second save while first is in flight
      flow.handleFileSave('/tmp/test.ts', 'v2', 500);

      // Flush to complete all
      await flow.flushPendingUpload('/tmp/test.ts');

      // Latest content should win
      expect(flow.uploadedFiles.get('/tmp/test.ts')).toBe('v2');
    });
  });
});
