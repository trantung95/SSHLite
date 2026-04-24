/**
 * envAndCronCommands tests
 *
 * Covers:
 *  - showRemoteEnv: no connections, opens virtual doc, refreshes provider
 *  - editRemoteCron: no connections, opens virtual doc
 *  - saveRemoteCron: no active cron editor → error; active cron editor → writes crontab
 */

import * as vscode from 'vscode';

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

var mockEnvRefresh = jest.fn();
var mockCronRefresh = jest.fn();
var mockBuildUri = jest.fn().mockReturnValue({
  scheme: 'sshlite-env', authority: 'c1', path: '/env.txt', toString: () => 'sshlite-env://c1/env.txt',
});

jest.mock('../providers/VirtualDocProviders', () => ({
  ENV_SCHEME: 'sshlite-env',
  CRON_SCHEME: 'sshlite-cron',
  get buildUri() { return mockBuildUri; },
}));

import { registerEnvAndCronCommands } from './envAndCronCommands';
import { ToolsContext } from './sshToolsCommands';
import { resetWindowMocks } from '../__mocks__/vscode';

beforeEach(() => resetWindowMocks());

function makeCtx(): ToolsContext {
  return {
    log: jest.fn(),
    logResult: jest.fn(),
    envProvider: { refresh: mockEnvRefresh, dispose: jest.fn() } as any,
    cronProvider: { refresh: mockCronRefresh, dispose: jest.fn() } as any,
    outputChannel: { appendLine: jest.fn(), show: jest.fn() } as any,
  };
}
function makeConn(id = 'c1', name = 'box') {
  return { id, state: 'connected', host: { name, host: name, port: 22, username: 'u' }, exec: jest.fn().mockResolvedValue(''), writeFile: jest.fn().mockResolvedValue(undefined), deleteFile: jest.fn().mockResolvedValue(undefined) };
}

describe('showRemoteEnv', () => {
  let disposables: vscode.Disposable[];

  beforeEach(() => { jest.clearAllMocks(); disposables = registerEnvAndCronCommands(makeCtx()); });
  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('returns early when no connections', async () => {
    mockGetAllConnections.mockReturnValue([]);
    await vscode.commands.executeCommand('sshLite.showRemoteEnv');
    expect(mockEnvRefresh).not.toHaveBeenCalled();
  });

  it('refreshes env provider and opens document', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    await vscode.commands.executeCommand('sshLite.showRemoteEnv', conn as any);
    expect(mockEnvRefresh).toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
    expect(vscode.window.showTextDocument).toHaveBeenCalled();
  });
});

describe('editRemoteCron', () => {
  let disposables: vscode.Disposable[];

  beforeEach(() => { jest.clearAllMocks(); disposables = registerEnvAndCronCommands(makeCtx()); });
  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('returns early when no connections', async () => {
    mockGetAllConnections.mockReturnValue([]);
    await vscode.commands.executeCommand('sshLite.editRemoteCron');
    expect(mockCronRefresh).not.toHaveBeenCalled();
  });

  it('refreshes cron provider and opens document', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    await vscode.commands.executeCommand('sshLite.editRemoteCron', conn as any);
    expect(mockCronRefresh).toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).toHaveBeenCalled();
  });
});

describe('saveRemoteCron', () => {
  let disposables: vscode.Disposable[];

  beforeEach(() => { jest.clearAllMocks(); disposables = registerEnvAndCronCommands(makeCtx()); });
  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('shows error when no active cron editor', async () => {
    (vscode.window as any).activeTextEditor = undefined;
    await vscode.commands.executeCommand('sshLite.saveRemoteCron');
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it('shows error when active editor is not a cron document', async () => {
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: 'file', authority: '' }, getText: jest.fn().mockReturnValue('') },
    };
    await vscode.commands.executeCommand('sshLite.saveRemoteCron');
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(mockGetConnection).not.toHaveBeenCalled();
  });

  it('shows error when connection is no longer active', async () => {
    (vscode.window as any).activeTextEditor = {
      document: { uri: { scheme: 'sshlite-cron', authority: encodeURIComponent('gone-conn') }, getText: jest.fn().mockReturnValue('') },
    };
    mockGetConnection.mockReturnValue(undefined);
    await vscode.commands.executeCommand('sshLite.saveRemoteCron');
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });
});
