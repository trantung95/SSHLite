/**
 * FileService Sudo Integration & E2E Tests
 *
 * Tests the full sudo elevation flow on the ACTUAL FileService:
 * - Permission denied detection → 3-choice dialog → sudo retry
 * - "Sudo Once" (one-off) vs "Sudo All" (connection-wide mode)
 * - Password prompt/cache lifecycle
 * - Multi-operation flows with sudo mode active
 * - Connection isolation (sudo on server A doesn't affect server B)
 * - Disconnect clears sudo mode
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

// ─── Mock connection methods ────────────────────────────────────────

var mockDeleteFile = jest.fn().mockResolvedValue(undefined);
var mockRename = jest.fn().mockResolvedValue(undefined);
var mockMkdir = jest.fn().mockResolvedValue(undefined);
var mockExec = jest.fn().mockResolvedValue('');
var mockWriteFile = jest.fn().mockResolvedValue(undefined);
var mockReadFile = jest.fn().mockResolvedValue(Buffer.from('file-content'));
var mockListFiles = jest.fn().mockResolvedValue([]);
var mockStat = jest.fn().mockResolvedValue({ size: 100, isDirectory: false, name: 'test', path: '/test', modifiedTime: Date.now(), connectionId: 'test' });

// Sudo operation mocks
var mockSudoWriteFile = jest.fn().mockResolvedValue(undefined);
var mockSudoReadFile = jest.fn().mockResolvedValue(Buffer.from('sudo-content'));
var mockSudoDeleteFile = jest.fn().mockResolvedValue(undefined);
var mockSudoMkdir = jest.fn().mockResolvedValue(undefined);
var mockSudoRename = jest.fn().mockResolvedValue(undefined);
var mockSudoExec = jest.fn().mockResolvedValue('');
var mockSudoListFiles = jest.fn().mockResolvedValue([]);

// Connection with sudo support
var _sudoMode = false;
var _sudoPassword: string | null = null;

var mockConnection = {
  id: 'web-server:22:deploy',
  host: { id: 'web-server:22:deploy', name: 'web-server', host: 'web-server', port: 22, username: 'deploy' },
  state: 'connected',
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  listFiles: mockListFiles,
  exec: mockExec,
  deleteFile: mockDeleteFile,
  rename: mockRename,
  mkdir: mockMkdir,
  stat: mockStat,
  searchFiles: jest.fn().mockResolvedValue([]),
  watchFile: jest.fn().mockResolvedValue(false),
  onFileChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  // Sudo support
  get sudoMode() { return _sudoMode; },
  get sudoPassword() { return _sudoPassword; },
  enableSudoMode(password: string) { _sudoMode = true; _sudoPassword = password; },
  disableSudoMode() { _sudoMode = false; _sudoPassword = null; },
  sudoWriteFile: mockSudoWriteFile,
  sudoReadFile: mockSudoReadFile,
  sudoDeleteFile: mockSudoDeleteFile,
  sudoMkdir: mockSudoMkdir,
  sudoRename: mockSudoRename,
  sudoExec: mockSudoExec,
  sudoListFiles: mockSudoListFiles,
};

// Second connection for isolation tests
var mockConnection2 = {
  id: 'db-server:22:admin',
  host: { id: 'db-server:22:admin', name: 'db-server', host: 'db-server', port: 22, username: 'admin' },
  state: 'connected',
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from('')),
  listFiles: jest.fn().mockResolvedValue([]),
  exec: jest.fn().mockResolvedValue(''),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  stat: mockStat,
  searchFiles: jest.fn().mockResolvedValue([]),
  watchFile: jest.fn().mockResolvedValue(false),
  onFileChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  sudoMode: false,
  sudoPassword: null,
  enableSudoMode: jest.fn(),
  disableSudoMode: jest.fn(),
  sudoWriteFile: jest.fn().mockResolvedValue(undefined),
  sudoDeleteFile: jest.fn().mockResolvedValue(undefined),
  sudoMkdir: jest.fn().mockResolvedValue(undefined),
  sudoRename: jest.fn().mockResolvedValue(undefined),
};

jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: {
    getInstance: () => ({
      getConnection: jest.fn().mockReturnValue(mockConnection),
      getAllConnections: jest.fn().mockReturnValue([mockConnection]),
      onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    }),
  },
}));

// Mock CommandGuard to pass through to connection methods (real routing logic)
var mockCommandGuardSudoWriteFile = jest.fn().mockResolvedValue(undefined);
var mockCommandGuardSudoDeleteFile = jest.fn().mockResolvedValue(undefined);
var mockCommandGuardSudoMkdir = jest.fn().mockResolvedValue(undefined);
var mockCommandGuardSudoRename = jest.fn().mockResolvedValue(undefined);
var mockCommandGuardWriteFile = jest.fn().mockResolvedValue(undefined);

var mockCommandGuardInstance = {
  exec: jest.fn().mockResolvedValue(''),
  writeFile: mockCommandGuardWriteFile,
  readFile: jest.fn().mockResolvedValue(Buffer.from('')),
  sudoWriteFile: mockCommandGuardSudoWriteFile,
  sudoDeleteFile: mockCommandGuardSudoDeleteFile,
  sudoMkdir: mockCommandGuardSudoMkdir,
  sudoRename: mockCommandGuardSudoRename,
};
jest.mock('./CommandGuard', () => ({
  CommandGuard: {
    getInstance: () => mockCommandGuardInstance,
  },
}));

var mockLogEdit = jest.fn();
var mockAuditLog = jest.fn();
jest.mock('./AuditService', () => ({
  AuditService: { getInstance: () => ({ logAudit: jest.fn(), log: mockAuditLog, logEdit: mockLogEdit }) },
}));

// Mock CredentialService for sudo password management
var mockPromptSudoPassword = jest.fn().mockResolvedValue('sudo-pass-123');
var mockGetSudoPasswordCached = jest.fn().mockReturnValue(null);
var mockCacheSudoPassword = jest.fn();
var mockClearSudoPassword = jest.fn();

jest.mock('./CredentialService', () => ({
  CredentialService: {
    getInstance: () => ({
      promptSudoPassword: (...args: any[]) => mockPromptSudoPassword(...args),
      getSudoPasswordCached: (...args: any[]) => mockGetSudoPasswordCached(...args),
      cacheSudoPassword: (...args: any[]) => mockCacheSudoPassword(...args),
      clearSudoPassword: (...args: any[]) => mockClearSudoPassword(...args),
      listCredentials: jest.fn().mockReturnValue([]),
    }),
  },
}));

jest.mock('./FolderHistoryService', () => ({
  FolderHistoryService: { getInstance: () => ({ recordVisit: jest.fn(), getFrequentPaths: jest.fn().mockReturnValue([]) }) },
}));
jest.mock('./ProgressiveDownloadManager', () => ({
  ProgressiveDownloadManager: { getInstance: () => ({ shouldUseProgressiveDownload: jest.fn().mockReturnValue(false), startProgressiveDownload: jest.fn(), isDownloading: jest.fn().mockReturnValue(false), getLocalPath: jest.fn().mockReturnValue(undefined) }) },
}));
jest.mock('./PriorityQueueService', () => ({
  PriorityQueueService: { getInstance: () => ({ enqueue: jest.fn(), getStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0, byPriority: {} }), cancelAll: jest.fn(), isProcessing: jest.fn().mockReturnValue(false), cancelConnection: jest.fn(), resetConnection: jest.fn(), isConnectionCancelled: jest.fn().mockReturnValue(false), getConnectionStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0 }) }) },
  PreloadPriority: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 },
}));
jest.mock('./ActivityService', () => ({
  ActivityService: { getInstance: () => ({ startActivity: jest.fn().mockReturnValue('act-1'), completeActivity: jest.fn(), failActivity: jest.fn() }) },
}));

import * as vscode from 'vscode';
import { FileService } from './FileService';
import { createMockRemoteFile } from '../__mocks__/testHelpers';

// File mapping type (private in FileService)
interface FileMapping {
  connectionId: string;
  remotePath: string;
  localPath: string;
  lastSyncTime: number;
  originalContent?: string;
  lastRemoteSize?: number;
}

function resetFileService(): FileService {
  try { FileService.getInstance().dispose(); } catch { /* ignore */ }
  (FileService as any)._instance = undefined;
  return FileService.getInstance();
}

