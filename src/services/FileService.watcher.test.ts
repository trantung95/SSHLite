/**
 * FileService watcher tests
 *
 * Covers the post-fix behaviour of the poll-based file watcher:
 *
 *   A1  refreshSingleFile returns early on a (size, mtime) match — no readFile call.
 *   A2  After a real change, mapping.lastRemoteModTime is updated.
 *   A3  Tail-optimisation path is unaffected when size grows past the threshold.
 *   C1  handleWatchVisibilityChange stops the poll timer when the watched file
 *       is no longer in visibleTextEditors.
 *   C2  handleWatchVisibilityChange resumes the poll timer + fires an immediate
 *       refresh when the watched file becomes visible again.
 *   C3  stopCurrentFileWatch disposes the visibility subscription.
 *
 * Together these guard the click-during-search bug: without A the watcher
 * re-downloaded the file every 1s for 60s after the user clicked a result row
 * (3 GB pulled, ~100 MB heap churn per poll, ext-host eventually killed).
 */

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue(Buffer.from('local-content')),
  readdirSync: jest.fn().mockReturnValue([]),
  unlinkSync: jest.fn(),
  statSync: jest.fn().mockReturnValue({ mtimeMs: Date.now(), isDirectory: () => false }),
  rmdirSync: jest.fn(),
}));

jest.mock('os', () => ({
  tmpdir: jest.fn().mockReturnValue('/tmp'),
  platform: jest.fn().mockReturnValue('linux'),
}));

