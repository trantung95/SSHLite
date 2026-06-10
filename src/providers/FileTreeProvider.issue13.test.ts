/**
 * Issue #13 regression tests — infinite loop when a directory listing fails.
 *
 * Bug: when listFiles() rejected (e.g. clicking the root icon while the
 * connection cannot list "/"), loadDirectoryAndRefresh() deleted the loading
 * key and fired a tree refresh. The re-entered getChildren() saw "not cached,
 * not loading" and started the load again, which failed again, firing another
 * refresh and another error notification — an infinite loop that froze
 * VS Code and spammed "Failed to list directory: ..." notifications.
 *
 * Fix: failed loads are recorded in failedLoads; getChildren() renders a
 * LoadErrorTreeItem instead of retrying. An explicit user action (refresh,
 * navigation, cache clear/reconnect) clears the failure and allows a retry.
 */

import * as vscode from 'vscode';
import { createMockConnection, createMockRemoteFile } from '../__mocks__/testHelpers';

// --- Mock service instances (must be declared before jest.mock calls) ---

var mockGetConnection = jest.fn();
var mockGetAllConnections = jest.fn().mockReturnValue([]);
var mockGetAllConnectionsWithReconnecting = jest.fn().mockReturnValue({ active: [], reconnecting: [] });
var mockConnectionChangeEmitter = new (require('../__mocks__/vscode').EventEmitter)();
var mockReconnectingEmitter = new (require('../__mocks__/vscode').EventEmitter)();

var mockOnOpenFilesChanged = new (require('../__mocks__/vscode').EventEmitter)();
var mockOnFileLoadingChanged = new (require('../__mocks__/vscode').EventEmitter)();

var mockRecordVisit = jest.fn();
var mockGetFrequentFolders = jest.fn().mockReturnValue([]);
var mockGetPreloadTargets = jest.fn().mockReturnValue([]);

var mockEnqueue = jest.fn().mockResolvedValue(undefined);
var mockCancelAll = jest.fn();
var mockIsConnectionCancelled = jest.fn().mockReturnValue(false);
var mockIsPreloadingInProgress = jest.fn().mockReturnValue(false);
var mockResetConnection = jest.fn();
var mockGetStatus = jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0, byPriority: {} });

var mockStartActivity = jest.fn().mockReturnValue('activity-1');
var mockCompleteActivity = jest.fn();
var mockFailActivity = jest.fn();
var mockCancelActivity = jest.fn();

// --- jest.mock calls ---

jest.mock('../connection/ConnectionManager', () => {
  const instance = {
    get getConnection() { return mockGetConnection; },
    get getAllConnections() { return mockGetAllConnections; },
    get getAllConnectionsWithReconnecting() { return mockGetAllConnectionsWithReconnecting; },
    get onDidChangeConnections() { return mockConnectionChangeEmitter.event; },
    get onReconnecting() { return mockReconnectingEmitter.event; },
    getLastConnectionAttempt: jest.fn().mockReturnValue(undefined),
  };
  return { ConnectionManager: { getInstance: jest.fn().mockReturnValue(instance) } };
});

jest.mock('../services/FileService', () => {
  const instance = {
    get onOpenFilesChanged() { return mockOnOpenFilesChanged.event; },
    get onFileLoadingChanged() { return mockOnFileLoadingChanged.event; },
    preloadFrequentFiles: jest.fn().mockResolvedValue(undefined),
  };
  return { FileService: { getInstance: jest.fn().mockReturnValue(instance) } };
});

jest.mock('../services/FolderHistoryService', () => {
  const instance = {
    get recordVisit() { return mockRecordVisit; },
    get getFrequentFolders() { return mockGetFrequentFolders; },
    get getPreloadTargets() { return mockGetPreloadTargets; },
  };
  return { FolderHistoryService: { getInstance: jest.fn().mockReturnValue(instance) } };
});

jest.mock('../services/PriorityQueueService', () => {
  const instance = {
    get enqueue() { return mockEnqueue; },
    get cancelAll() { return mockCancelAll; },
    get isConnectionCancelled() { return mockIsConnectionCancelled; },
    get isPreloadingInProgress() { return mockIsPreloadingInProgress; },
    get resetConnection() { return mockResetConnection; },
    get getStatus() { return mockGetStatus; },
  };
  return {
    PriorityQueueService: { getInstance: jest.fn().mockReturnValue(instance) },
    PreloadPriority: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, IDLE: 4 },
  };
});