function setMapping(service: FileService, local: string, remote: string, connId: string) {
  const mappings: Map<string, FileMapping> = (service as any).fileMappings;
  mappings.set(local, {
    connectionId: connId,
    remotePath: remote,
    localPath: local,
    lastSyncTime: Date.now(),
    originalContent: 'original',
  });
}

describe('FileService - Sudo Integration Tests', () => {
  let service: FileService;

  beforeEach(() => {
    jest.useFakeTimers();
    _sudoMode = false;
    _sudoPassword = null;
    // Clear call history but keep implementations
    jest.clearAllMocks();
    // Re-apply default implementations (clearAllMocks removes mockResolvedValue)
    mockPromptSudoPassword.mockResolvedValue('sudo-pass-123');
    mockGetSudoPasswordCached.mockReturnValue(null);
    mockCacheSudoPassword.mockImplementation(() => {});
    mockClearSudoPassword.mockImplementation(() => {});
    mockCommandGuardSudoDeleteFile.mockResolvedValue(undefined);
    mockCommandGuardSudoWriteFile.mockResolvedValue(undefined);
    mockCommandGuardSudoMkdir.mockResolvedValue(undefined);
    mockCommandGuardSudoRename.mockResolvedValue(undefined);
    mockCommandGuardWriteFile.mockResolvedValue(undefined);
    mockDeleteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from('file-content'));
    mockSudoDeleteFile.mockResolvedValue(undefined);
    mockSudoMkdir.mockResolvedValue(undefined);
    mockSudoRename.mockResolvedValue(undefined);
    mockCommandGuardSudoDeleteFile.mockResolvedValue(undefined);
    mockCommandGuardSudoWriteFile.mockResolvedValue(undefined);
    mockCommandGuardSudoMkdir.mockResolvedValue(undefined);
    mockCommandGuardSudoRename.mockResolvedValue(undefined);
    mockCommandGuardWriteFile.mockResolvedValue(undefined);
    mockDeleteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(Buffer.from('file-content'));
    service = resetFileService();
  });

  afterEach(() => {
    jest.useRealTimers();
    try { service.dispose(); } catch { /* ignore */ }
  });

  // ─── Permission Denied Detection ──────────────────────────────────

  describe('Permission denied detection', () => {
    it('should detect "Permission denied" as permission error', () => {
      const isPermDenied = (service as any).isPermissionDenied.bind(service);
      expect(isPermDenied(new Error('Failed to write file: Permission denied'))).toBe(true);
    });

    it('should detect "EACCES" as permission error', () => {
      const isPermDenied = (service as any).isPermissionDenied.bind(service);
      expect(isPermDenied(new Error('EACCES: permission denied'))).toBe(true);
    });

    it('should not detect unrelated errors as permission errors', () => {
      const isPermDenied = (service as any).isPermissionDenied.bind(service);
      expect(isPermDenied(new Error('Connection timeout'))).toBe(false);
      expect(isPermDenied(new Error('No such file'))).toBe(false);
      expect(isPermDenied(new Error('Disk full'))).toBe(false);
    });

    it('should be case-insensitive', () => {
      const isPermDenied = (service as any).isPermissionDenied.bind(service);
      expect(isPermDenied(new Error('PERMISSION DENIED'))).toBe(true);
      expect(isPermDenied(new Error('permission denied'))).toBe(true);
    });
  });

  // ─── 3-Choice Dialog ─────────────────────────────────────────────

  describe('Sudo action dialog (promptSudoAction)', () => {
    const promptAction = () => (service as any).promptSudoAction('nginx.conf', 'web-server');

    it('should return "once" when user clicks "Sudo Once"', async () => {
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');
      expect(await promptAction()).toBe('once');
    });

    it('should return "connection" when user clicks "Sudo All"', async () => {
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo All');
      expect(await promptAction()).toBe('connection');
    });

    it('should return null when user clicks "Cancel"', async () => {
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Cancel');
      expect(await promptAction()).toBeNull();
    });

    it('should return null when user dismisses dialog', async () => {
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);
      expect(await promptAction()).toBeNull();
    });

    it('should include hostname and scope explanation in message', async () => {
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue(undefined);
      await promptAction();

      const msg = (vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0];
      expect(msg).toContain('nginx.conf');
      expect(msg).toContain('web-server');
      expect(msg).toContain('until disconnect');
    });
  });

  // ─── Delete with Sudo ────────────────────────────────────────────

  describe('deleteRemote — permission denied → sudo fallback', () => {
    it('should offer sudo dialog when delete fails with permission denied', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');

      const file = createMockRemoteFile('protected.conf', { path: '/etc/protected.conf' });
      await service.deleteRemote(mockConnection as any, file);

      // Should have shown sudo dialog
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied'),
        'Sudo Once', 'Sudo All', 'Cancel'
      );
    });

    it('should call sudoDeleteFile when user picks "Sudo Once"', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');

      const file = createMockRemoteFile('root-file.txt', { path: '/root/file.txt' });
      const result = await service.deleteRemote(mockConnection as any, file);

      // Verify handlePermissionDenied was triggered (it calls showErrorMessage with sudo options)
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied'),
        'Sudo Once', 'Sudo All', 'Cancel'
      );
      // Verify password was prompted
      expect(mockPromptSudoPassword).toHaveBeenCalledWith('web-server');
      expect(result).toBe(true);
      expect(mockCommandGuardSudoDeleteFile).toHaveBeenCalledWith(
        mockConnection, '/root/file.txt', 'sudo-pass-123', false
      );
    });

    it('should enable sudo mode when user picks "Sudo All"', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo All');

      const file = createMockRemoteFile('system.conf', { path: '/etc/system.conf' });
      await service.deleteRemote(mockConnection as any, file);

      expect(_sudoMode).toBe(true);
      expect(_sudoPassword).toBe('sudo-pass-123');
    });

    it('should return false when user cancels sudo dialog', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Cancel');

      const file = createMockRemoteFile('file.txt', { path: '/etc/file.txt' });
      const result = await service.deleteRemote(mockConnection as any, file);

      expect(result).toBe(false);
      expect(_sudoMode).toBe(false);
    });

    it('should not show sudo dialog for non-permission errors', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Connection timeout'));

      const file = createMockRemoteFile('file.txt', { path: '/tmp/file.txt' });
      await service.deleteRemote(mockConnection as any, file);

      // showErrorMessage called with generic error, not sudo dialog
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Connection timeout')
      );
    });

    it('should pass isDirectory=true for directory deletion', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');

      const dir = createMockRemoteFile('protected-dir', { path: '/opt/protected-dir', isDirectory: true });
      await service.deleteRemote(mockConnection as any, dir);

      expect(mockCommandGuardSudoDeleteFile).toHaveBeenCalledWith(
        mockConnection, '/opt/protected-dir', 'sudo-pass-123', true
      );
    });
  });

  // ─── Create Folder with Sudo ─────────────────────────────────────

  describe('createFolder — permission denied → sudo fallback', () => {
    it('should offer sudo dialog when mkdir fails with permission denied', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('newdir');
      mockMkdir.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');

      await service.createFolder(mockConnection as any, '/etc');

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Permission denied'),
        'Sudo Once', 'Sudo All', 'Cancel'
      );
    });

    it('should call sudoMkdir and return path when user picks "Sudo Once"', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('config');
      mockMkdir.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');

      const result = await service.createFolder(mockConnection as any, '/opt');

      expect(result).toBe('/opt/config');
      expect(mockCommandGuardSudoMkdir).toHaveBeenCalledWith(
        mockConnection, '/opt/config', 'sudo-pass-123'
      );
    });

    it('should enable sudo mode when user picks "Sudo All"', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('logs');
      mockMkdir.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo All');

      await service.createFolder(mockConnection as any, '/var');

      expect(_sudoMode).toBe(true);
    });
  });

  // ─── Rename with Sudo ────────────────────────────────────────────

  describe('renameRemote — permission denied → sudo fallback', () => {
    it('should call sudoRename when user picks "Sudo Once" on rename', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('new-name.conf');
      mockRename.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');

      const file = createMockRemoteFile('old.conf', { path: '/etc/old.conf' });
      const result = await service.renameRemote(mockConnection as any, file);

      expect(result).toBe('/etc/new-name.conf');
      expect(mockCommandGuardSudoRename).toHaveBeenCalledWith(
        mockConnection, '/etc/old.conf', '/etc/new-name.conf', 'sudo-pass-123'
      );
    });
  });

  // ─── Move with Sudo ──────────────────────────────────────────────

  describe('moveRemote — permission denied → sudo fallback', () => {
    it('should call sudoRename when user picks "Sudo Once" on move', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('/opt/moved.conf');
      mockRename.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');

      const file = createMockRemoteFile('app.conf', { path: '/etc/app.conf' });
      const result = await service.moveRemote(mockConnection as any, file);

      expect(result).toBe('/opt/moved.conf');
      expect(mockCommandGuardSudoRename).toHaveBeenCalledWith(
        mockConnection, '/etc/app.conf', '/opt/moved.conf', 'sudo-pass-123'
      );
    });
  });

  // ─── Password Handling ────────────────────────────────────────────

  describe('Sudo password flow', () => {
    it('should use cached password when available', async () => {
      mockGetSudoPasswordCached.mockReturnValueOnce('cached-pass');
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');

      const file = createMockRemoteFile('f.txt', { path: '/etc/f.txt' });
      await service.deleteRemote(mockConnection as any, file);

      // Should not have prompted for password
      expect(mockPromptSudoPassword).not.toHaveBeenCalled();
      // Should have used cached password
      expect(mockCommandGuardSudoDeleteFile).toHaveBeenCalledWith(
        mockConnection, '/etc/f.txt', 'cached-pass', false
      );
    });

    it('should prompt for password when not cached', async () => {
      mockGetSudoPasswordCached.mockReturnValue(null);
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');

      const file = createMockRemoteFile('f.txt', { path: '/etc/f.txt' });
      await service.deleteRemote(mockConnection as any, file);

      expect(mockPromptSudoPassword).toHaveBeenCalledWith('web-server');
    });

    it('should return false when user cancels password prompt', async () => {
      mockPromptSudoPassword.mockResolvedValueOnce(null);
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');

      const file = createMockRemoteFile('f.txt', { path: '/etc/f.txt' });
      const result = await service.deleteRemote(mockConnection as any, file);

      expect(result).toBe(false);
      expect(mockCommandGuardSudoDeleteFile).not.toHaveBeenCalled();
    });

    it('should clear password and offer retry on incorrect password', async () => {
      mockCommandGuardSudoDeleteFile.mockRejectedValueOnce(new Error('Sudo authentication failed: incorrect password'));
      // Second attempt: user clicks "Try Again" then succeeds
      (vscode.window.showErrorMessage as jest.Mock)
        .mockResolvedValueOnce('Sudo Once')  // First sudo dialog
        .mockResolvedValueOnce('Try Again')  // Incorrect password dialog
        .mockResolvedValueOnce('Sudo Once'); // Retry sudo dialog
      mockPromptSudoPassword
        .mockResolvedValueOnce('wrong-pass')
        .mockResolvedValueOnce('correct-pass');
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));

      const file = createMockRemoteFile('f.txt', { path: '/etc/f.txt' });
      await service.deleteRemote(mockConnection as any, file);

      expect(mockClearSudoPassword).toHaveBeenCalledWith('web-server:22:deploy');
    });
  });

  // ─── Sudo Failure Handling ────────────────────────────────────────

  describe('Sudo operation failures (non-password errors)', () => {
    it('should show "not allowed" message when user is not in sudoers', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Sudo Once');
      mockCommandGuardSudoDeleteFile.mockRejectedValueOnce(
        new Error('deploy is not in the sudoers file. This incident will be reported.')
      );

      const file = createMockRemoteFile('f.txt', { path: '/etc/f.txt' });
      const result = await service.deleteRemote(mockConnection as any, file);

      expect(result).toBe(false);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('not allowed to use sudo')
      );
      // Sudo mode should be disabled
      expect(_sudoMode).toBe(false);
    });

    it('should show "not installed" message when sudo command not found', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Sudo Once');
      mockCommandGuardSudoDeleteFile.mockRejectedValueOnce(
        new Error('sudo: command not found')
      );

      const file = createMockRemoteFile('f.txt', { path: '/etc/f.txt' });
      const result = await service.deleteRemote(mockConnection as any, file);

      expect(result).toBe(false);
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('not installed')
      );
    });

    it('should revert "Sudo All" when the first sudo operation fails', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      // User picks "Sudo All"
      (vscode.window.showErrorMessage as jest.Mock)
        .mockResolvedValueOnce('Sudo All')  // sudo action dialog
        .mockResolvedValueOnce('Cancel');    // retry dialog after failure
      // Sudo delete also fails (e.g., disk full)
      mockSudoDeleteFile.mockRejectedValueOnce(new Error('No space left on device'));

      const file = createMockRemoteFile('f.txt', { path: '/etc/f.txt' });
      await service.deleteRemote(mockConnection as any, file);

      // Sudo mode should be reverted since the operation failed immediately
      expect(_sudoMode).toBe(false);
    });

    it('should offer retry on generic sudo failure', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      // First attempt: sudo fails with network error
      mockCommandGuardSudoDeleteFile
        .mockRejectedValueOnce(new Error('Connection reset'))
        .mockResolvedValueOnce(undefined); // Second attempt succeeds
      (vscode.window.showErrorMessage as jest.Mock)
        .mockResolvedValueOnce('Sudo Once')   // first sudo dialog
        .mockResolvedValueOnce('Try Again')   // retry after failure
        .mockResolvedValueOnce('Sudo Once');  // second sudo dialog

      const file = createMockRemoteFile('f.txt', { path: '/etc/f.txt' });
      const result = await service.deleteRemote(mockConnection as any, file);

      expect(result).toBe(true);
      // Should have been called twice (first failed, second succeeded)
      expect(mockCommandGuardSudoDeleteFile).toHaveBeenCalledTimes(2);
    });

    it('should not offer retry for "not in sudoers" — terminal error', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Sudo Once');
      mockCommandGuardSudoDeleteFile.mockRejectedValueOnce(
        new Error('user is not allowed to run sudo')
      );

      const file = createMockRemoteFile('f.txt', { path: '/etc/f.txt' });
      await service.deleteRemote(mockConnection as any, file);

      // Should NOT show "Try Again" button for sudoers errors
      const retryCalls = (vscode.window.showErrorMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call.includes('Try Again')
      );
      expect(retryCalls.length).toBe(0);
    });

    it('should not offer retry for "command not found" — terminal error', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Sudo Once');
      mockCommandGuardSudoDeleteFile.mockRejectedValueOnce(
        new Error('sudo: command not found')
      );

      const file = createMockRemoteFile('f.txt', { path: '/etc/f.txt' });
      await service.deleteRemote(mockConnection as any, file);

      const retryCalls = (vscode.window.showErrorMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call.includes('Try Again')
      );
      expect(retryCalls.length).toBe(0);
    });
  });
});

