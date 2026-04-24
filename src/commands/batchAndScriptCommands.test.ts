/**
 * batchAndScriptCommands tests
 *
 * Covers:
 *  - batchRun: returns early when no connections / cancelled / no command / declined confirmation
 *  - batchRun: runs on all hosts, shows output channel
 *  - runLocalScriptRemote: returns early when no connection / no file picked / file missing
 */

import * as vscode from 'vscode';
import * as fs from 'fs';

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

jest.mock('fs', () => ({ existsSync: jest.fn(), readFileSync: jest.fn() }));
jest.mock('path', () => ({
  extname: jest.fn().mockReturnValue('.sh'),
  basename: jest.fn().mockReturnValue('test.sh'),
  dirname: jest.fn().mockReturnValue('/tmp'),
}));

import { registerBatchAndScriptCommands } from './batchAndScriptCommands';
import { ToolsContext } from './sshToolsCommands';
import { resetWindowMocks } from '../__mocks__/vscode';

beforeEach(() => resetWindowMocks());

function makeOutputChannel() {
  return {
    appendLine: jest.fn(),
    show: jest.fn(),
  } as unknown as vscode.OutputChannel;
}

function makeContext(outputChannel = makeOutputChannel()): ToolsContext {
  return {
    log: jest.fn(),
    logResult: jest.fn(),
    envProvider: {} as any,
    cronProvider: {} as any,
    outputChannel,
  };
}

function makeConn(id: string, name: string) {
  return {
    id, state: 'connected',
    host: { name, host: name, port: 22, username: 'u' },
    exec: jest.fn().mockResolvedValue('output from ' + name),
    writeFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
  };
}

describe('batchRun command', () => {
  let disposables: vscode.Disposable[];
  let ctx: ToolsContext;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = makeContext();
    disposables = registerBatchAndScriptCommands(ctx);
  });

  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('returns early when fewer than 2 connections', async () => {
    mockGetAllConnections.mockReturnValue([makeConn('a', 'A')]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.batchRun');
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it('returns early when user cancels connection picker', async () => {
    mockGetAllConnections.mockReturnValue([makeConn('a', 'A'), makeConn('b', 'B')]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.batchRun');
    expect(vscode.window.showInputBox).not.toHaveBeenCalled();
  });

  it('returns early when user cancels command input', async () => {
    const c1 = makeConn('a', 'A'); const c2 = makeConn('b', 'B');
    mockGetAllConnections.mockReturnValue([c1, c2]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce([{ conn: c1 }, { conn: c2 }]);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.batchRun');
    expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
  });

  it('returns early when user declines confirmation', async () => {
    const c1 = makeConn('a', 'A'); const c2 = makeConn('b', 'B');
    mockGetAllConnections.mockReturnValue([c1, c2]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce([{ conn: c1 }, { conn: c2 }]);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('ls -la');
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.batchRun');
    expect(c1.exec).not.toHaveBeenCalled();
    expect(c2.exec).not.toHaveBeenCalled();
  });

  it('runs command on all hosts after confirmation and shows output', async () => {
    const c1 = makeConn('a', 'Alpha'); const c2 = makeConn('b', 'Beta');
    mockGetAllConnections.mockReturnValue([c1, c2]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce([{ conn: c1 }, { conn: c2 }]);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('uptime');
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Run');
    await vscode.commands.executeCommand('sshLite.batchRun');
    expect(c1.exec).toHaveBeenCalledWith('uptime');
    expect(c2.exec).toHaveBeenCalledWith('uptime');
    expect(ctx.outputChannel.show).toHaveBeenCalled();
  });

  it('confirmation dialog includes command + host names + count', async () => {
    const c1 = makeConn('a', 'Alpha'); const c2 = makeConn('b', 'Beta');
    mockGetAllConnections.mockReturnValue([c1, c2]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce([{ conn: c1 }, { conn: c2 }]);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('df -h');
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.batchRun');
    const msg = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0] as string;
    expect(msg).toContain('df -h');
    expect(msg).toContain('2 hosts');
    expect(msg).toContain('Alpha');
    expect(msg).toContain('Beta');
  });
});

describe('runLocalScriptRemote command', () => {
  let disposables: vscode.Disposable[];
  let ctx: ToolsContext;

  beforeEach(() => {
    jest.clearAllMocks();
    ctx = makeContext();
    disposables = registerBatchAndScriptCommands(ctx);
  });

  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('returns early when no connections', async () => {
    mockGetAllConnections.mockReturnValue([]);
    await vscode.commands.executeCommand('sshLite.runLocalScriptRemote');
    expect(vscode.window.showOpenDialog).not.toHaveBeenCalled();
  });

  it('returns early when no file is picked', async () => {
    mockGetAllConnections.mockReturnValue([makeConn('a', 'A')]);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.runLocalScriptRemote');
    expect((fs.existsSync as jest.Mock)).not.toHaveBeenCalled();
  });

  it('shows error when local file does not exist', async () => {
    const conn = makeConn('a', 'A');
    mockGetAllConnections.mockReturnValue([conn]);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([{ fsPath: '/missing/script.sh' }]);
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    await vscode.commands.executeCommand('sshLite.runLocalScriptRemote');
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it('uploads, executes, and deletes temp file on success', async () => {
    const conn = makeConn('a', 'A');
    mockGetAllConnections.mockReturnValue([conn]);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([{ fsPath: '/local/test.sh' }]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('#!/bin/bash\necho hello'));
    await vscode.commands.executeCommand('sshLite.runLocalScriptRemote');
    expect(conn.writeFile).toHaveBeenCalled();
    expect(conn.exec).toHaveBeenCalledTimes(2); // chmod + run
    expect(conn.deleteFile).toHaveBeenCalled();
    expect(ctx.outputChannel.show).toHaveBeenCalled();
  });
});