jest.mock('../services/ActivityService', () => {
  const instance = {
    get startActivity() { return mockStartActivity; },
    get completeActivity() { return mockCompleteActivity; },
    get failActivity() { return mockFailActivity; },
    get cancelActivity() { return mockCancelActivity; },
  };
  return { ActivityService: { getInstance: jest.fn().mockReturnValue(instance) } };
});

jest.mock('../utils/helpers', () => ({
  formatFileSize: jest.fn().mockReturnValue('1 KB'),
  formatRelativeTime: jest.fn().mockReturnValue('just now'),
  formatDateTime: jest.fn().mockReturnValue('2026-01-01 00:00'),
}));

// --- Import after mocks ---

import {
  FileTreeProvider,
  FileTreeItem,
  ConnectionTreeItem,
  LoadingTreeItem,
  LoadErrorTreeItem,
} from './FileTreeProvider';

/** Let the background loadDirectory promise chain settle (a few microtask hops). */
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('FileTreeProvider — issue #13: failed directory load must not loop', () => {
  let provider: FileTreeProvider;
  let mockConn: ReturnType<typeof createMockConnection>;
  let connItem: ConnectionTreeItem;

  beforeEach(() => {
    mockGetConnection.mockReset();
    mockGetAllConnections.mockReset().mockReturnValue([]);
    mockGetAllConnectionsWithReconnecting.mockReset().mockReturnValue({ active: [], reconnecting: [] });
    mockStartActivity.mockReset().mockReturnValue('activity-1');
    mockCompleteActivity.mockReset();
    mockFailActivity.mockReset();
    mockCancelActivity.mockReset();
    mockRecordVisit.mockReset();
    mockGetFrequentFolders.mockReset().mockReturnValue([]);
    mockGetPreloadTargets.mockReset().mockReturnValue([]);
    mockIsPreloadingInProgress.mockReset().mockReturnValue(false);
    mockIsConnectionCancelled.mockReset().mockReturnValue(false);
    mockGetStatus.mockReset().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0, byPriority: {} });
    (vscode.window.showErrorMessage as jest.Mock).mockClear();
    provider = new FileTreeProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  /** Connect a failing mock connection, navigate to '/', and drive the first failed load. */
  async function setupFailingRoot(): Promise<void> {
    mockConn = createMockConnection({ id: 'conn-1' });
    mockConn.listFiles.mockRejectedValue(new Error('Permission denied'));
    mockGetConnection.mockReturnValue(mockConn);
    mockGetAllConnections.mockReturnValue([mockConn]);
    mockGetAllConnectionsWithReconnecting.mockReturnValue({ active: [mockConn], reconnecting: [] });

    provider.setCurrentPath('conn-1', '/'); // user clicks the root icon
    await flushAsync(); // ignored preload settles

    const rootItems = await provider.getChildren();
    connItem = rootItems[0] as ConnectionTreeItem;
    expect(connItem).toBeInstanceOf(ConnectionTreeItem);

    // First getChildren starts the load and shows the loading placeholder
    const first = await provider.getChildren(connItem);
    expect(first[0]).toBeInstanceOf(LoadingTreeItem);
    await flushAsync(); // background load fails here
  }

  it('renders an error item instead of retrying after the load fails', async () => {
    await setupFailingRoot();

    const callsAfterFailure = mockConn.listFiles.mock.calls.length;

    // The failure fires a refresh; VS Code re-enters getChildren — repeatedly
    // in the buggy version. It must render the error item and NOT reload.
    for (let i = 0; i < 5; i++) {
      const children = await provider.getChildren(connItem);
      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(LoadErrorTreeItem);
      await flushAsync();
    }

    expect(mockConn.listFiles.mock.calls.length).toBe(callsAfterFailure);
  });

  it('shows the failure notification exactly once, not in a loop', async () => {
    await setupFailingRoot();

    for (let i = 0; i < 5; i++) {
      await provider.getChildren(connItem);
      await flushAsync();
    }

    const errorCalls = (vscode.window.showErrorMessage as jest.Mock).mock.calls
      .filter((c) => String(c[0]).startsWith('Failed to list directory'));
    expect(errorCalls).toHaveLength(1);
  });

  it('retries after an explicit refreshFolder (refresh button)', async () => {
    await setupFailingRoot();
    const callsAfterFailure = mockConn.listFiles.mock.calls.length;

    mockConn.listFiles.mockResolvedValue([
      createMockRemoteFile('etc', { path: '/etc', isDirectory: true, connectionId: 'conn-1' }),
    ]);
    provider.refreshFolder('conn-1', '/');

    const retrying = await provider.getChildren(connItem);
    expect(retrying[0]).toBeInstanceOf(LoadingTreeItem);
    await flushAsync();

    expect(mockConn.listFiles.mock.calls.length).toBeGreaterThan(callsAfterFailure);
    const loaded = await provider.getChildren(connItem);
    expect(loaded.some((i) => i instanceof LoadErrorTreeItem)).toBe(false);
    expect(loaded.some((i) => i instanceof FileTreeItem)).toBe(true);
  });

  it('retries after navigating again (setCurrentPath clears the failure)', async () => {
    await setupFailingRoot();

    provider.setCurrentPath('conn-1', '/'); // user clicks the root icon again
    await flushAsync();

    const children = await provider.getChildren(connItem);
    // Failure cleared: the tree starts loading again instead of showing the stale error
    expect(children[0]).not.toBeInstanceOf(LoadErrorTreeItem);
  });

  it('clearCache(connectionId) clears the failure (reconnect path)', async () => {
    await setupFailingRoot();

    provider.clearCache('conn-1');

    const children = await provider.getChildren(connItem);
    expect(children[0]).toBeInstanceOf(LoadingTreeItem);
  });

  it('refreshItem(connection) clears EVERY failed subfolder, not just the current path', async () => {
    // Two different folders fail; the connection-level refresh button must
    // un-stick both, otherwise a previously-expanded failed folder stays
    // stuck on its error item.
    mockConn = createMockConnection({ id: 'conn-1' });
    mockConn.listFiles.mockRejectedValue(new Error('Permission denied'));
    mockGetConnection.mockReturnValue(mockConn);
    mockGetAllConnections.mockReturnValue([mockConn]);
    mockGetAllConnectionsWithReconnecting.mockReturnValue({ active: [mockConn], reconnecting: [] });

    const rootItems = await provider.getChildren();
    connItem = rootItems[0] as ConnectionTreeItem;

    // Fail a subfolder /a
    const folderA = createMockRemoteFile('a', { path: '/a', isDirectory: true, connectionId: 'conn-1' });
    const itemA = new FileTreeItem(folderA, mockConn as any, false, false, false, false);
    await provider.getChildren(itemA);
    await flushAsync();
    // Fail the connection's current path too
    await provider.getChildren(connItem);
    await flushAsync();

    expect((await provider.getChildren(itemA))[0]).toBeInstanceOf(LoadErrorTreeItem);

    // Connection-level refresh button
    provider.refreshItem(connItem);

    // Both the connection root AND the previously-failed subfolder retry
    mockConn.listFiles.mockResolvedValue([]);
    expect((await provider.getChildren(itemA))[0]).toBeInstanceOf(LoadingTreeItem);
  });

  it('folder expand: failed subfolder load renders an error item and does not loop', async () => {
    mockConn = createMockConnection({ id: 'conn-1' });
    mockConn.listFiles.mockImplementation(async (remotePath: string) => {
      if (remotePath === '/restricted') {
        throw new Error('Permission denied');
      }
      return [];
    });
    mockGetConnection.mockReturnValue(mockConn);
    mockGetAllConnections.mockReturnValue([mockConn]);
    mockGetAllConnectionsWithReconnecting.mockReturnValue({ active: [mockConn], reconnecting: [] });

    const folder = createMockRemoteFile('restricted', {
      path: '/restricted',
      isDirectory: true,
      connectionId: 'conn-1',
    });
    const folderItem = new FileTreeItem(folder, mockConn as any, false, false, false, false);

    const first = await provider.getChildren(folderItem);
    expect(first[0]).toBeInstanceOf(LoadingTreeItem);
    await flushAsync();

    const callsAfterFailure = mockConn.listFiles.mock.calls.length;
    for (let i = 0; i < 5; i++) {
      const children = await provider.getChildren(folderItem);
      expect(children[0]).toBeInstanceOf(LoadErrorTreeItem);
      await flushAsync();
    }
    expect(mockConn.listFiles.mock.calls.length).toBe(callsAfterFailure);
  });
});
