/**
 * FileService copy/paste tests
 *
 * Covers the new remote copy/move flows backing the SSH clipboard feature:
 *  - copyRemoteSameHost runs `cp` / `cp -r` with shell-safe quoting
 *  - moveRemoteSameHost delegates to SFTP rename
 *  - copyRemoteCrossHost streams file contents and recurses into folders
 *  - nextCopyName produces distinct names when pasting into the source folder
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

var mockExec = jest.fn().mockResolvedValue('');
var mockRename = jest.fn().mockResolvedValue(undefined);
var mockMkdir = jest.fn().mockResolvedValue(undefined);
var mockReadFile = jest.fn().mockResolvedValue(Buffer.from('contents'));
var mockWriteFile = jest.fn().mockResolvedValue(undefined);
var mockListFiles = jest.fn().mockResolvedValue([]);
var mockDeleteFile = jest.fn().mockResolvedValue(undefined);

function makeMockConnection(id: string, hostName: string) {
  return {
    id,
    host: { name: hostName, host: hostName, port: 22, username: 'u' },
    state: 'connected',
    sudoMode: false,
    exec: mockExec,
    rename: mockRename,
    mkdir: mockMkdir,
    readFile: mockReadFile,
    writeFile: mockWriteFile,
    listFiles: mockListFiles,
    deleteFile: mockDeleteFile,
    searchFiles: jest.fn().mockResolvedValue([]),
    watchFile: jest.fn().mockResolvedValue(false),
    onFileChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  };
}

var mockSrcConnection = makeMockConnection('src-1', 'src-host');
var mockDestConnection = makeMockConnection('dest-1', 'dest-host');

jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: {
    getInstance: jest.fn().mockImplementation(() => ({
      getConnection: jest.fn().mockReturnValue(mockSrcConnection),
      getAllConnections: jest.fn().mockReturnValue([mockSrcConnection, mockDestConnection]),
      onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    })),
  },
}));

var mockAuditLog = jest.fn();
jest.mock('./AuditService', () => ({
  AuditService: { getInstance: jest.fn().mockImplementation(() => ({ get log() { return mockAuditLog; }, logEdit: jest.fn() })) },
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

import { FileService } from './FileService';
import { createMockRemoteFile } from '../__mocks__/testHelpers';

function resetFileService(): FileService {
  try { FileService.getInstance().dispose(); } catch { /* ignore */ }
  (FileService as any)._instance = undefined;
  return FileService.getInstance();
}