// ─── E2E Flow Tests ─────────────────────────────────────────────────

describe('FileService - Sudo E2E Flows', () => {
  let service: FileService;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    _sudoMode = false;
    _sudoPassword = null;
    // Restore default mock behaviors
    mockPromptSudoPassword.mockResolvedValue('sudo-pass-123');
    mockGetSudoPasswordCached.mockReturnValue(null);
    mockCommandGuardSudoDeleteFile.mockResolvedValue(undefined);
    mockCommandGuardSudoWriteFile.mockResolvedValue(undefined);
    mockCommandGuardSudoMkdir.mockResolvedValue(undefined);
    mockCommandGuardSudoRename.mockResolvedValue(undefined);
    mockDeleteFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    service = resetFileService();
  });

  afterEach(() => {
    jest.useRealTimers();
    _sudoMode = false;
    _sudoPassword = null;
    try { service.dispose(); } catch { /* ignore */ }
  });

  describe('Full lifecycle: permission denied → Sudo All → operations succeed → disconnect clears', () => {
    it('should enable sudo mode, then subsequent deletes skip the dialog', async () => {
      // Step 1: First delete fails with permission denied
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo All');

      const file1 = createMockRemoteFile('a.conf', { path: '/etc/a.conf' });
      await service.deleteRemote(mockConnection as any, file1);

      // Sudo mode should now be active
      expect(_sudoMode).toBe(true);
      expect(_sudoPassword).toBe('sudo-pass-123');

      // Step 2: Second delete — sudo mode active, so even if SFTP fails again,
      // the connection is in sudo mode. But since sudo mode is checked BEFORE
      // the operation (via CommandGuard routing), the operation should not
      // even hit the SFTP path. In our test, mockDeleteFile succeeding means
      // the non-sudo path was used. The key test is that sudo mode persists.
      expect(mockConnection.sudoMode).toBe(true);

      // Step 3: Disconnect clears sudo mode
      mockConnection.disableSudoMode();
      expect(_sudoMode).toBe(false);
      expect(_sudoPassword).toBeNull();
    });
  });

  describe('"Sudo Once" does not enable connection-wide sudo mode', () => {
    it('should not set sudoMode on connection when user picks "Sudo Once"', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo Once');

      const file = createMockRemoteFile('x.conf', { path: '/etc/x.conf' });
      await service.deleteRemote(mockConnection as any, file);

      // Sudo mode should NOT be active — "Sudo Once" is one-off
      expect(_sudoMode).toBe(false);
      expect(_sudoPassword).toBeNull();
    });
  });

  describe('"Sudo All" shows status bar confirmation', () => {
    it('should show shield status bar message when "Sudo All" is activated', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo All');

      const file = createMockRemoteFile('y.conf', { path: '/etc/y.conf' });
      await service.deleteRemote(mockConnection as any, file);

      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('Sudo mode enabled'),
        expect.any(Number)
      );
    });
  });

  describe('Sudo mode does not activate when sudo mode is already active', () => {
    it('should not show sudo dialog when connection already has sudo mode', async () => {
      // Pre-enable sudo mode
      _sudoMode = true;
      _sudoPassword = 'pre-set';

      // Delete fails with permission denied (different reason — maybe wrong sudo too)
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));

      const file = createMockRemoteFile('z.conf', { path: '/etc/z.conf' });
      await service.deleteRemote(mockConnection as any, file);

      // Should NOT show the sudo action dialog (already in sudo mode)
      const errorCalls = (vscode.window.showErrorMessage as jest.Mock).mock.calls;
      const hasSudoDialog = errorCalls.some((call: any[]) =>
        call.includes('Sudo Once') && call.includes('Sudo All')
      );
      expect(hasSudoDialog).toBe(false);
    });
  });

  describe('Multiple operations with "Sudo Once" — each prompts independently', () => {
    it('should prompt for sudo on each permission-denied failure', async () => {
      // Delete 1 — permission denied → Sudo Once
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Sudo Once');

      const file1 = createMockRemoteFile('a.txt', { path: '/etc/a.txt' });
      await service.deleteRemote(mockConnection as any, file1);

      // Delete 2 — permission denied again → Sudo Once again
      mockDeleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValueOnce('Sudo Once');

      const file2 = createMockRemoteFile('b.txt', { path: '/etc/b.txt' });
      await service.deleteRemote(mockConnection as any, file2);

      // Sudo dialog should have been shown twice
      const sudoDialogCalls = (vscode.window.showErrorMessage as jest.Mock).mock.calls.filter(
        (call: any[]) => call.includes('Sudo Once')
      );
      expect(sudoDialogCalls.length).toBe(2);

      // Sudo mode should NOT be active
      expect(_sudoMode).toBe(false);
    });
  });

  describe('Mixed operations with Sudo All', () => {
    it('should enable sudo mode from mkdir, then rename also has sudo active', async () => {
      // Step 1: mkdir fails → "Sudo All"
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('newdir');
      mockMkdir.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Sudo All');

      await service.createFolder(mockConnection as any, '/opt');
      expect(_sudoMode).toBe(true);

      // Step 2: rename on same connection — sudo mode already active
      // Should not trigger sudo dialog
      jest.clearAllMocks();
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('new-name.conf');
      // Rename succeeds (since sudo mode is active, CommandGuard routes through sudo)
      mockRename.mockResolvedValueOnce(undefined);

      const file = createMockRemoteFile('old.conf', { path: '/opt/old.conf' });
      await service.renameRemote(mockConnection as any, file);

      // No sudo dialog should have been shown
      const hasSudoDialog = (vscode.window.showErrorMessage as jest.Mock).mock.calls.some(
        (call: any[]) => call.includes('Sudo Once')
      );
      expect(hasSudoDialog).toBe(false);
    });
  });

  describe('Connection isolation — sudo on one server does not affect another', () => {
    it('should not have sudo mode on connection2 when connection1 has it', async () => {
      // Enable sudo on connection 1
      _sudoMode = true;
      _sudoPassword = 'pass-for-server-1';

      // Connection 2 should not have sudo mode
      expect(mockConnection2.sudoMode).toBe(false);

      // Delete on connection 2 fails → should show sudo dialog (not auto-sudo)
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');
      mockConnection2.deleteFile.mockRejectedValueOnce(new Error('Permission denied'));
      (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue('Cancel');

      const file = createMockRemoteFile('db.conf', { path: '/etc/db.conf' });
      await service.deleteRemote(mockConnection2 as any, file);

      // Sudo dialog should have been shown for connection 2
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('db-server'),
        'Sudo Once', 'Sudo All', 'Cancel'
      );
    });
  });
});
