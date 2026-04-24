/**
 * processAndServiceCommands tests
 *
 * Covers:
 *  - showRemoteProcesses: no connections, empty list, cancelled pick, kill confirm, kill cancel, kill error
 *  - manageRemoteService: no connections, empty list, cancelled service pick, action flows
 */

import * as vscode from 'vscode';

var mockGetAllConnections = jest.fn().mockReturnValue([]);
jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: { getInstance: jest.fn().mockImplementation(() => ({ getAllConnections: mockGetAllConnections })) },
}));

var mockListProcesses = jest.fn().mockResolvedValue([]);
var mockKillProcess = jest.fn().mockResolvedValue(undefined);
var mockListServices = jest.fn().mockResolvedValue([]);
var mockRunServiceAction = jest.fn().mockResolvedValue('');

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

import { registerProcessAndServiceCommands } from './processAndServiceCommands';
import { ToolsContext } from './sshToolsCommands';
import { resetWindowMocks } from '../__mocks__/vscode';

beforeEach(() => resetWindowMocks());

function makeCtx(): ToolsContext {
  return { log: jest.fn(), logResult: jest.fn(), envProvider: {} as any, cronProvider: {} as any, outputChannel: { appendLine: jest.fn(), show: jest.fn() } as any };
}
function makeConn(id = 'c1', name = 'box') {
  return { id, state: 'connected', host: { name, host: name, port: 22, username: 'u' }, sudoPassword: null };
}

function makeProcess(pid = 1234, command = 'nginx') {
  return { pid, user: 'root', cpu: 5.0, mem: 1.0, command };
}

describe('showRemoteProcesses', () => {
  let disposables: vscode.Disposable[];
  let ctx: ToolsContext;

  beforeEach(() => { jest.clearAllMocks(); ctx = makeCtx(); disposables = registerProcessAndServiceCommands(ctx); });
  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('returns early when no connections', async () => {
    mockGetAllConnections.mockReturnValue([]);
    await vscode.commands.executeCommand('sshLite.showRemoteProcesses');
    expect(mockListProcesses).not.toHaveBeenCalled();
  });

  it('shows info when process list is empty', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    mockListProcesses.mockResolvedValueOnce([]);
    await vscode.commands.executeCommand('sshLite.showRemoteProcesses', conn as any);
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });

  it('returns early when user cancels process QuickPick', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    mockListProcesses.mockResolvedValueOnce([makeProcess()]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.showRemoteProcesses', conn as any);
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('does not kill when user cancels confirmation', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    const proc = makeProcess(9999, 'badproc');
    mockListProcesses.mockResolvedValueOnce([proc]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ proc });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.showRemoteProcesses', conn as any);
    expect(mockKillProcess).not.toHaveBeenCalled();
  });

  it('calls killProcess when Kill is confirmed', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    const proc = makeProcess(9999, 'badproc');
    mockListProcesses.mockResolvedValueOnce([proc]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ proc });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Kill');
    await vscode.commands.executeCommand('sshLite.showRemoteProcesses', conn as any);
    expect(mockKillProcess).toHaveBeenCalledWith(conn, 9999, false);
    expect(ctx.logResult).toHaveBeenCalledWith('showRemoteProcesses', true, 'killed 9999');
  });

  it('calls killProcess with useSudo=true when Kill (sudo) is confirmed', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    const proc = makeProcess(1, 'init');
    mockListProcesses.mockResolvedValueOnce([proc]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ proc });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Kill (sudo)');
    await vscode.commands.executeCommand('sshLite.showRemoteProcesses', conn as any);
    expect(mockKillProcess).toHaveBeenCalledWith(conn, 1, true);
  });

  it('shows error when kill throws', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    const proc = makeProcess(1234, 'nginx');
    mockListProcesses.mockResolvedValueOnce([proc]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ proc });
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Kill');
    mockKillProcess.mockRejectedValueOnce(new Error('operation not permitted'));
    await vscode.commands.executeCommand('sshLite.showRemoteProcesses', conn as any);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });
});

describe('manageRemoteService', () => {
  let disposables: vscode.Disposable[];
  let ctx: ToolsContext;

  beforeEach(() => { jest.clearAllMocks(); ctx = makeCtx(); disposables = registerProcessAndServiceCommands(ctx); });
  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('shows info when service list is empty', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    mockListServices.mockResolvedValueOnce([]);
    await vscode.commands.executeCommand('sshLite.manageRemoteService', conn as any);
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });

  it('runs systemctl restart and shows output', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    const svc = { name: 'nginx.service', active: 'active', sub: 'running', load: 'loaded', description: 'Nginx' };
    mockListServices.mockResolvedValueOnce([svc]);
    (vscode.window.showQuickPick as jest.Mock)
      .mockResolvedValueOnce({ svc })
      .mockResolvedValueOnce({ label: 'Restart', value: 'restart' });
    mockRunServiceAction.mockResolvedValueOnce('');
    await vscode.commands.executeCommand('sshLite.manageRemoteService', conn as any);
    expect(mockRunServiceAction).toHaveBeenCalledWith(conn, 'nginx.service', 'restart', true);
    expect(ctx.outputChannel.show).toHaveBeenCalled();
  });
});
