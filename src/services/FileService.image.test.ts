/**
 * Issue #12 regression tests — image files must open in the image viewer.
 *
 * Bug: openRemoteFile() opened every file through VS Code's TEXT editor, so
 * clicking a photo on the server rendered raw binary as garbage ("a strange
 * page opens"). Images must be downloaded in FULL (no placeholder, no
 * progressive download) and opened via the `vscode.open` command so VS Code
 * routes them to its built-in image viewer.
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

var mockReadFile = jest.fn().mockResolvedValue(Buffer.from('image-bytes'));
var mockListFiles = jest.fn().mockResolvedValue([]);
var mockWriteFile = jest.fn().mockResolvedValue(undefined);
var mockExec = jest.fn().mockResolvedValue('');
var mockFileExists = jest.fn().mockResolvedValue(false);

var mockConnection = {
  id: 'test-host:22:testuser',
  host: { name: 'Test Server', host: 'test-host', port: 22, username: 'testuser' },
  state: 'connected',
  writeFile: mockWriteFile,
  readFile: mockReadFile,
  listFiles: mockListFiles,
  exec: mockExec,
  deleteFile: jest.fn().mockResolvedValue(undefined),
  rename: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  stat: jest.fn().mockResolvedValue({ size: 100, isDirectory: false, name: 'test', path: '/test', modifiedTime: Date.now(), connectionId: 'test' }),
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

var mockAuditLog = jest.fn();
jest.mock('./AuditService', () => ({
  AuditService: { getInstance: jest.fn().mockImplementation(() => ({ get log() { return mockAuditLog; }, logAudit: jest.fn(), logEdit: jest.fn() })) },
}));
var mockRecordFileOpen = jest.fn();
jest.mock('./FolderHistoryService', () => ({
  FolderHistoryService: {
    getInstance: jest.fn().mockReturnValue({
      recordVisit: jest.fn(),
      get recordFileOpen() { return mockRecordFileOpen; },
      getFrequentPaths: jest.fn().mockReturnValue([]),
    }),
  },
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

import * as fs from 'fs';
import * as vscode from 'vscode';
import { FileService } from './FileService';
import { createMockRemoteFile } from '../__mocks__/testHelpers';
import { isImageFile, IMAGE_EXTENSIONS } from '../types/progressive';

function resetFileService(): FileService {
  try { FileService.getInstance().dispose(); } catch { /* ignore */ }
  (FileService as any)._instance = undefined;
  return FileService.getInstance();
}

function vscodeOpenCalls(): unknown[][] {
  return (vscode.commands.executeCommand as jest.Mock).mock.calls.filter((c) => c[0] === 'vscode.open');
}

describe('isImageFile (issue #12)', () => {
  it('detects all supported image extensions, case-insensitively', () => {
    for (const ext of IMAGE_EXTENSIONS) {
      expect(isImageFile(`photo${ext}`)).toBe(true);
      expect(isImageFile(`photo${ext.toUpperCase()}`)).toBe(true);
    }
  });

  it('rejects non-image files', () => {
    expect(isImageFile('notes.txt')).toBe(false);
    expect(isImageFile('archive.zip')).toBe(false);
    expect(isImageFile('binary.exe')).toBe(false);
    expect(isImageFile('README')).toBe(false);
    expect(isImageFile('app.config.json')).toBe(false);
  });
});

describe('FileService.openRemoteFile — images (issue #12)', () => {
  let service: FileService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFile.mockResolvedValue(Buffer.from('image-bytes'));
    service = resetFileService();
  });

  afterEach(() => {
    try { service.dispose(); } catch { /* ignore */ }
  });

  it('downloads the FULL image and opens it with vscode.open, never the text editor', async () => {
    const file = createMockRemoteFile('photo.png', { path: '/var/www/photo.png', size: 2048 });

    await service.openRemoteFile(mockConnection as any, file);

    // Full download of the real bytes
    expect(mockReadFile).toHaveBeenCalledWith('/var/www/photo.png');
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenContent] = (fs.writeFileSync as jest.Mock).mock.calls[0];
    expect(String(writtenPath)).toContain('photo.png');
    expect(Buffer.isBuffer(writtenContent)).toBe(true);

    // Opened via vscode.open (image viewer), NOT the text editor
    expect(vscodeOpenCalls()).toHaveLength(1);
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('small images (<1MB) download silently without a progress notification', async () => {
    const file = createMockRemoteFile('icon.gif', { path: '/srv/icon.gif', size: 10 * 1024 });

    await service.openRemoteFile(mockConnection as any, file);

    expect(vscode.window.withProgress).not.toHaveBeenCalled();
    expect(vscodeOpenCalls()).toHaveLength(1);
  });

  it('large images (>=1MB) show a progress notification while downloading', async () => {
    const file = createMockRemoteFile('photo.jpg', { path: '/srv/photo.jpg', size: 5 * 1024 * 1024 });

    await service.openRemoteFile(mockConnection as any, file);

    expect(vscode.window.withProgress).toHaveBeenCalledTimes(1);
    expect(vscodeOpenCalls()).toHaveLength(1);
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('images above the progressive threshold still skip the progressive/placeholder path', async () => {
    // 5MB jpg is over the default 1MB progressive threshold; without the image
    // branch it would previously have hit the binary text-editor path
    const file = createMockRemoteFile('big.jpeg', { path: '/srv/big.jpeg', size: 5 * 1024 * 1024 });

    await service.openRemoteFile(mockConnection as any, file);

    expect(vscodeOpenCalls()).toHaveLength(1);
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();
  });

  it('uppercase extensions are detected (PHOTO.PNG)', async () => {
    const file = createMockRemoteFile('PHOTO.PNG', { path: '/srv/PHOTO.PNG', size: 2048 });

    await service.openRemoteFile(mockConnection as any, file);

    expect(vscodeOpenCalls()).toHaveLength(1);
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
  });

  it('audit-logs the image download', async () => {
    const file = createMockRemoteFile('photo.webp', { path: '/srv/photo.webp', size: 2048 });

    await service.openRemoteFile(mockConnection as any, file);

    expect(mockAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'download',
      remotePath: '/srv/photo.webp',
      success: true,
    }));
  });

  it('guards against a concurrent double-open (no torn write, opens once)', async () => {
    const file = createMockRemoteFile('photo.png', { path: '/srv/photo.png', size: 2048 });
    // Make readFile slow so the two opens overlap
    let resolveRead: (b: Buffer) => void = () => {};
    mockReadFile.mockImplementationOnce(() => new Promise<Buffer>((r) => { resolveRead = r; }));

    const first = service.openRemoteFile(mockConnection as any, file);
    const second = service.openRemoteFile(mockConnection as any, file); // should no-op
    resolveRead(Buffer.from('image-bytes'));
    await Promise.all([first, second]);

    // Only the first call downloaded, wrote, and opened
    expect(mockReadFile).toHaveBeenCalledTimes(1);
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    expect(vscodeOpenCalls()).toHaveLength(1);
  });

  it('propagates download failures instead of opening a broken image', async () => {
    mockReadFile.mockRejectedValue(new Error('Connection lost'));
    const file = createMockRemoteFile('photo.png', { path: '/srv/photo.png', size: 2048 });

    await expect(service.openRemoteFile(mockConnection as any, file)).rejects.toThrow('Connection lost');
    expect(vscodeOpenCalls()).toHaveLength(0);
  });
});
