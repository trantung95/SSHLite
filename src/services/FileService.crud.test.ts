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

var mockDeleteFile = jest.fn().mockResolvedValue(undefined);
var mockRename = jest.fn().mockResolvedValue(undefined);
var mockMkdir = jest.fn().mockResolvedValue(undefined);
var mockExec = jest.fn().mockResolvedValue('');
var mockWriteFile = jest.fn().mockResolvedValue(undefined);
var mockReadFile = jest.fn().mockResolvedValue(Buffer.from('file-content'));
var mockListFiles = jest.fn().mockResolvedValue([]);
var mockStat = jest.fn().mockResolvedValue({ size: 100, isDirectory: false, name: 'test', path: '/test', modifiedTime: Date.now(), connectionId: 'test' });

var mockFileExists = jest.fn().mockResolvedValue(false);

var mockConnection = {
  id: 'test-host:22:testuser',
  host: { name: 'Test Server', host: 'test-host', port: 22, username: 'testuser' },
  state: 'connected',
  capabilities: { type: 'ssh', supportsExec: true, supportsShell: true, supportsPortForward: true, supportsNativeWatch: true, supportsSearch: true, supportsServerBackup: true, supportsSudo: true },
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  listFiles: mockListFiles,
  exec: mockExec,
  deleteFile: mockDeleteFile,
  rename: mockRename,
  mkdir: mockMkdir,
  stat: mockStat,
  fileExists: mockFileExists,
  searchFiles: jest.fn().mockResolvedValue([]),
  watchFile: jest.fn().mockResolvedValue(false),
  onFileChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
};

jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: {
    getInstance: jest.fn().mockImplementation(() => ({
      getConnection: jest.fn().mockReturnValue(mockConnection),
      getAllConnections: jest.fn().mockReturnValue([mockConnection]),
      onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    })),
  },
}));

