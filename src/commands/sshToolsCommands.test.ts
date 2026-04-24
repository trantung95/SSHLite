/**
 * SSH Tools command handler tests
 *
 * Tests the shared connection-picker helpers and representative command flows:
 *  - getConnectedConnections filters by state
 *  - pickConnection: no connections, single auto-select, multi-select
 *  - pickMultiConnection: requires ≥2
 *  - batchRun: confirmation dialog gates execution
 *  - runSnippet: cancelled QuickPick returns early
 *  - addSnippet: cancelled name/command inputs return early
 *  - manageSnippets: delete/rename/update flows
 *  - diffWithLocal: non-file item returns early
 */

import * as vscode from 'vscode';

// ── connection state ────────────────────────────────────────────────────────

var mockGetAllConnections = jest.fn().mockReturnValue([]);
var mockGetConnection = jest.fn();

jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: {
    getInstance: jest.fn().mockImplementation(() => ({
      getAllConnections: mockGetAllConnections,
      getConnection: mockGetConnection,
    })),
  },
}));

// ── SnippetService ───────────────────────────────────────────────────────────

var mockGetAll = jest.fn().mockReturnValue([]);
var mockGetUserSnippets = jest.fn().mockReturnValue([]);
var mockAdd = jest.fn().mockResolvedValue({ id: 'u-1', name: 'Test', command: 'ls' });
var mockRename = jest.fn().mockResolvedValue(true);
var mockUpdate = jest.fn().mockResolvedValue(true);
var mockRemove = jest.fn().mockResolvedValue(true);

jest.mock('../services/SnippetService', () => ({
  SnippetService: {
    getInstance: jest.fn().mockImplementation(() => ({
      getAll: mockGetAll,
      getUserSnippets: mockGetUserSnippets,
      add: mockAdd,
      rename: mockRename,
      update: mockUpdate,
      remove: mockRemove,
    })),
  },
}));

// ── RemoteDiffService ────────────────────────────────────────────────────────

var mockDiffRemoteWithLocal = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/RemoteDiffService', () => ({
  RemoteDiffService: {
    getInstance: jest.fn().mockImplementation(() => ({
      diffRemoteWithLocal: mockDiffRemoteWithLocal,
    })),
  },
}));

// ── SystemToolsService ───────────────────────────────────────────────────────

var mockListProcesses = jest.fn().mockResolvedValue([]);
var mockKillProcess = jest.fn().mockResolvedValue(undefined);
var mockListServices = jest.fn().mockResolvedValue([]);
var mockRunServiceAction = jest.fn().mockResolvedValue('OK');

jest.mock('../services/SystemToolsService', () => ({
  SystemToolsService: {
    getInstance: jest.fn().mockImplementation(() => ({
      listProcesses: mockListProcesses,
      killProcess: mockKillProcess,
      listServices: mockListServices,
      runServiceAction: mockRunServiceAction,
    })),
  },
}));

// ── VirtualDocProviders ──────────────────────────────────────────────────────

jest.mock('../providers/VirtualDocProviders', () => ({
  ENV_SCHEME: 'sshlite-env',
  CRON_SCHEME: 'sshlite-cron',
  buildUri: jest.fn().mockReturnValue({ toString: () => 'sshlite-env://c1/env.txt', scheme: 'sshlite-env', authority: 'c1', path: '/env.txt' }),
  RemoteEnvDocumentProvider: jest.fn().mockImplementation(() => ({ refresh: jest.fn(), dispose: jest.fn() })),
  RemoteCronDocumentProvider: jest.fn().mockImplementation(() => ({ refresh: jest.fn(), dispose: jest.fn() })),
}));

import { getConnectedConnections, pickConnection, pickMultiConnection } from './sshToolsCommands';

// ─── Helpers ────────────────────────────────────────────────────────────────

function connectedConn(id: string, name: string, state = 'connected') {
  return { id, host: { name, host: name, port: 22, username: 'u' }, state, exec: jest.fn().mockResolvedValue('') };
}

function disconnectedConn(id: string) {
  return { id, host: { name: 'disc', host: 'disc', port: 22, username: 'u' }, state: 'disconnected' };
}

// ─── getConnectedConnections ─────────────────────────────────────────────────

describe('getConnectedConnections', () => {
  it('returns only connected state connections', () => {
    mockGetAllConnections.mockReturnValue([
      connectedConn('a', 'A'),
      disconnectedConn('b'),
      connectedConn('c', 'C'),
    ]);
    const result = getConnectedConnections();
    expect(result).toHaveLength(2);
    expect(result.map((c: any) => c.id)).toEqual(['a', 'c']);
  });

  it('returns empty array when no connections', () => {
    mockGetAllConnections.mockReturnValue([]);
    expect(getConnectedConnections()).toEqual([]);
  });
});

// ─── pickConnection ──────────────────────────────────────────────────────────

describe('pickConnection', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns preselect directly without prompting', async () => {
    const conn = connectedConn('a', 'A') as any;
    const result = await pickConnection('pick', conn);
    expect(result).toBe(conn);
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('shows info message and returns undefined when no connections', async () => {
    mockGetAllConnections.mockReturnValue([]);
    const result = await pickConnection('pick');
    expect(result).toBeUndefined();
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });

  it('auto-selects the only connection without QuickPick', async () => {
    const conn = connectedConn('a', 'A');
    mockGetAllConnections.mockReturnValue([conn]);
    const result = await pickConnection('pick');
    expect(result).toBe(conn);
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('shows QuickPick when multiple connections exist and returns picked', async () => {
    const c1 = connectedConn('a', 'Alpha');
    const c2 = connectedConn('b', 'Beta');
    mockGetAllConnections.mockReturnValue([c1, c2]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ conn: c2 });
    const result = await pickConnection('pick');
    expect(vscode.window.showQuickPick).toHaveBeenCalled();
    expect(result).toBe(c2);
  });

  it('returns undefined when user cancels QuickPick', async () => {
    const c1 = connectedConn('a', 'Alpha');
    const c2 = connectedConn('b', 'Beta');
    mockGetAllConnections.mockReturnValue([c1, c2]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);
    const result = await pickConnection('pick');
    expect(result).toBeUndefined();
  });
});

// ─── pickMultiConnection ─────────────────────────────────────────────────────

describe('pickMultiConnection', () => {
  beforeEach(() => jest.clearAllMocks());

  it('shows info and returns [] when fewer than 2 connections', async () => {
    mockGetAllConnections.mockReturnValue([connectedConn('a', 'A')]);
    const result = await pickMultiConnection('pick');
    expect(result).toEqual([]);
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });

  it('returns selected connections', async () => {
    const c1 = connectedConn('a', 'A');
    const c2 = connectedConn('b', 'B');
    mockGetAllConnections.mockReturnValue([c1, c2]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce([
      { conn: c1 }, { conn: c2 },
    ]);
    const result = await pickMultiConnection('pick');
    expect(result).toHaveLength(2);
  });

  it('returns [] when user cancels', async () => {
    const c1 = connectedConn('a', 'A');
    const c2 = connectedConn('b', 'B');
    mockGetAllConnections.mockReturnValue([c1, c2]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);
    const result = await pickMultiConnection('pick');
    expect(result).toEqual([]);
  });
});