describe('FileService - remote copy/paste', () => {
  let service: FileService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = resetFileService();
  });

  afterEach(() => {
    try { service.dispose(); } catch { /* ignore */ }
  });

  describe('copyRemoteSameHost', () => {
    it('runs cp for a file with shell-safe quoting', async () => {
      await service.copyRemoteSameHost(mockSrcConnection as any, '/src/file.txt', '/dest/file.txt', false);

      expect(mockExec).toHaveBeenCalledTimes(1);
      const cmd = mockExec.mock.calls[0][0] as string;
      expect(cmd).toContain("cp");
      expect(cmd).not.toContain('-r');
      expect(cmd).toContain("'/src/file.txt'");
      expect(cmd).toContain("'/dest/file.txt'");
    });

    it('runs cp -r for a folder', async () => {
      await service.copyRemoteSameHost(mockSrcConnection as any, '/src/dir', '/dest/dir', true);

      const cmd = mockExec.mock.calls[0][0] as string;
      expect(cmd).toContain('-r');
    });

    it('escapes single quotes in paths', async () => {
      await service.copyRemoteSameHost(mockSrcConnection as any, "/src/it's.txt", "/dest/it's.txt", false);

      const cmd = mockExec.mock.calls[0][0] as string;
      expect(cmd).toContain("'\\''");
    });

    it('logs successful copy in audit trail', async () => {
      await service.copyRemoteSameHost(mockSrcConnection as any, '/src/a', '/dest/a', false);

      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: 'copy',
        remotePath: '/src/a',
        localPath: '/dest/a',
        success: true,
      }));
    });

    it('logs audit failure and rethrows on non-permission errors', async () => {
      mockExec.mockRejectedValueOnce(new Error('disk full'));

      await expect(
        service.copyRemoteSameHost(mockSrcConnection as any, '/src/a', '/dest/a', false)
      ).rejects.toThrow('disk full');

      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: 'copy',
        success: false,
        error: 'disk full',
      }));
    });
  });

  describe('moveRemoteSameHost', () => {
    it('uses SFTP rename', async () => {
      await service.moveRemoteSameHost(mockSrcConnection as any, '/src/a', '/dest/a');

      expect(mockRename).toHaveBeenCalledWith('/src/a', '/dest/a');
    });

    it('logs move audit on success', async () => {
      await service.moveRemoteSameHost(mockSrcConnection as any, '/src/a', '/dest/a');

      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: 'move',
        remotePath: '/src/a',
        localPath: '/dest/a',
        success: true,
      }));
    });

    it('rethrows non-permission errors', async () => {
      mockRename.mockRejectedValueOnce(new Error('ENOSPC'));

      await expect(
        service.moveRemoteSameHost(mockSrcConnection as any, '/src/a', '/dest/a')
      ).rejects.toThrow('ENOSPC');
    });
  });

  describe('copyRemoteCrossHost - file', () => {
    it('reads from source and writes to destination', async () => {
      mockReadFile.mockResolvedValueOnce(Buffer.from('hello'));

      await service.copyRemoteCrossHost(
        mockSrcConnection as any,
        '/src/file.txt',
        mockDestConnection as any,
        '/dest/file.txt',
        false
      );

      expect(mockReadFile).toHaveBeenCalledWith('/src/file.txt');
      expect(mockWriteFile).toHaveBeenCalledWith('/dest/file.txt', Buffer.from('hello'));
    });

    it('logs copy audit with dest host name', async () => {
      await service.copyRemoteCrossHost(
        mockSrcConnection as any,
        '/src/a',
        mockDestConnection as any,
        '/dest/a',
        false
      );

      expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
        action: 'copy',
        remotePath: '/src/a',
        localPath: 'dest-host:/dest/a',
        success: true,
      }));
    });
  });

  describe('copyRemoteCrossHost - folder', () => {
    it('creates dest dir and recurses into children', async () => {
      mockListFiles.mockImplementation(async (p: string) => {
        if (p === '/src/dir') {
          return [
            createMockRemoteFile('a.txt', { path: '/src/dir/a.txt' }),
            createMockRemoteFile('sub', { path: '/src/dir/sub', isDirectory: true }),
          ];
        }
        if (p === '/src/dir/sub') {
          return [createMockRemoteFile('b.txt', { path: '/src/dir/sub/b.txt' })];
        }
        return [];
      });

      await service.copyRemoteCrossHost(
        mockSrcConnection as any,
        '/src/dir',
        mockDestConnection as any,
        '/dest/dir',
        true
      );

      expect(mockMkdir).toHaveBeenCalledWith('/dest/dir');
      expect(mockMkdir).toHaveBeenCalledWith('/dest/dir/sub');
      expect(mockWriteFile).toHaveBeenCalledWith('/dest/dir/a.txt', expect.any(Buffer));
      expect(mockWriteFile).toHaveBeenCalledWith('/dest/dir/sub/b.txt', expect.any(Buffer));
    });

    it('swallows existing-directory error when recreating dest root', async () => {
      mockMkdir.mockRejectedValueOnce(new Error('Failure: File exists'));
      mockListFiles.mockResolvedValue([]);

      await expect(
        service.copyRemoteCrossHost(mockSrcConnection as any, '/src/dir', mockDestConnection as any, '/dest/dir', true)
      ).resolves.toBeUndefined();
    });

    it('swallows eexist (lowercase) error from mkdir', async () => {
      mockMkdir.mockRejectedValueOnce(new Error('eexist'));
      mockListFiles.mockResolvedValue([]);
      await expect(
        service.copyRemoteCrossHost(mockSrcConnection as any, '/src/dir', mockDestConnection as any, '/dest/dir', true)
      ).resolves.toBeUndefined();
    });

    it('rethrows non-exists mkdir errors', async () => {
      mockMkdir.mockRejectedValueOnce(new Error('permission denied'));
      await expect(
        service.copyRemoteCrossHost(mockSrcConnection as any, '/src/dir', mockDestConnection as any, '/dest/dir', true)
      ).rejects.toThrow('permission denied');
    });

    it('aborts mid-recursion when cancellation token is set after first listFiles', async () => {
      const token = { isCancellationRequested: false, onCancellationRequested: jest.fn() };
      let callCount = 0;
      mockListFiles.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          token.isCancellationRequested = true;
          return [createMockRemoteFile('child.txt', { path: '/src/dir/child.txt' })];
        }
        return [];
      });
      await expect(
        service.copyRemoteCrossHost(
          mockSrcConnection as any, '/src/dir',
          mockDestConnection as any, '/dest/dir',
          true, token as any
        )
      ).rejects.toThrow('Cancelled');
    });

    it('aborts when cancellation token is triggered before reading', async () => {
      const token = { isCancellationRequested: true, onCancellationRequested: jest.fn() };

      await expect(
        service.copyRemoteCrossHost(
          mockSrcConnection as any,
          '/src/file.txt',
          mockDestConnection as any,
          '/dest/file.txt',
          false,
          token as any
        )
      ).rejects.toThrow('Cancelled');
    });
  });

  describe('nextCopyName', () => {
    it('returns the original name when no conflict', () => {
      expect(service.nextCopyName('foo.txt', new Set())).toBe('foo.txt');
    });

    it('appends (copy) before the extension when name is taken', () => {
      expect(service.nextCopyName('foo.txt', new Set(['foo.txt']))).toBe('foo (copy).txt');
    });

    it('appends (copy) N when (copy) already exists', () => {
      expect(
        service.nextCopyName('foo.txt', new Set(['foo.txt', 'foo (copy).txt']))
      ).toBe('foo (copy) 2.txt');
    });

    it('handles names without extensions', () => {
      expect(service.nextCopyName('README', new Set(['README']))).toBe('README (copy)');
    });

    it('handles dotfiles (treats whole name as base)', () => {
      // .bashrc has no ext because the leading dot is at index 0, not > 0
      expect(service.nextCopyName('.bashrc', new Set(['.bashrc']))).toBe('.bashrc (copy)');
    });
  });

  describe('resolveDefaultRemotePath', () => {
    it('expands ~ by running echo $HOME', async () => {
      const conn = { ...mockSrcConnection, host: { ...mockSrcConnection.host, username: 'alice' } };
      mockExec.mockResolvedValueOnce('/home/alice\n');
      const result = await service.resolveDefaultRemotePath(conn as any);
      expect(mockExec).toHaveBeenCalledWith('echo $HOME');
      expect(result).toBe('/home/alice');
    });

    it('falls back to /home/<username> when exec throws', async () => {
      const conn = { ...mockSrcConnection, host: { ...mockSrcConnection.host, username: 'bob' } };
      mockExec.mockRejectedValueOnce(new Error('not connected'));
      const result = await service.resolveDefaultRemotePath(conn as any);
      expect(result).toBe('/home/bob');
    });

    it('expands ~ and trims whitespace from exec output', async () => {
      const conn = { ...mockSrcConnection, host: { ...mockSrcConnection.host, username: 'alice' } };
      // exec returns path with extra whitespace/newline
      mockExec.mockResolvedValueOnce('  /home/alice  \n');
      const result = await service.resolveDefaultRemotePath(conn as any);
      expect(result).toBe('/home/alice');
    });
  });

  describe('deleteRemotePath', () => {
    it('uses rm -rf for directories with shell-safe escaping', async () => {
      await service.deleteRemotePath(mockSrcConnection as any, '/home/user/mydir', true);
      const cmd = mockExec.mock.calls[0][0] as string;
      expect(cmd).toMatch(/^rm -rf -- '/);
      expect(cmd).toContain("'/home/user/mydir'");
    });

    it('uses deleteFile for regular files', async () => {
      await service.deleteRemotePath(mockSrcConnection as any, '/home/user/file.txt', false);
      expect(mockDeleteFile).toHaveBeenCalledWith('/home/user/file.txt');
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('shell-escapes single quotes in directory path', async () => {
      await service.deleteRemotePath(mockSrcConnection as any, "/home/user/it's", true);
      const cmd = mockExec.mock.calls[0][0] as string;
      expect(cmd).toContain("'\\''");
    });
  });
});
