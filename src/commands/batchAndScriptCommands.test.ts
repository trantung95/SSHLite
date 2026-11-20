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
    exec: jest.fn().mockResolvedValue(''),
    execWithExitCode: jest.fn().mockResolvedValue({ stdout: 'output from ' + name, stderr: '', code: 0 }),
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
    expect(c1.execWithExitCode).not.toHaveBeenCalled();
    expect(c2.execWithExitCode).not.toHaveBeenCalled();
  });

  it('runs command on all hosts after confirmation and shows output', async () => {
    const c1 = makeConn('a', 'Alpha'); const c2 = makeConn('b', 'Beta');
    mockGetAllConnections.mockReturnValue([c1, c2]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce([{ conn: c1 }, { conn: c2 }]);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('uptime');
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Run');
    await vscode.commands.executeCommand('sshLite.batchRun');
    expect(c1.execWithExitCode).toHaveBeenCalledWith('uptime');
    expect(c2.execWithExitCode).toHaveBeenCalledWith('uptime');
    expect(ctx.outputChannel.show).toHaveBeenCalled();
  });

  it('reports a non-zero exit with empty stderr as FAILED with the exit code', async () => {
    const c1 = makeConn('a', 'Alpha'); const c2 = makeConn('b', 'Beta');
    c1.execWithExitCode.mockResolvedValue({ stdout: '', stderr: '', code: 1 });
    mockGetAllConnections.mockReturnValue([c1, c2]);
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce([{ conn: c1 }, { conn: c2 }]);
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('grep x f');
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Run');
    await vscode.commands.executeCommand('sshLite.batchRun');
    const lines = (ctx.outputChannel.appendLine as jest.Mock).mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('[Alpha]') && l.includes('FAILED') && l.includes('exit code 1'))).toBe(true);
    expect(lines.some((l) => l.includes('[Beta]') && !l.includes('FAILED'))).toBe(true);
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
    expect(conn.exec).toHaveBeenCalledTimes(1); // chmod
    expect(conn.execWithExitCode).toHaveBeenCalledTimes(1); // run
    expect(conn.deleteFile).toHaveBeenCalled();
    expect(ctx.outputChannel.show).toHaveBeenCalled();
  });

  function setupScript(bytes: Buffer, run: { stdout: string; stderr: string; code: number }) {
    const conn = makeConn('a', 'A');
    conn.execWithExitCode.mockResolvedValue(run);
    mockGetAllConnections.mockReturnValue([conn]);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([{ fsPath: '/local/test.sh' }]);
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(bytes);
    return conn;
  }
  const outLines = () => (ctx.outputChannel.appendLine as jest.Mock).mock.calls.map((c) => String(c[0]));

  it('reports a non-zero exit code with empty stderr as a failure and still deletes the temp file', async () => {
    const conn = setupScript(Buffer.from('#!/bin/sh\nexit 3\n'), { stdout: 'partial\n', stderr: '', code: 3 });
    await vscode.commands.executeCommand('sshLite.runLocalScriptRemote');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('exit code 3'));
    expect(ctx.logResult).toHaveBeenCalledWith('runLocalScriptRemote', false, expect.stringContaining('3'));
    expect(conn.deleteFile).toHaveBeenCalled();
  });

  it('shows stderr in the output channel when the script exits 0', async () => {
    setupScript(Buffer.from('#!/bin/sh\n'), { stdout: 'to-stdout\n', stderr: 'to-stderr\n', code: 0 });
    await vscode.commands.executeCommand('sshLite.runLocalScriptRemote');
    const text = outLines().join('\n');
    expect(text).toContain('to-stdout');
    expect(text).toContain('to-stderr');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
  });

  it('normalizes CRLF to LF before upload for text scripts', async () => {
    const conn = setupScript(Buffer.from('#!/bin/sh\r\necho hi\r\n'), { stdout: 'hi\n', stderr: '', code: 0 });
    await vscode.commands.executeCommand('sshLite.runLocalScriptRemote');
    const uploaded = conn.writeFile.mock.calls[0][1] as Buffer;
    expect(uploaded.toString()).toBe('#!/bin/sh\necho hi\n');
  });

  it('does not touch binary content (NUL byte) containing CRLF', async () => {
    const bin = Buffer.from([0x7f, 0x45, 0x00, 0x0d, 0x0a, 0x01]);
    const conn = setupScript(bin, { stdout: '', stderr: '', code: 0 });
    await vscode.commands.executeCommand('sshLite.runLocalScriptRemote');
    expect((conn.writeFile.mock.calls[0][1] as Buffer).equals(bin)).toBe(true);
  });
});
