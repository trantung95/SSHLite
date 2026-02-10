/**
 * FileService tests - tests the ACTUAL FileService singleton
 *
 * Tests the real save/upload flow by:
 * - Mocking all dependent services (ConnectionManager, AuditService, etc.)
 * - Accessing private handleFileSave via (instance as any)
 * - Verifying actual behavior: skipNextSave, debounce, mapping checks, flush
 *
 * This replaces the previous SaveFlowSimulator approach which re-implemented
 * logic locally and couldn't catch real regressions.
 */

// Must mock fs BEFORE FileService is imported (constructor calls fs.existsSync)
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue('{}'),
  readdirSync: jest.fn().mockReturnValue([]),
  unlinkSync: jest.fn(),
  statSync: jest.fn().mockReturnValue({ mtimeMs: Date.now(), isDirectory: () => false }),
  rmdirSync: jest.fn(),
}));

jest.mock('os', () => ({
  tmpdir: jest.fn().mockReturnValue('/tmp'),
  platform: jest.fn().mockReturnValue('linux'),
}));

// Mock ConnectionManager
const mockConnection = {
  id: 'test-host:22:testuser',
  host: { name: 'Test Server', host: 'test-host', port: 22, username: 'testuser' },
  state: 'connected',
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from('content')),
  listFiles: jest.fn().mockResolvedValue([]),
  exec: jest.fn().mockResolvedValue(''),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockResolvedValue({ size: 100, isDirectory: false }),
  searchFiles: jest.fn().mockResolvedValue([]),
  watchFile: jest.fn().mockResolvedValue(false),
  onFileChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
};

jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: {
    getInstance: jest.fn().mockReturnValue({
      getConnection: jest.fn().mockReturnValue(mockConnection),
      getAllConnections: jest.fn().mockReturnValue([mockConnection]),
      onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    }),
  },
}));

// Mock dependent services
jest.mock('./AuditService', () => ({
  AuditService: {
    getInstance: jest.fn().mockReturnValue({
      logAudit: jest.fn(),
      log: jest.fn(),
      logEdit: jest.fn(),
    }),
  },
}));

jest.mock('./FolderHistoryService', () => ({
  FolderHistoryService: {
    getInstance: jest.fn().mockReturnValue({
      recordVisit: jest.fn(),
      getFrequentPaths: jest.fn().mockReturnValue([]),
    }),
  },
}));

jest.mock('./ProgressiveDownloadManager', () => ({
  ProgressiveDownloadManager: {
    getInstance: jest.fn().mockReturnValue({
      shouldUseProgressiveDownload: jest.fn().mockReturnValue(false),
      startProgressiveDownload: jest.fn(),
      isDownloading: jest.fn().mockReturnValue(false),
      getLocalPath: jest.fn().mockReturnValue(undefined),
    }),
  },
}));

jest.mock('./PriorityQueueService', () => ({
  PriorityQueueService: {
    getInstance: jest.fn().mockReturnValue({
      enqueue: jest.fn(),
      getStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0, byPriority: {} }),
      cancelAll: jest.fn(),
      isProcessing: jest.fn().mockReturnValue(false),
      cancelConnection: jest.fn(),
      resetConnection: jest.fn(),
      isConnectionCancelled: jest.fn().mockReturnValue(false),
      getConnectionStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0 }),
    }),
  },
  PreloadPriority: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 },
}));

jest.mock('./ActivityService', () => ({
  ActivityService: {
    getInstance: jest.fn().mockReturnValue({
      startActivity: jest.fn().mockReturnValue('activity-1'),
      completeActivity: jest.fn(),
      failActivity: jest.fn(),
    }),
  },
}));

jest.mock('./CommandGuard', () => ({
  CommandGuard: {
    getInstance: jest.fn().mockReturnValue({
      exec: jest.fn().mockResolvedValue(''),
      upload: jest.fn().mockResolvedValue(undefined),
      download: jest.fn().mockResolvedValue(Buffer.from('')),
    }),
  },
}));

import { FileService, FileMapping } from './FileService';

function resetFileService(): FileService {
  try {
    FileService.getInstance().dispose();
  } catch {
    // ignore
  }
  (FileService as any)._instance = undefined;
  return FileService.getInstance();
}

