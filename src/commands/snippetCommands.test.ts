/**
 * snippetCommands tests
 *
 * Covers:
 *  - runSnippet: no connections, cancelled pick, runs snippet + shows output
 *  - addSnippet: cancelled name/command, saves snippet
 *  - manageSnippets: no user snippets info, delete/rename/update flows
 */

import * as vscode from 'vscode';

var mockGetAllConnections = jest.fn().mockReturnValue([]);

jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: {
    getInstance: jest.fn().mockImplementation(() => ({
      getAllConnections: mockGetAllConnections,
    })),
  },
}));

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

import { registerSnippetCommands } from './snippetCommands';
import { ToolsContext } from './sshToolsCommands';
import { resetWindowMocks } from '../__mocks__/vscode';

beforeEach(() => resetWindowMocks());

function makeOutputChannel() {
  return { appendLine: jest.fn(), show: jest.fn() } as unknown as vscode.OutputChannel;
}
function makeContext(outputChannel = makeOutputChannel()): ToolsContext {
  return { log: jest.fn(), logResult: jest.fn(), envProvider: {} as any, cronProvider: {} as any, outputChannel };
}
function makeConn(id: string, name: string, execResult = '') {
  return { id, state: 'connected', host: { name, host: name, port: 22, username: 'u' }, exec: jest.fn().mockResolvedValue(execResult) };
}

describe('runSnippet', () => {
  let disposables: vscode.Disposable[];
  let ctx: ToolsContext;

  beforeEach(() => { jest.clearAllMocks(); ctx = makeContext(); disposables = registerSnippetCommands(ctx); });
  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('returns early when no connections', async () => {
    mockGetAllConnections.mockReturnValue([]);
    await vscode.commands.executeCommand('sshLite.runSnippet');
    expect(vscode.window.showQuickPick).not.toHaveBeenCalled();
  });

  it('returns early when snippet QuickPick is cancelled', async () => {
    const conn = makeConn('a', 'A');
    mockGetAllConnections.mockReturnValue([conn]);
    mockGetAll.mockReturnValue([{ id: 'b1', name: 'Disk', command: 'df -h', builtin: true }]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.runSnippet');
    expect(conn.exec).not.toHaveBeenCalled();
  });

  it('executes snippet and shows output', async () => {
    const conn = makeConn('a', 'A', 'Filesystem 100G');
    mockGetAllConnections.mockReturnValue([conn]);
    const snip = { id: 'b1', name: 'Disk usage', command: 'df -h', builtin: true };
    mockGetAll.mockReturnValue([snip]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ snip });
    await vscode.commands.executeCommand('sshLite.runSnippet');
    expect(conn.exec).toHaveBeenCalledWith('df -h');
    expect(ctx.outputChannel.show).toHaveBeenCalled();
    expect(ctx.logResult).toHaveBeenCalledWith('runSnippet', true, snip.name);
  });

  it('shows error message on exec failure', async () => {
    const conn = makeConn('a', 'A');
    conn.exec.mockRejectedValueOnce(new Error('connection lost'));
    mockGetAllConnections.mockReturnValue([conn]);
    const snip = { id: 'b1', name: 'Disk', command: 'df', builtin: true };
    mockGetAll.mockReturnValue([snip]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce({ snip });
    await vscode.commands.executeCommand('sshLite.runSnippet');
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });
});

describe('addSnippet', () => {
  let disposables: vscode.Disposable[];

  beforeEach(() => { jest.clearAllMocks(); disposables = registerSnippetCommands(makeContext()); });
  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('returns early when name is cancelled', async () => {
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.addSnippet');
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('returns early when command is cancelled', async () => {
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('My snippet')
      .mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.addSnippet');
    expect(mockAdd).not.toHaveBeenCalled();
  });

  it('calls SnippetService.add with name and command', async () => {
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('Top procs')
      .mockResolvedValueOnce('ps aux | head');
    await vscode.commands.executeCommand('sshLite.addSnippet');
    expect(mockAdd).toHaveBeenCalledWith('Top procs', 'ps aux | head');
  });
});

describe('manageSnippets', () => {
  let disposables: vscode.Disposable[];

  beforeEach(() => { jest.clearAllMocks(); disposables = registerSnippetCommands(makeContext()); });
  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('shows info when no user snippets', async () => {
    mockGetUserSnippets.mockReturnValue([]);
    await vscode.commands.executeCommand('sshLite.manageSnippets');
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });

  it('deletes a snippet when Delete is selected', async () => {
    const snip = { id: 'u-1', name: 'My cmd', command: 'ls' };
    mockGetUserSnippets.mockReturnValue([snip]);
    (vscode.window.showQuickPick as jest.Mock)
      .mockResolvedValueOnce({ snip })
      .mockResolvedValueOnce('Delete');
    await vscode.commands.executeCommand('sshLite.manageSnippets');
    expect(mockRemove).toHaveBeenCalledWith('u-1');
  });

  it('renames a snippet when Rename is selected', async () => {
    const snip = { id: 'u-1', name: 'Old name', command: 'ls' };
    mockGetUserSnippets.mockReturnValue([snip]);
    (vscode.window.showQuickPick as jest.Mock)
      .mockResolvedValueOnce({ snip })
      .mockResolvedValueOnce('Rename');
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('New name');
    await vscode.commands.executeCommand('sshLite.manageSnippets');
    expect(mockRename).toHaveBeenCalledWith('u-1', 'New name');
  });

  it('updates command when Edit Command is selected', async () => {
    const snip = { id: 'u-1', name: 'df', command: 'df -h' };
    mockGetUserSnippets.mockReturnValue([snip]);
    (vscode.window.showQuickPick as jest.Mock)
      .mockResolvedValueOnce({ snip })
      .mockResolvedValueOnce('Edit Command');
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('df -h /');
    await vscode.commands.executeCommand('sshLite.manageSnippets');
    expect(mockUpdate).toHaveBeenCalledWith('u-1', 'df -h /');
  });
});
