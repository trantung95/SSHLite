/**
 * FileService upload state tests - tests ACTUAL FileService public API
 *
 * Tests the real upload state tracking on the FileService singleton:
 * - isFileUploading() reflects actual internal uploadingFiles Set
 * - isFileUploadFailed() reflects actual internal failedUploadFiles Set
 * - Upload state transitions during handleFileSave flow
 * - Upload state cleared on new save attempt
 * - File-based upload state isolation (independent per file)
 *
 * Also tests the refresh-skip logic:
 * - Active downloads prevent refresh (activeDownloads Set)
 * - File loading state tracking (filesLoading Set)
 */

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

jest.mock('./AuditService', () => ({
  AuditService: { getInstance: jest.fn().mockReturnValue({ logAudit: jest.fn(), log: jest.fn(), logEdit: jest.fn() }) },
}));
jest.mock('./FolderHistoryService', () => ({
  FolderHistoryService: { getInstance: jest.fn().mockReturnValue({ recordVisit: jest.fn(), getFrequentPaths: jest.fn().mockReturnValue([]) }) },
}));
jest.mock('./ProgressiveDownloadManager', () => ({
  ProgressiveDownloadManager: { getInstance: jest.fn().mockReturnValue({ shouldUseProgressiveDownload: jest.fn().mockReturnValue(false), startProgressiveDownload: jest.fn(), isDownloading: jest.fn().mockReturnValue(false), getLocalPath: jest.fn().mockReturnValue(undefined) }) },
}));
jest.mock('./PriorityQueueService', () => ({
  PriorityQueueService: { getInstance: jest.fn().mockReturnValue({ enqueue: jest.fn(), getStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0, byPriority: {} }), cancelAll: jest.fn(), isProcessing: jest.fn().mockReturnValue(false), cancelConnection: jest.fn(), resetConnection: jest.fn(), isConnectionCancelled: jest.fn().mockReturnValue(false), getConnectionStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0 }) }) },
  PreloadPriority: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 },
}));
jest.mock('./ActivityService', () => ({
  ActivityService: { getInstance: jest.fn().mockReturnValue({ startActivity: jest.fn().mockReturnValue('act-1'), completeActivity: jest.fn(), failActivity: jest.fn() }) },
}));
jest.mock('./CommandGuard', () => ({
  CommandGuard: { getInstance: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(''), upload: jest.fn().mockResolvedValue(undefined), download: jest.fn().mockResolvedValue(Buffer.from('')) }) },
}));

import { FileService, FileMapping } from './FileService';

function resetFileService(): FileService {
  try { FileService.getInstance().dispose(); } catch { /* ignore */ }
  (FileService as any)._instance = undefined;
  return FileService.getInstance();
}