// Mock connection — stat & readFile & readFileTail are the surfaces we drive.
var mockConnection = {
  id: 'test-host:22:testuser',
  host: { name: 'Test Server', host: 'test-host', port: 22, username: 'testuser' },
  state: 'connected',
  writeFile: jest.fn().mockResolvedValue(undefined),
  readFile: jest.fn().mockResolvedValue(Buffer.from('original-content')),
  readFileTail: jest.fn().mockResolvedValue(Buffer.from('-tail')),
  listFiles: jest.fn().mockResolvedValue([]),
  exec: jest.fn().mockResolvedValue(''),
  deleteFile: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
  // Defaulted to a fixed (size, mtime). Individual tests override via mockResolvedValueOnce.
  stat: jest.fn().mockResolvedValue({ size: 100, modifiedTime: 1_000_000, isDirectory: false }),
  searchFiles: jest.fn().mockResolvedValue([]),
  watchFile: jest.fn().mockResolvedValue(false), // forces the poll path
  unwatchFile: jest.fn().mockResolvedValue(undefined),
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
  FolderHistoryService: { getInstance: jest.fn().mockReturnValue({ recordVisit: jest.fn(), getFrequentPaths: jest.fn().mockReturnValue([]), recordFileOpen: jest.fn() }) },
}));
jest.mock('./ProgressiveDownloadManager', () => ({
  ProgressiveDownloadManager: { getInstance: jest.fn().mockReturnValue({
    shouldUseProgressiveDownload: jest.fn().mockReturnValue(false),
    isDownloading: jest.fn().mockReturnValue(false),
    getLocalPath: jest.fn().mockReturnValue(undefined),
  }) },
}));
jest.mock('./PriorityQueueService', () => ({
  PriorityQueueService: { getInstance: jest.fn().mockReturnValue({
    enqueue: jest.fn(),
    getStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0, byPriority: {} }),
    cancelAll: jest.fn(),
    isProcessing: jest.fn().mockReturnValue(false),
    cancelConnection: jest.fn(),
    resetConnection: jest.fn(),
    isConnectionCancelled: jest.fn().mockReturnValue(false),
    getConnectionStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0 }),
  }) },
  PreloadPriority: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 },
}));
jest.mock('./ActivityService', () => ({
  ActivityService: { getInstance: jest.fn().mockReturnValue({
    startActivity: jest.fn().mockReturnValue('activity-1'),
    completeActivity: jest.fn(),
    failActivity: jest.fn(),
  }) },
}));
jest.mock('./CommandGuard', () => ({
  CommandGuard: { getInstance: jest.fn().mockReturnValue({
    exec: jest.fn().mockResolvedValue(''),
    upload: jest.fn().mockResolvedValue(undefined),
    download: jest.fn().mockResolvedValue(Buffer.from('')),
  }) },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscode = require('vscode');
import { FileService, FileMapping } from './FileService';

function resetFileService(): FileService {
  try { FileService.getInstance().dispose(); } catch { /* ignore */ }
  (FileService as any)._instance = undefined;
  return FileService.getInstance();
}

describe('FileService — refreshSingleFile fast-path (A) + visibility-gated poll (C)', () => {
  const localPath = '/tmp/ssh-lite/abc/ssh-huge.log';
  const remotePath = '/home/testuser/big/huge.log';
  let service: FileService;

  function setMapping(extras: Partial<FileMapping> = {}): FileMapping {
    const mappings: Map<string, FileMapping> = (service as any).fileMappings;
    const m: FileMapping = {
      connectionId: mockConnection.id,
      remotePath,
      localPath,
      lastSyncTime: Date.now(),
      lastRemoteSize: 100,
      lastRemoteModTime: 1_000_000,
      originalContent: 'original-content',
      ...extras,
    } as FileMapping;
    mappings.set(localPath, m);
    return m;
  }

  beforeEach(() => {
    mockConnection.stat.mockClear();
    mockConnection.readFile.mockClear();
    mockConnection.readFileTail.mockClear();
    mockConnection.watchFile.mockClear();
    mockConnection.unwatchFile.mockClear();
    // Re-wire the ConnectionManager mock to return mockConnection. The factory
    // sets this via mockReturnValue but the value gets cleared somewhere in
    // the dispose/getInstance path between tests, so we re-bind explicitly.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const cm = require('../connection/ConnectionManager').ConnectionManager.getInstance();
    cm.getConnection.mockReturnValue(mockConnection);
    cm.getAllConnections.mockReturnValue([mockConnection]);
    service = resetFileService();
    vscode.window.visibleTextEditors = [];
  });

  afterEach(() => {
    try { service.dispose(); } catch { /* ignore */ }
  });

  // -------- A: fast-path skips downloads on unchanged files --------

  it('A1: refreshSingleFile returns early when (size, mtime) match', async () => {
    const mapping = setMapping();
    mockConnection.stat.mockResolvedValueOnce({ size: 100, modifiedTime: 1_000_000, isDirectory: false });

    await (service as any).refreshSingleFile(localPath, mapping, true);

    expect(mockConnection.stat).toHaveBeenCalledTimes(1);
    expect(mockConnection.readFile).not.toHaveBeenCalled();
    expect(mockConnection.readFileTail).not.toHaveBeenCalled();
  });

  it('A2: lastRemoteModTime is updated after a real refresh', async () => {
    const mapping = setMapping({ originalContent: 'old' });
    // Same size, but mtime advanced — must NOT fast-path.
    mockConnection.stat.mockResolvedValueOnce({ size: 100, modifiedTime: 2_000_000, isDirectory: false });
    mockConnection.readFile.mockResolvedValueOnce(Buffer.from('new'));

    await (service as any).refreshSingleFile(localPath, mapping, true);

    expect(mockConnection.readFile).toHaveBeenCalledTimes(1);
    expect(mapping.lastRemoteModTime).toBe(2_000_000);
    expect(mapping.lastRemoteSize).toBe(100);
  });

  it('A3: tail-optimisation path still triggers when the file grew past threshold', async () => {
    const origGetConfig = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = (_section?: string) => ({
      get: (key: string, def?: unknown) => {
        if (key === 'smartRefreshThreshold') return 50;
        return def;
      },
    });
    try {
      const mapping = setMapping();
      mockConnection.stat.mockResolvedValueOnce({ size: 200, modifiedTime: 1_000_000, isDirectory: false });

      await (service as any).refreshSingleFile(localPath, mapping, true);

      expect(mockConnection.readFileTail).toHaveBeenCalledWith(remotePath, 100);
    } finally {
      vscode.workspace.getConfiguration = origGetConfig;
    }
  });

  // -------- C: visibility-gated polling --------

  it('C1: visibility change with watched file hidden stops the poll timer', () => {
    (service as any).currentWatchedFile = { localPath, remotePath, connectionId: mockConnection.id };
    (service as any).usingNativeWatch = false;
    (service as any).pollPaused = false;
    (service as any).focusedFilePollTimer = setInterval(() => {}, 60_000);
    vscode.window.visibleTextEditors = [];

    (service as any).handleWatchVisibilityChange();

    expect((service as any).pollPaused).toBe(true);
    expect((service as any).focusedFilePollTimer).toBeNull();
  });

  it('C2: visibility change with watched file becoming visible resumes timer + fires immediate refresh', async () => {
    setMapping();
    (service as any).currentWatchedFile = { localPath, remotePath, connectionId: mockConnection.id };
    (service as any).usingNativeWatch = false;
    (service as any).pollPaused = true;
    (service as any).focusedFilePollTimer = null;
    vscode.window.visibleTextEditors = [{ document: { uri: { fsPath: localPath } } }];

    (service as any).handleWatchVisibilityChange();

    expect((service as any).pollPaused).toBe(false);
    expect((service as any).focusedFilePollTimer).not.toBeNull();

    // Let the fire-and-forget refresh microtask resolve.
    await new Promise((r) => setImmediate(r));
    expect(mockConnection.stat).toHaveBeenCalled();

    clearInterval((service as any).focusedFilePollTimer);
    (service as any).focusedFilePollTimer = null;
  });

  it('C3: stopCurrentFileWatch disposes the visibility subscription', async () => {
    const dispose = jest.fn();
    (service as any).watchVisibilitySubscription = { dispose };
    (service as any).currentWatchedFile = { localPath, remotePath, connectionId: mockConnection.id };
    (service as any).usingNativeWatch = false;
    (service as any).pollPaused = true;

    await (service as any).stopCurrentFileWatch();

    expect(dispose).toHaveBeenCalledTimes(1);
    expect((service as any).watchVisibilitySubscription).toBeNull();
    expect((service as any).pollPaused).toBe(false);
  });

  it('C: handleWatchVisibilityChange is a no-op when native watch is in use', () => {
    (service as any).currentWatchedFile = { localPath, remotePath, connectionId: mockConnection.id };
    (service as any).usingNativeWatch = true;
    (service as any).pollPaused = false;
    const t = setInterval(() => {}, 60_000);
    (service as any).focusedFilePollTimer = t;
    vscode.window.visibleTextEditors = [];

    (service as any).handleWatchVisibilityChange();

    expect((service as any).pollPaused).toBe(false);
    expect((service as any).focusedFilePollTimer).toBe(t);
    clearInterval(t);
  });
});