var mockLogAudit = jest.fn();
var mockAuditLog = jest.fn();
jest.mock('./AuditService', () => ({
  AuditService: { getInstance: jest.fn().mockImplementation(() => ({ get logAudit() { return mockLogAudit; }, get log() { return mockAuditLog; }, logEdit: jest.fn() })) },
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

import * as vscode from 'vscode';
import { FileService } from './FileService';
import { createMockRemoteFile } from '../__mocks__/testHelpers';
import { IRemoteFile } from '../types';
import { setTabPrefixMode } from '../utils/connectionPrefix';

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
    // These assertions expect the default [user@host]/[SSH] prefix, so pin the
    // mode explicitly (issue #8 made it configurable via setTabPrefixMode).
    beforeEach(() => setTabPrefixMode('userAndHost'));
    afterEach(() => setTabPrefixMode('userAndHost'));

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

    it('should produce different paths for same basename in different folders (issue #6)', () => {
      // Regression: /var/www/domainA/index.php and /var/www/domainB/index.php
      // used to collide on one temp file, so opening one showed the other's
      // content and saving could upload to the wrong remote file.
      const pathA = service.getLocalFilePath('conn-1', '/var/www/domainA/index.php');
      const pathB = service.getLocalFilePath('conn-1', '/var/www/domainB/index.php');

      expect(pathA).not.toBe(pathB);
    });

    it('should still produce the same path when the same remote file is reopened', () => {
      // Determinism is required for "already open" detection and reuse.
      const first = service.getLocalFilePath('conn-1', '/var/www/domainA/index.php');
      const second = service.getLocalFilePath('conn-1', '/var/www/domainA/index.php');

      expect(first).toBe(second);
    });

    it('should use [user@host] prefix when connectionId has host:port:user format', () => {
      const localPath = service.getLocalFilePath('10.0.1.5:22:admin', '/var/log/app.log');
      expect(localPath).toContain('[admin@10.0.1.5]');
    });

    it('should use [tabLabel] prefix when registered', () => {
      service.registerConnectionTabLabel('myhost:22:deploy', 'PRD');
      const localPath = service.getLocalFilePath('myhost:22:deploy', '/app/config.ts');
      expect(localPath).toContain('[PRD]');
      expect(localPath).not.toContain('[deploy@myhost]');
    });

    it('should fall back to [SSH] for non-standard connectionId format', () => {
      const localPath = service.getLocalFilePath('simple-id', '/src/test.ts');
      expect(localPath).toContain('[SSH]');
    });
  });

  describe('renameRemote (actual method)', () => {
    it('should return undefined when user cancels input', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      const result = await service.renameRemote(mockConnection as any, file);

      expect(result).toBeUndefined();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('should rename file and return new path', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('renamed.ts');

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      const result = await service.renameRemote(mockConnection as any, file);

      expect(result).toBe('/home/user/renamed.ts');
      expect(mockRename).toHaveBeenCalledWith('/home/user/test.ts', '/home/user/renamed.ts');
    });

    it('should log audit on successful rename', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('new-name.ts');

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      await service.renameRemote(mockConnection as any, file);

      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'rename',
          remotePath: '/home/user/test.ts',
          success: true,
        })
      );
    });

    it('should handle rename failure gracefully', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('taken-name.ts');
      mockRename.mockRejectedValueOnce(new Error('File already exists'));

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      const result = await service.renameRemote(mockConnection as any, file);

      expect(result).toBeUndefined();
      expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });

    it('should select name without extension for files', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('new.ts');

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      await service.renameRemote(mockConnection as any, file);

      const options = (vscode.window.showInputBox as jest.Mock).mock.calls[0][0];
      // "test" = 4 chars, dot at index 4
      expect(options.valueSelection).toEqual([0, 4]);
    });

    it('should select full name for folders', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('new-folder');

      const folder = createMockRemoteFile('my-folder', { path: '/home/user/my-folder', isDirectory: true });
      await service.renameRemote(mockConnection as any, folder);

      const options = (vscode.window.showInputBox as jest.Mock).mock.calls[0][0];
      expect(options.valueSelection).toEqual([0, 'my-folder'.length]);
    });

    it('should validate input rejects empty, slashes, and unchanged name', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('valid');

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      await service.renameRemote(mockConnection as any, file);

      const validate = (vscode.window.showInputBox as jest.Mock).mock.calls[0][0].validateInput;
      expect(validate('')).toBeTruthy();
      expect(validate('  ')).toBeTruthy();
      expect(validate('my/file')).toBeTruthy();
      expect(validate('my\\file')).toBeTruthy();
      expect(validate('test.ts')).toBeTruthy(); // unchanged
      expect(validate('new-name.ts')).toBeNull(); // valid
    });
  });

  describe('moveRemote (actual method)', () => {
    it('should return undefined when user cancels input', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      const result = await service.moveRemote(mockConnection as any, file);

      expect(result).toBeUndefined();
      expect(mockRename).not.toHaveBeenCalled();
    });

    it('should move file to new path', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('/var/www/test.ts');

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      const result = await service.moveRemote(mockConnection as any, file);

      expect(result).toBe('/var/www/test.ts');
      expect(mockRename).toHaveBeenCalledWith('/home/user/test.ts', '/var/www/test.ts');
    });

    it('should log audit with move action', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('/new/location/test.ts');

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      await service.moveRemote(mockConnection as any, file);

      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'move',
          remotePath: '/home/user/test.ts',
          success: true,
        })
      );
    });

    it('should handle move failure gracefully', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('/nonexistent/dir/test.ts');
      mockRename.mockRejectedValueOnce(new Error('No such directory'));

      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      const result = await service.moveRemote(mockConnection as any, file);

      expect(result).toBeUndefined();
      expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    });

    it('should validate input rejects relative paths, unchanged, and folder-into-self', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('/other/path');

      const dir = createMockRemoteFile('projects', { path: '/home/user/projects', isDirectory: true });
      await service.moveRemote(mockConnection as any, dir);

      const validate = (vscode.window.showInputBox as jest.Mock).mock.calls[0][0].validateInput;
      expect(validate('')).toBeTruthy();
      expect(validate('relative/path')).toBeTruthy(); // not absolute
      expect(validate('/home/user/projects')).toBeTruthy(); // unchanged
      expect(validate('/home/user/projects/subdir')).toBeTruthy(); // folder into itself
      expect(validate('/other/projects')).toBeNull(); // valid
    });
  });

  describe('createFile (actual method)', () => {
    beforeEach(() => {
      mockFileExists.mockResolvedValue(false);
      mockWriteFile.mockResolvedValue(undefined);
    });

    it('returns undefined when user cancels input; writeFile not called', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue(undefined);

      const result = await service.createFile(mockConnection as any, '/home/user');

      expect(result).toBeUndefined();
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it('creates an empty file at <parent>/<name> via writeFile(path, Buffer.alloc(0))', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('hello.txt');

      const result = await service.createFile(mockConnection as any, '/home/user');

      expect(result).toBe('/home/user/hello.txt');
      expect(mockWriteFile).toHaveBeenCalledWith('/home/user/hello.txt', expect.any(Buffer));
      const buf = mockWriteFile.mock.calls[0][1] as Buffer;
      expect(buf.length).toBe(0);
    });

    it("logs audit with action 'create' on success", async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('greeting.md');

      await service.createFile(mockConnection as any, '/home/user');

      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'create',
          remotePath: '/home/user/greeting.md',
          success: true,
        })
      );
    });

    it('returns undefined and shows error when fileExists returns true (collision)', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('dup.txt');
      mockFileExists.mockResolvedValueOnce(true);

      const result = await service.createFile(mockConnection as any, '/home/user');

      expect(result).toBeUndefined();
      expect(mockWriteFile).not.toHaveBeenCalled();
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('already exists')
      );
    });

    it('returns undefined when writeFile rejects with a non-permission error', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('protected.txt');
      mockWriteFile.mockRejectedValueOnce(new Error('Disk full'));

      const result = await service.createFile(mockConnection as any, '/var');

      expect(result).toBeUndefined();
    });

    it('rejects names that are empty or contain slashes via the showInputBox validator', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('valid-name');

      await service.createFile(mockConnection as any, '/home/user');

      const options = (vscode.window.showInputBox as jest.Mock).mock.calls[0][0];
      const validate = options.validateInput;

      expect(validate('')).toBeTruthy();
      expect(validate('   ')).toBeTruthy();
      expect(validate('a/b.txt')).toBeTruthy();
      expect(validate('a\\b.txt')).toBeTruthy();
      expect(validate('hello.txt')).toBeFalsy();
    });
  });

  describe('deleteRemote skipConfirm option', () => {
    beforeEach(() => {
      mockDeleteFile.mockResolvedValue(undefined);
      mockExec.mockResolvedValue('');
    });

    it('shows confirm dialog by default (no opts)', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      const file = createMockRemoteFile('a.txt', { path: '/home/user/a.txt', isDirectory: false });

      await service.deleteRemote(mockConnection as any, file);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('Delete "a.txt"?'),
        expect.objectContaining({ modal: true }),
        expect.any(String),
        expect.any(String)
      );
    });

    it('skips the confirm dialog when opts.skipConfirm is true', async () => {
      const file = createMockRemoteFile('b.txt', { path: '/home/user/b.txt', isDirectory: false });

      const result = await service.deleteRemote(mockConnection as any, file, { skipConfirm: true });

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(mockDeleteFile).toHaveBeenCalledWith('/home/user/b.txt');
      expect(result).toBe(true);
    });
  });

  describe('getRemoteProperties (actual method)', () => {
    it('formats stat output into a human-readable multi-line string', async () => {
      mockExec.mockResolvedValueOnce(
        "regular file|1234|-rw-r--r--|644|user|1000|user|1000|2026-05-19 14:30:21.000000000 +0700|2026-05-19 14:30:21.000000000 +0700|'hello.txt'\n"
      );
      const file = createMockRemoteFile('hello.txt', { path: '/home/user/hello.txt', isDirectory: false });

      const text = await service.getRemoteProperties(mockConnection as any, file);

      expect(text).toContain('Type:        regular file');
      expect(text).toContain('Size:        1234 bytes');
      expect(text).toContain('Permissions: -rw-r--r--  (644)');
      expect(text).toContain('Owner:       user (1000)');
      expect(text).toContain('Group:       user (1000)');
      expect(text).toContain("Name:        'hello.txt'");
    });

    it('throws when stat output is malformed', async () => {
      mockExec.mockResolvedValueOnce('not-the-right-shape\n');
      const file = createMockRemoteFile('weird', { path: '/tmp/weird', isDirectory: false });

      await expect(service.getRemoteProperties(mockConnection as any, file)).rejects.toThrow(
        /Unexpected stat output/
      );
    });

    it("shell-quotes paths that contain a literal single quote (passes 'it\\''s.txt' to exec)", async () => {
      mockExec.mockResolvedValueOnce(
        "regular file|0|-rw-r--r--|644|user|1000|user|1000|2026-05-19 00:00:00 +0000|2026-05-19 00:00:00 +0000|'/tmp/it'\\''s.txt'\n"
      );
      const file = createMockRemoteFile("it's.txt", { path: "/tmp/it's.txt", isDirectory: false });

      await service.getRemoteProperties(mockConnection as any, file);

      const execCmd = mockExec.mock.calls[mockExec.mock.calls.length - 1][0] as string;
      // The single quote in the path must be escaped as '\'' (close, escape, reopen).
      expect(execCmd).toContain("'/tmp/it'\\''s.txt'");
      // And the command never has an unbalanced bare-' that would break out of the quoting.
      // Sanity check: no raw "it's" sequence (where the quote breaks out).
      expect(execCmd).not.toMatch(/[^\\]it's/);
    });
  });

  describe('openRemoteFile - same remote file under a changed tab prefix (issue #8)', () => {
    const connId = mockConnection.id; // 'test-host:22:testuser'
    const remotePath = '/var/www/site/index.php';

    beforeEach(() => {
      setTabPrefixMode('userAndHost');
      (vscode.workspace as any).textDocuments = [];
    });
    afterEach(() => {
      setTabPrefixMode('userAndHost');
      (vscode.workspace as any).textDocuments = [];
    });

    it('findOpenLocalPathForRemote finds the open file no matter which local name it was opened under', () => {
      const oldLocalPath = service.getLocalFilePath(connId, remotePath);
      (service as any).fileMappings.set(oldLocalPath, { connectionId: connId, remotePath, localPath: oldLocalPath });
      (vscode.workspace as any).textDocuments = [{ uri: { fsPath: oldLocalPath, scheme: 'file' }, isUntitled: false }];

      expect((service as any).findOpenLocalPathForRemote(connId, remotePath)).toBe(oldLocalPath);
    });

    it('findOpenLocalPathForRemote returns undefined when the mapped file is not actually open', () => {
      const lp = service.getLocalFilePath(connId, remotePath);
      (service as any).fileMappings.set(lp, { connectionId: connId, remotePath, localPath: lp });
      (vscode.workspace as any).textDocuments = []; // closed

      expect((service as any).findOpenLocalPathForRemote(connId, remotePath)).toBeUndefined();
    });

    it('focuses the already-open tab instead of opening a duplicate when the prefix changed', async () => {
      // File was opened earlier under the default [user@host] prefix.
      const oldLocalPath = service.getLocalFilePath(connId, remotePath);
      (service as any).fileMappings.set(oldLocalPath, {
        connectionId: connId,
        remotePath,
        localPath: oldLocalPath,
        lastSyncTime: Date.now(),
      });
      (vscode.workspace as any).textDocuments = [
        { uri: { fsPath: oldLocalPath, scheme: 'file' }, isUntitled: false, getText: () => 'x' },
      ];

      // User switched the tab prefix to 'none' -> the same file now maps to a NEW name.
      setTabPrefixMode('none');
      const newLocalPath = service.getLocalFilePath(connId, remotePath);
      expect(newLocalPath).not.toBe(oldLocalPath); // sanity: the prefix really changed the filename

      const fs = require('fs');
      (fs.writeFileSync as jest.Mock).mockClear();
      mockReadFile.mockClear();
      (vscode.window.showTextDocument as jest.Mock).mockClear();

      const remoteFile = createMockRemoteFile('index.php', { path: remotePath, size: 100 });
      await service.openRemoteFile(mockConnection as any, remoteFile);

      // Focused the existing tab; did NOT create a second temp file or re-download,
      // and did NOT register a second mapping for the same remote file.
      expect(vscode.window.showTextDocument).toHaveBeenCalled();
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect((service as any).fileMappings.has(newLocalPath)).toBe(false);
    });
  });

  describe('openRemoteFile - preserveFocus when opened from the tree (issue #10)', () => {
    const connId = mockConnection.id;
    const remotePath = '/var/www/site/keepfocus.php';

    beforeEach(() => { setTabPrefixMode('userAndHost'); (vscode.workspace as any).textDocuments = []; });
    afterEach(() => { setTabPrefixMode('userAndHost'); (vscode.workspace as any).textDocuments = []; });

    // Seed an already-open tab under the OLD prefix so openRemoteFile takes the
    // focus-existing-tab early return — the simplest path to assert show options.
    function seedAlreadyOpenUnderOldPrefix(): void {
      const oldLocalPath = service.getLocalFilePath(connId, remotePath);
      (service as any).fileMappings.set(oldLocalPath, {
        connectionId: connId, remotePath, localPath: oldLocalPath, lastSyncTime: Date.now(),
      });
      (vscode.workspace as any).textDocuments = [
        { uri: { fsPath: oldLocalPath, scheme: 'file' }, isUntitled: false, getText: () => 'x' },
      ];
      setTabPrefixMode('none'); // recomputed name now differs -> focus-existing-tab path
    }

    function lastShowOptions(): any {
      const calls = (vscode.window.showTextDocument as jest.Mock).mock.calls;
      return calls[calls.length - 1][1];
    }

    it('passes preserveFocus:true through to showTextDocument when requested (tree click)', async () => {
      seedAlreadyOpenUnderOldPrefix();
      (vscode.window.showTextDocument as jest.Mock).mockClear();

      const remoteFile = createMockRemoteFile('keepfocus.php', { path: remotePath, size: 100 });
      await service.openRemoteFile(mockConnection as any, remoteFile, { preserveFocus: true });

      expect(vscode.window.showTextDocument).toHaveBeenCalled();
      expect(lastShowOptions()).toMatchObject({ preview: false, preserveFocus: true });
    });

    it('defaults to preserveFocus:false (editor takes focus) when no option is given', async () => {
      seedAlreadyOpenUnderOldPrefix();
      (vscode.window.showTextDocument as jest.Mock).mockClear();

      const remoteFile = createMockRemoteFile('keepfocus.php', { path: remotePath, size: 100 });
      await service.openRemoteFile(mockConnection as any, remoteFile);

      expect(lastShowOptions()).toMatchObject({ preview: false, preserveFocus: false });
    });
  });
});
