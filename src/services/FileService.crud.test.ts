/**
 * FileService CRUD tests - tests ACTUAL FileService methods
 *
 * Tests the real deleteRemote, createFolder, and related methods on the
 * actual FileService singleton with mocked SSH connections and VS Code APIs.
 *
 * This replaces the previous DeleteFlowSimulator/CreateFolderSimulator/
 * OpenFileSimulator approach which re-implemented logic locally.
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

const mockDeleteFile = jest.fn().mockResolvedValue(undefined);
const mockMkdir = jest.fn().mockResolvedValue(undefined);
const mockExec = jest.fn().mockResolvedValue('');
const mockWriteFile = jest.fn().mockResolvedValue(undefined);
const mockReadFile = jest.fn().mockResolvedValue(Buffer.from('file-content'));
const mockListFiles = jest.fn().mockResolvedValue([]);
const mockStat = jest.fn().mockResolvedValue({ size: 100, isDirectory: false, name: 'test', path: '/test', modifiedTime: Date.now(), connectionId: 'test' });

const mockConnection = {
  id: 'test-host:22:testuser',
  host: { name: 'Test Server', host: 'test-host', port: 22, username: 'testuser' },
  state: 'connected',
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  listFiles: mockListFiles,
  exec: mockExec,
  deleteFile: mockDeleteFile,
  mkdir: mockMkdir,
  stat: mockStat,
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

const mockLogAudit = jest.fn();
const mockAuditLog = jest.fn();
jest.mock('./AuditService', () => ({
  AuditService: { getInstance: jest.fn().mockReturnValue({ logAudit: mockLogAudit, log: mockAuditLog, logEdit: jest.fn() }) },
}));
jest.mock('./FolderHistoryService', () => ({
  FolderHistoryService: { getInstance: jest.fn().mockReturnValue({ recordVisit: jest.fn(), getFrequentPaths: jest.fn().mockReturnValue([]) }) },
}));
jest.mock('./ProgressiveDownloadManager', () => ({
  ProgressiveDownloadManager: { getInstance: jest.fn().mockReturnValue({ shouldUseProgressiveDownload: jest.fn().mockReturnValue(false), startProgressiveDownload: jest.fn(), isDownloading: jest.fn().mockReturnValue(false), getLocalPath: jest.fn().mockReturnValue(undefined) }) },
}));
jest.mock('./PriorityQueueService', () => ({
  PriorityQueueService: { getInstance: jest.fn().mockReturnValue({ enqueue: jest.fn(), getStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0, byPriority: {} }), cancelAll: jest.fn(), isProcessing: jest.fn().mockReturnValue(false) }) },
  PreloadPriority: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 },
}));
jest.mock('./ActivityService', () => ({
  ActivityService: { getInstance: jest.fn().mockReturnValue({ startActivity: jest.fn().mockReturnValue('act-1'), completeActivity: jest.fn(), failActivity: jest.fn() }) },
}));
jest.mock('./CommandGuard', () => ({
  CommandGuard: { getInstance: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(''), upload: jest.fn().mockResolvedValue(undefined), download: jest.fn().mockResolvedValue(Buffer.from('')) }) },
}));

import * as vscode from 'vscode';
import { FileService } from './FileService';
import { createMockRemoteFile } from '../__mocks__/testHelpers';
import { IRemoteFile } from '../types';

function resetFileService(): FileService {
  try { FileService.getInstance().dispose(); } catch { /* ignore */ }
  (FileService as any)._instance = undefined;
  return FileService.getInstance();
}

