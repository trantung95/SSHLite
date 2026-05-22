/**
 * Regression tests for v0.8.17: downloadFileTo / downloadFolder must route
 * writes through vscode.workspace.fs (which respects the URI scheme) instead
 * of raw fs.writeFileSync(uri.fsPath, ...). The old direct-fs path broke
 * silently when the extension ran on a Remote-SSH workspace host because
 * showSaveDialog returned `vscode-remote://` URIs whose .fsPath resolved
 * to /tmp/<vscode-tmp-id>/... — not the user-chosen path. See .adn/lessons.md
 * "2026-05-22 — fs.writeFileSync(uri.fsPath, …) is unsafe …".
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
  homedir: jest.fn().mockReturnValue('/home/test'),
  platform: jest.fn().mockReturnValue('linux'),
}));

var mockConnection = {
  id: 'test-host:22:testuser',
  host: { name: 'Test Server', host: 'test-host', port: 22, username: 'testuser' },
  state: 'connected',
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from('downloaded-bytes')),
  listFiles: jest.fn().mockResolvedValue([]),
  exec: jest.fn().mockResolvedValue(''),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockResolvedValue({ size: 100, isDirectory: false }),
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
      updateProgress: jest.fn(),
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

import * as fs from 'fs';
import * as vscode from 'vscode';
import { FileService } from './FileService';

function resetFileService(): FileService {
  try {
    FileService.getInstance().dispose();
  } catch {
    // ignore
  }
  (FileService as any)._instance = undefined;
  return FileService.getInstance();
}

describe('FileService download — URI-scheme-safe writes (v0.8.17 regression net)', () => {
  let service: FileService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.readFile.mockResolvedValue(Buffer.from('downloaded-bytes'));
    mockConnection.listFiles.mockResolvedValue([]);
    service = resetFileService();
    (vscode.workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (vscode.workspace.fs.createDirectory as jest.Mock | undefined)?.mockResolvedValue?.(undefined);
  });

  afterEach(() => {
    try {
      service.dispose();
    } catch {
      // ignore
    }
  });

  const remoteFile = {
    name: 'foo.bin',
    path: '/remote/foo.bin',
    isDirectory: false,
    size: 16,
    modifiedTime: Date.now(),
    connectionId: mockConnection.id,
  };

  describe('downloadFileTo', () => {
    it('routes the write through vscode.workspace.fs.writeFile when scheme=file:', async () => {
      const saveUri = vscode.Uri.file('/home/test/foo.bin');
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(saveUri);

      await service.downloadFileTo(mockConnection as any, remoteFile);

      expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
      const [calledUri, calledBuf] = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls[0];
      expect(calledUri).toBe(saveUri);
      expect(Buffer.from(calledBuf).toString()).toBe('downloaded-bytes');
      // Critical: the direct-fs write must never fire on the dialog return value.
      expect((fs.writeFileSync as jest.Mock)).not.toHaveBeenCalledWith(saveUri.fsPath, expect.anything());
    });

    it('routes the write through vscode.workspace.fs.writeFile when scheme=vscode-remote:', async () => {
      const saveUri = vscode.Uri.parse('vscode-remote://ssh-remote+box/home/userA/foo.bin');
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(saveUri);

      await service.downloadFileTo(mockConnection as any, remoteFile);

      expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
      const [calledUri] = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls[0];
      expect(calledUri.scheme).toBe('vscode-remote');
      expect(calledUri.path).toBe('/home/userA/foo.bin');
      expect((fs.writeFileSync as jest.Mock)).not.toHaveBeenCalledWith(saveUri.fsPath, expect.anything());
    });

    it('routes the write through vscode.workspace.fs.writeFile when scheme=custom mem:', async () => {
      const saveUri = vscode.Uri.parse('mem://provider/in-memory/foo.bin');
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(saveUri);

      await service.downloadFileTo(mockConnection as any, remoteFile);

      expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
      const [calledUri] = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls[0];
      expect(calledUri.scheme).toBe('mem');
      expect((fs.writeFileSync as jest.Mock)).not.toHaveBeenCalledWith(saveUri.fsPath, expect.anything());
    });

    it('does not write when user cancels showSaveDialog', async () => {
      (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(undefined);

      await service.downloadFileTo(mockConnection as any, remoteFile);

      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
      expect(fs.writeFileSync as jest.Mock).not.toHaveBeenCalled();
    });
  });

  describe('downloadFolder (recursive)', () => {
    it('creates directories and writes file bytes via vscode.workspace.fs, not raw fs', async () => {
      const folderUri = vscode.Uri.file('/home/test/dest');
      (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([folderUri]);

      // Two-level remote tree: /remote/dir/a.txt and /remote/dir/sub/b.txt
      const root = {
        name: 'dir',
        path: '/remote/dir',
        isDirectory: true,
        size: 0,
        modifiedTime: Date.now(),
        connectionId: mockConnection.id,
      };
      mockConnection.listFiles.mockImplementation(async (remotePath: string) => {
        if (remotePath === '/remote/dir') {
          return [
            { name: 'a.txt', path: '/remote/dir/a.txt', isDirectory: false, size: 4, modifiedTime: Date.now(), connectionId: mockConnection.id },
            { name: 'sub', path: '/remote/dir/sub', isDirectory: true, size: 0, modifiedTime: Date.now(), connectionId: mockConnection.id },
          ];
        }
        if (remotePath === '/remote/dir/sub') {
          return [
            { name: 'b.txt', path: '/remote/dir/sub/b.txt', isDirectory: false, size: 4, modifiedTime: Date.now(), connectionId: mockConnection.id },
          ];
        }
        return [];
      });

      await service.downloadFolder(mockConnection as any, root as any);

      expect(vscode.workspace.fs.createDirectory).toHaveBeenCalled();
      const dirArgs = (vscode.workspace.fs.createDirectory as jest.Mock).mock.calls.map((c) => c[0].path);
      expect(dirArgs).toEqual(expect.arrayContaining([
        expect.stringContaining('/dest/dir'),
        expect.stringContaining('/dest/dir/sub'),
      ]));

      const fileArgs = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls.map((c) => c[0].path);
      expect(fileArgs).toEqual(expect.arrayContaining([
        expect.stringContaining('/dest/dir/a.txt'),
        expect.stringContaining('/dest/dir/sub/b.txt'),
      ]));

      // No direct fs writes on the user-chosen destination.
      expect(fs.writeFileSync as jest.Mock).not.toHaveBeenCalled();
      expect(fs.mkdirSync as jest.Mock).not.toHaveBeenCalledWith(expect.stringContaining('/dest/dir'), expect.anything());
    });
  });
});