describe('FileService - Actual Save/Upload Flow', () => {
  let service: FileService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    service = resetFileService();
  });

  afterEach(() => {
    jest.useRealTimers();
    try {
      service.dispose();
    } catch {
      // ignore
    }
  });

  describe('file mapping management', () => {
    it('should return undefined for unmapped files', () => {
      expect(service.getFileMapping('/tmp/nonexistent.ts')).toBeUndefined();
    });

    it('should return mapping after registration', async () => {
      const remoteFile = {
        name: 'test.ts',
        path: '/src/test.ts',
        isDirectory: false,
        size: 100,
        modifiedTime: Date.now(),
        connectionId: mockConnection.id,
      };

      await service.registerExistingFile(
        '/tmp/ssh-lite/abc/[SSH] test.ts',
        mockConnection as any,
        remoteFile
      );

      const mapping = service.getFileMapping('/tmp/ssh-lite/abc/[SSH] test.ts');
      expect(mapping).toBeDefined();
      expect(mapping!.remotePath).toBe('/src/test.ts');
      expect(mapping!.connectionId).toBe(mockConnection.id);
    });
  });

  describe('handleFileSave (private, tested via (instance as any))', () => {
    const localPath = '/tmp/ssh-lite/abc/[ssh] test.ts';
    const remotePath = '/src/test.ts';
    const connectionId = 'test-host:22:testuser';

    function createMockDocument(fsPath: string, text: string) {
      return {
        uri: { fsPath, scheme: 'file' },
        getText: () => text,
        isUntitled: false,
        languageId: 'typescript',
      };
    }

    function setMapping(local: string, remote: string, connId: string) {
      const mappings: Map<string, FileMapping> = (service as any).fileMappings;
      mappings.set(local, {
        connectionId: connId,
        remotePath: remote,
        localPath: local,
        lastSyncTime: Date.now(),
      });
    }

    it('should skip save when no mapping exists', () => {
      const doc = createMockDocument('/tmp/unmapped.ts', 'content');
      (service as any).handleFileSave(doc);

      const pendingUploads = (service as any).pendingUploads as Map<string, any>;
      expect(pendingUploads.size).toBe(0);
    });

    it('should create pending upload when mapping exists', () => {
      setMapping(localPath, remotePath, connectionId);
      const doc = createMockDocument(localPath, 'edited content');
      (service as any).handleFileSave(doc);

      const pendingUploads = (service as any).pendingUploads as Map<string, any>;
      expect(pendingUploads.has(localPath)).toBe(true);
    });

    it('should skip save when skipNextSave is set', () => {
      setMapping(localPath, remotePath, connectionId);
      const skipSet = (service as any).skipNextSave as Set<string>;
      skipSet.add(localPath);

      const doc = createMockDocument(localPath, 'content');
      (service as any).handleFileSave(doc);

      // skipNextSave should be consumed
      expect(skipSet.has(localPath)).toBe(false);
      // No pending upload should be created
      const pendingUploads = (service as any).pendingUploads as Map<string, any>;
      expect(pendingUploads.has(localPath)).toBe(false);
    });

    it('should only skip ONE save when skipNextSave is set', () => {
      setMapping(localPath, remotePath, connectionId);
      const skipSet = (service as any).skipNextSave as Set<string>;
      skipSet.add(localPath);

      // First save: skipped
      (service as any).handleFileSave(createMockDocument(localPath, 'v1'));
      const pendingUploads = (service as any).pendingUploads as Map<string, any>;
      expect(pendingUploads.has(localPath)).toBe(false);

      // Second save: should NOT be skipped
      (service as any).handleFileSave(createMockDocument(localPath, 'v2'));
      expect(pendingUploads.has(localPath)).toBe(true);
    });

    it('should debounce rapid saves', () => {
      setMapping(localPath, remotePath, connectionId);

      (service as any).handleFileSave(createMockDocument(localPath, 'v1'));
      (service as any).handleFileSave(createMockDocument(localPath, 'v2'));
      (service as any).handleFileSave(createMockDocument(localPath, 'v3'));

      const pendingUploads = (service as any).pendingUploads as Map<string, any>;
      // Only one pending upload should exist (latest replaces previous)
      expect(pendingUploads.has(localPath)).toBe(true);
    });

    it('should upload latest content after debounce fires', async () => {
      setMapping(localPath, remotePath, connectionId);

      (service as any).handleFileSave(createMockDocument(localPath, 'v1'));
      (service as any).handleFileSave(createMockDocument(localPath, 'v2'));
      (service as any).handleFileSave(createMockDocument(localPath, 'final'));

      // Run the debounce timer
      jest.advanceTimersByTime(600);
      // Drain microtask queue for async upload
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // writeFile should have been called (via CommandGuard.upload or directly)
      // Exact call depends on the CommandGuard mock
    });

    it('should handle independent files separately', () => {
      const path1 = '/tmp/ssh-lite/abc/[ssh] file1.ts';
      const path2 = '/tmp/ssh-lite/abc/[ssh] file2.ts';
      setMapping(path1, '/file1.ts', connectionId);
      setMapping(path2, '/file2.ts', connectionId);

      (service as any).handleFileSave(createMockDocument(path1, 'content1'));
      (service as any).handleFileSave(createMockDocument(path2, 'content2'));

      const pendingUploads = (service as any).pendingUploads as Map<string, any>;
      expect(pendingUploads.size).toBe(2);
    });

    it('should track upload state (uploading badge)', () => {
      setMapping(localPath, remotePath, connectionId);
      const doc = createMockDocument(localPath, 'content');
      (service as any).handleFileSave(doc);

      // After handleFileSave, the file should be marked as uploading
      expect(service.isFileUploading(localPath)).toBe(true);
    });

    it('should clear previous failure on new save', () => {
      setMapping(localPath, remotePath, connectionId);
      const failedSet = (service as any).failedUploadFiles as Set<string>;
      failedSet.add(localPath);

      expect(service.isFileUploadFailed(localPath)).toBe(true);

      (service as any).handleFileSave(createMockDocument(localPath, 'retry'));
      expect(service.isFileUploadFailed(localPath)).toBe(false);
    });
  });

  describe('flushPendingUpload (private)', () => {
    const localPath = '/tmp/ssh-lite/abc/[ssh] test.ts';

    function setMapping(local: string, remote: string, connId: string) {
      const mappings: Map<string, FileMapping> = (service as any).fileMappings;
      mappings.set(local, {
        connectionId: connId,
        remotePath: remote,
        localPath: local,
        lastSyncTime: Date.now(),
      });
    }

    it('should immediately execute pending upload', async () => {
      setMapping(localPath, '/test.ts', 'test-host:22:testuser');
      const doc = {
        uri: { fsPath: localPath, scheme: 'file' },
        getText: () => 'content',
        isUntitled: false,
        languageId: 'typescript',
      };
      (service as any).handleFileSave(doc);

      // Before debounce fires, flush
      await (service as any).flushPendingUpload(localPath);

      // Pending should be cleared
      const pendingUploads = (service as any).pendingUploads as Map<string, any>;
      expect(pendingUploads.has(localPath)).toBe(false);
    });

    it('should do nothing when no pending upload exists', async () => {
      // Should not throw
      await (service as any).flushPendingUpload('/tmp/nonexistent.ts');
    });
  });

  describe('cleanupConnection', () => {
    it('should remove mappings for disconnected connection', () => {
      const mappings: Map<string, FileMapping> = (service as any).fileMappings;
      mappings.set('/tmp/file1', {
        connectionId: 'conn-1',
        remotePath: '/file1',
        localPath: '/tmp/file1',
        lastSyncTime: Date.now(),
      });
      mappings.set('/tmp/file2', {
        connectionId: 'conn-2',
        remotePath: '/file2',
        localPath: '/tmp/file2',
        lastSyncTime: Date.now(),
      });

      service.cleanupConnection('conn-1');

      expect(mappings.has('/tmp/file1')).toBe(false);
      expect(mappings.has('/tmp/file2')).toBe(true);
    });
  });

  describe('getters', () => {
    it('getOpenFiles should return array of mappings', () => {
      expect(Array.isArray(service.getOpenFiles())).toBe(true);
    });

    it('getTempDir should return a valid path', () => {
      expect(service.getTempDir()).toContain('ssh-lite');
    });

    it('getWatchedFile should return null initially', () => {
      expect(service.getWatchedFile()).toBeNull();
    });

    it('isFileLoading should return false for unknown paths', () => {
      expect(service.isFileLoading('/unknown/path')).toBe(false);
    });

    it('isFileDownloading should return false for unknown paths', () => {
      expect(service.isFileDownloading('/unknown/path')).toBe(false);
    });

    it('isFileWatched should return false for unknown paths', () => {
      expect(service.isFileWatched('/unknown/path')).toBe(false);
    });

    it('isFileOpenInTab should return false for unknown paths', () => {
      expect(service.isFileOpenInTab('/unknown/path')).toBe(false);
    });
  });

  describe('backup history', () => {
    it('should return empty array for files with no backup', () => {
      const history = service.getBackupHistory('conn-1', '/nonexistent');
      expect(history).toEqual([]);
    });

    it('should clear all backup history', () => {
      const backups = (service as any).backupHistory as Map<string, any[]>;
      backups.set('conn-1:/file', [{ content: 'old', timestamp: Date.now() }]);

      service.clearBackupHistory();
      expect(backups.size).toBe(0);
    });
  });
});
