/**
 * Regression tests for v0.8.18: uploadFileTo must read the user-selected file
 * through vscode.workspace.fs (which respects the URI scheme) instead of raw
 * fs.readFileSync(uri.fsPath, ...) / fs.statSync(uri.fsPath). The old direct-fs
 * path broke silently when the extension ran on a Remote-SSH workspace host
 * because showOpenDialog returned `vscode-remote://` URIs whose .fsPath could
 * not be reached by the raw `fs` module (or read from the wrong host). Mirror
 * of FileService.downloadUri.test.ts. See .adn/lessons.md
 * "2026-05-22 — fs.writeFileSync(uri.fsPath, …) is unsafe …".
 */

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue(Buffer.from('DIRECT-FS-SHOULD-NOT-BE-USED')),
  readdirSync: jest.fn().mockReturnValue([]),
  unlinkSync: jest.fn(),
  statSync: jest.fn().mockReturnValue({ size: 999, mtimeMs: Date.now(), isDirectory: () => false }),
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

describe('FileService upload — URI-scheme-safe reads (v0.8.18 regression net)', () => {
  let service: FileService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = resetFileService();
    (vscode.workspace.fs.readFile as jest.Mock).mockResolvedValue(Buffer.from('local-bytes'));
    (vscode.workspace.fs.stat as jest.Mock).mockResolvedValue({ size: 11 });
    mockConnection.writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    try {
      service.dispose();
    } catch {
      // ignore
    }
  });

  it('reads the selected file via vscode.workspace.fs.readFile when scheme=file:', async () => {
    const pickUri = vscode.Uri.file('/home/test/foo.bin');
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([pickUri]);

    await service.uploadFileTo(mockConnection as any, '/remote/dir');

    expect(vscode.workspace.fs.readFile).toHaveBeenCalledTimes(1);
    expect((vscode.workspace.fs.readFile as jest.Mock).mock.calls[0][0]).toBe(pickUri);

    // Bytes flow from the URI read straight to the remote write.
    expect(mockConnection.writeFile).toHaveBeenCalledTimes(1);
    const [remotePath, buf] = mockConnection.writeFile.mock.calls[0];
    expect(remotePath).toBe('/remote/dir/foo.bin');
    expect(Buffer.from(buf).toString()).toBe('local-bytes');

    // Critical: raw fs must never touch the dialog return value.
    expect(fs.readFileSync as jest.Mock).not.toHaveBeenCalled();
    expect(fs.statSync as jest.Mock).not.toHaveBeenCalledWith(pickUri.fsPath);
  });

  it('reads the selected file via vscode.workspace.fs.readFile when scheme=vscode-remote:', async () => {
    const pickUri = vscode.Uri.parse('vscode-remote://ssh-remote+box/home/userA/report.pdf');
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([pickUri]);

    await service.uploadFileTo(mockConnection as any, '/remote/dir');

    expect(vscode.workspace.fs.readFile).toHaveBeenCalledTimes(1);
    const calledUri = (vscode.workspace.fs.readFile as jest.Mock).mock.calls[0][0];
    expect(calledUri.scheme).toBe('vscode-remote');
    expect(calledUri.path).toBe('/home/userA/report.pdf');

    expect(mockConnection.writeFile).toHaveBeenCalledTimes(1);
    expect(mockConnection.writeFile.mock.calls[0][0]).toBe('/remote/dir/report.pdf');
    expect(fs.readFileSync as jest.Mock).not.toHaveBeenCalled();
  });

  it('reads the selected file via vscode.workspace.fs.readFile when scheme=custom mem:', async () => {
    const pickUri = vscode.Uri.parse('mem://provider/in-memory/blob.dat');
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([pickUri]);

    await service.uploadFileTo(mockConnection as any, '/remote/dir');

    expect(vscode.workspace.fs.readFile).toHaveBeenCalledTimes(1);
    expect((vscode.workspace.fs.readFile as jest.Mock).mock.calls[0][0].scheme).toBe('mem');
    expect(mockConnection.writeFile.mock.calls[0][0]).toBe('/remote/dir/blob.dat');
    expect(fs.readFileSync as jest.Mock).not.toHaveBeenCalled();
  });

  it('does not read or write when user cancels showOpenDialog', async () => {
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce(undefined);

    await service.uploadFileTo(mockConnection as any, '/remote/dir');

    expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled();
    expect(mockConnection.writeFile).not.toHaveBeenCalled();
    expect(fs.readFileSync as jest.Mock).not.toHaveBeenCalled();
  });

  it('surfaces an error and does not upload when the read fails', async () => {
    const pickUri = vscode.Uri.file('/home/test/gone.bin');
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([pickUri]);
    (vscode.workspace.fs.readFile as jest.Mock).mockRejectedValueOnce(new Error('FileNotFound'));

    // Must not throw out of the method (would become an unhandled rejection).
    await expect(service.uploadFileTo(mockConnection as any, '/remote/dir')).resolves.toBeUndefined();

    expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
    expect((vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0]).toContain('FileNotFound');
    expect(mockConnection.writeFile).not.toHaveBeenCalled();
  });

  it('decodes a percent-encoded leaf name for the remote path', async () => {
    // A vscode-remote: dialog URI may keep its path percent-encoded.
    const pickUri = vscode.Uri.parse('vscode-remote://ssh-remote+box/home/userA/my%20report.pdf');
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([pickUri]);

    await service.uploadFileTo(mockConnection as any, '/remote/dir');

    expect(mockConnection.writeFile).toHaveBeenCalledTimes(1);
    expect(mockConnection.writeFile.mock.calls[0][0]).toBe('/remote/dir/my report.pdf');
  });

  it('preserves a literal percent in a file: leaf name (no throw on bad encoding)', async () => {
    const pickUri = vscode.Uri.file('/home/test/100%.txt');
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([pickUri]);

    await service.uploadFileTo(mockConnection as any, '/remote/dir');

    expect(mockConnection.writeFile).toHaveBeenCalledTimes(1);
    expect(mockConnection.writeFile.mock.calls[0][0]).toBe('/remote/dir/100%.txt');
  });
});