describe('FileService - Upload State Tracking (Actual)', () => {
  let service: FileService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    service = resetFileService();
  });

  afterEach(() => {
    jest.useRealTimers();
    try { service.dispose(); } catch { /* ignore */ }
  });

  function setMapping(local: string, remote: string, connId: string) {
    const mappings: Map<string, FileMapping> = (service as any).fileMappings;
    mappings.set(local, {
      connectionId: connId,
      remotePath: remote,
      localPath: local,
      lastSyncTime: Date.now(),
    });
  }

  function triggerSave(localPath: string, content: string) {
    (service as any).handleFileSave({
      uri: { fsPath: localPath, scheme: 'file' },
      getText: () => content,
      isUntitled: false,
      languageId: 'typescript',
    });
  }

  describe('upload state during save flow', () => {
    const localPath = '/tmp/ssh-lite/abc/[ssh] test.ts';

    it('should mark file as uploading after save', () => {
      setMapping(localPath, '/test.ts', 'test-host:22:testuser');
      expect(service.isFileUploading(localPath)).toBe(false);

      triggerSave(localPath, 'new content');
      expect(service.isFileUploading(localPath)).toBe(true);
    });

    it('should clear failure state on new save', () => {
      setMapping(localPath, '/test.ts', 'test-host:22:testuser');

      // Simulate a failed upload
      (service as any).failedUploadFiles.add(localPath);
      expect(service.isFileUploadFailed(localPath)).toBe(true);

      // New save should clear failure
      triggerSave(localPath, 'retry content');
      expect(service.isFileUploadFailed(localPath)).toBe(false);
      expect(service.isFileUploading(localPath)).toBe(true);
    });

    it('should not mark unmapped files as uploading', () => {
      triggerSave('/tmp/random-file.ts', 'content');
      expect(service.isFileUploading('/tmp/random-file.ts')).toBe(false);
    });
  });

  describe('upload state isolation between files', () => {
    const file1 = '/tmp/ssh-lite/abc/[ssh] file1.ts';
    const file2 = '/tmp/ssh-lite/abc/[ssh] file2.ts';

    it('should track upload state independently per file', () => {
      setMapping(file1, '/file1.ts', 'test-host:22:testuser');
      setMapping(file2, '/file2.ts', 'test-host:22:testuser');

      triggerSave(file1, 'content1');

      expect(service.isFileUploading(file1)).toBe(true);
      expect(service.isFileUploading(file2)).toBe(false);
    });

    it('should track failure independently per file', () => {
      (service as any).failedUploadFiles.add(file1);

      expect(service.isFileUploadFailed(file1)).toBe(true);
      expect(service.isFileUploadFailed(file2)).toBe(false);
    });
  });

  describe('refresh skip during download', () => {
    it('should track active downloads via activeDownloads map', () => {
      const localPath = '/tmp/ssh-lite/abc/[ssh] file.ts';
      const remotePath = '/remote/file.ts';

      // isFileDownloading checks activeDownloads map for matching remotePath
      const activeDownloads = (service as any).activeDownloads as Map<string, { connectionId: string; remotePath: string }>;
      activeDownloads.set(localPath, { connectionId: 'test-host:22:testuser', remotePath });

      expect(service.isFileDownloading(remotePath)).toBe(true);
      expect(service.isFileDownloading('/remote/other.ts')).toBe(false);
    });

    it('should return download info for active downloads via getActiveDownloadInfo', () => {
      const localPath = '/tmp/ssh-lite/abc/[ssh] config.yaml';
      const remotePath = '/etc/config.yaml';
      const connectionId = 'server:22:admin';

      const activeDownloads = (service as any).activeDownloads as Map<string, { connectionId: string; remotePath: string }>;
      activeDownloads.set(localPath, { connectionId, remotePath });

      const info = service.getActiveDownloadInfo(localPath);
      expect(info).toEqual({ connectionId, remotePath });
    });

    it('should return undefined from getActiveDownloadInfo for non-downloading paths', () => {
      expect(service.getActiveDownloadInfo('/tmp/ssh-lite/abc/[ssh] missing.ts')).toBeUndefined();
    });
  });

  describe('file loading state', () => {
    it('should track files being loaded', () => {
      const filesLoading = (service as any).filesLoading as Set<string>;

      expect(service.isFileLoading('/remote/file.ts')).toBe(false);

      filesLoading.add('/remote/file.ts');
      expect(service.isFileLoading('/remote/file.ts')).toBe(true);

      filesLoading.delete('/remote/file.ts');
      expect(service.isFileLoading('/remote/file.ts')).toBe(false);
    });
  });

  describe('upload state event emission', () => {
    it('should fire onUploadStateChanged when save triggers upload', () => {
      const localPath = '/tmp/ssh-lite/abc/[ssh] test.ts';
      setMapping(localPath, '/test.ts', 'test-host:22:testuser');

      let eventFired = false;
      service.onUploadStateChanged(() => { eventFired = true; });

      triggerSave(localPath, 'content');
      expect(eventFired).toBe(true);
    });
  });
});