describe('FileService - CRUD Operations (Actual)', () => {
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

  describe('deleteRemote (actual method)', () => {
    it('should return false when user cancels dialog', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      const result = await service.deleteRemote(mockConnection as any, file);

      expect(result).toBe(false);
      expect(mockDeleteFile).not.toHaveBeenCalled();
    });

    it('should delete file when user confirms', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      const result = await service.deleteRemote(mockConnection as any, file);

      expect(result).toBe(true);
      expect(mockDeleteFile).toHaveBeenCalledWith('/home/user/test.ts');
    });

    it('should log audit on successful deletion', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      await service.deleteRemote(mockConnection as any, file);

      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'delete',
          remotePath: '/home/user/test.ts',
          success: true,
        })
      );
    });

    it('should handle delete failure gracefully', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));

      const file = createMockRemoteFile('test.ts', { path: '/protected/test.ts' });
      const result = await service.deleteRemote(mockConnection as any, file);

      // Should return false on failure
      expect(result).toBe(false);
    });

    it('should delete directory recursively', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
      // Mock exec for recursive directory deletion (rm -rf)
      mockExec.mockResolvedValue('');

      const dir = createMockRemoteFile('mydir', {
        path: '/home/user/mydir',
        isDirectory: true,
      });
      const result = await service.deleteRemote(mockConnection as any, dir);

      expect(result).toBe(true);
    });
  });

  describe('createFolder (actual method)', () => {
    it('should return undefined when user cancels input', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

      const result = await service.createFolder(mockConnection as any, '/home/user');

      expect(result).toBeUndefined();
      expect(mockMkdir).not.toHaveBeenCalled();
    });

    it('should create folder with provided name', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('projects');

      const result = await service.createFolder(mockConnection as any, '/home/user');

      expect(result).toBe('/home/user/projects');
      expect(mockMkdir).toHaveBeenCalledWith('/home/user/projects');
    });

    it('should log audit on successful creation', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('new-folder');

      await service.createFolder(mockConnection as any, '/home/user');

      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'mkdir',
          remotePath: '/home/user/new-folder',
          success: true,
        })
      );
    });

    it('should handle mkdir failure gracefully', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('protected-dir');
      mockMkdir.mockRejectedValueOnce(new Error('Permission denied'));

      const result = await service.createFolder(mockConnection as any, '/root');

      // Should return undefined on failure
      expect(result).toBeUndefined();
    });

    it('should pass validation function to showInputBox', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('valid-name');

      await service.createFolder(mockConnection as any, '/home/user');

      // Verify showInputBox was called with validation
      expect(vscode.window.showInputBox).toHaveBeenCalledWith(
        expect.objectContaining({
          validateInput: expect.any(Function),
        })
      );

      // Test the validation function
      const options = (vscode.window.showInputBox as jest.Mock).mock.calls[0][0];
      const validate = options.validateInput;

      // Valid names should return null/undefined
      expect(validate('my-folder')).toBeFalsy();

      // Invalid names should return error message
      expect(validate('')).toBeTruthy();
      expect(validate('my/folder')).toBeTruthy();
      expect(validate('my\\folder')).toBeTruthy();
    });
  });

  describe('registerExistingFile (actual method)', () => {
    const remoteFile = {
      name: 'test.ts',
      path: '/src/test.ts',
      isDirectory: false,
      size: 100,
      modifiedTime: Date.now(),
      connectionId: mockConnection.id,
    };

    it('should create mapping for existing temp file', async () => {
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

    it('should track lastSyncTime', async () => {
      const before = Date.now();
      await service.registerExistingFile(
        '/tmp/ssh-lite/abc/[SSH] test.ts',
        mockConnection as any,
        remoteFile
      );

      const mapping = service.getFileMapping('/tmp/ssh-lite/abc/[SSH] test.ts');
      expect(mapping!.lastSyncTime).toBeGreaterThanOrEqual(before);
    });
  });

  describe('getLocalFilePath (public method)', () => {
    it('should generate consistent local path for connection + remote path', () => {
      const path1 = service.getLocalFilePath('conn-1', '/src/test.ts');
      const path2 = service.getLocalFilePath('conn-1', '/src/test.ts');

      // Same inputs should produce same path
      expect(path1).toBe(path2);
    });

    it('should include ssh-lite prefix in path', () => {
      const localPath = service.getLocalFilePath('conn-1', '/src/test.ts');
      expect(localPath).toContain('ssh-lite');
    });

    it('should include [SSH] prefix in filename', () => {
      const localPath = service.getLocalFilePath('conn-1', '/src/test.ts');
      expect(localPath).toContain('[SSH]');
    });

    it('should produce different paths for different connections', () => {
      const path1 = service.getLocalFilePath('conn-1', '/src/test.ts');
      const path2 = service.getLocalFilePath('conn-2', '/src/test.ts');

      expect(path1).not.toBe(path2);
    });

    it('should produce different paths for different remote files', () => {
      const path1 = service.getLocalFilePath('conn-1', '/src/a.ts');
      const path2 = service.getLocalFilePath('conn-1', '/src/b.ts');

      expect(path1).not.toBe(path2);
    });
  });
});
