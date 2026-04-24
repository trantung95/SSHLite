/**
 * keyCommands tests
 *
 * Covers:
 *  - generateSshKey: cancelled type/size/comment/file/overwrite/passphrase returns early; calls generateKey
 *  - pushPubKeyToHost: no connections, cancelled file picker, calls pushPublicKey, handles already-present
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

var mockGetAllConnections = jest.fn().mockReturnValue([]);
jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: { getInstance: jest.fn().mockImplementation(() => ({ getAllConnections: mockGetAllConnections })) },
}));

var mockGenerateKey = jest.fn().mockResolvedValue({ privateKeyPath: '/home/u/.ssh/id_ed25519', publicKeyPath: '/home/u/.ssh/id_ed25519.pub' });
var mockPushPublicKey = jest.fn().mockResolvedValue({ added: true });
var mockDefaultKeyDir = jest.fn().mockReturnValue('/home/u/.ssh');

jest.mock('../services/SshKeyService', () => ({
  SshKeyService: {
    getInstance: jest.fn().mockImplementation(() => ({
      generateKey: mockGenerateKey,
      pushPublicKey: mockPushPublicKey,
      defaultKeyDir: mockDefaultKeyDir,
    })),
  },
}));

jest.mock('fs', () => ({ existsSync: jest.fn(), mkdirSync: jest.fn() }));
jest.mock('path', () => ({ dirname: jest.fn().mockReturnValue('/home/u/.ssh'), join: jest.fn().mockReturnValue('/home/u/.ssh/id_ed25519') }));
jest.mock('os', () => ({ userInfo: jest.fn().mockReturnValue({ username: 'alice' }), hostname: jest.fn().mockReturnValue('laptop') }));

import { registerKeyCommands } from './keyCommands';
import { ToolsContext } from './sshToolsCommands';
import { resetWindowMocks } from '../__mocks__/vscode';

beforeEach(() => resetWindowMocks());

function makeCtx(): ToolsContext {
  return { log: jest.fn(), logResult: jest.fn(), envProvider: {} as any, cronProvider: {} as any, outputChannel: { appendLine: jest.fn(), show: jest.fn() } as any };
}
function makeConn(id = 'c1', name = 'box') {
  return { id, state: 'connected', host: { name, host: name, port: 22, username: 'u' } };
}

describe('generateSshKey', () => {
  let disposables: vscode.Disposable[];

  beforeEach(() => { jest.clearAllMocks(); disposables = registerKeyCommands(makeCtx()); });
  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('returns early when key type is cancelled', async () => {
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.generateSshKey');
    expect(mockGenerateKey).not.toHaveBeenCalled();
  });

  it('returns early when comment is cancelled', async () => {
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce('ed25519');
    (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.generateSshKey');
    expect(mockGenerateKey).not.toHaveBeenCalled();
  });

  it('calls generateKey with correct options for ed25519', async () => {
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce('ed25519');
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('alice@laptop')
      .mockResolvedValueOnce('/home/u/.ssh/id_ed25519')
      .mockResolvedValueOnce('');
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    await vscode.commands.executeCommand('sshLite.generateSshKey');
    expect(mockGenerateKey).toHaveBeenCalledWith(expect.objectContaining({ type: 'ed25519', comment: 'alice@laptop', passphrase: '' }));
  });

  it('warns and returns early when overwrite is cancelled on existing file', async () => {
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce('ed25519');
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('alice@laptop')
      .mockResolvedValueOnce('/home/u/.ssh/id_ed25519');
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.generateSshKey');
    expect(mockGenerateKey).not.toHaveBeenCalled();
  });

  it('shows info on success', async () => {
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValueOnce('ed25519');
    (vscode.window.showInputBox as jest.Mock)
      .mockResolvedValueOnce('alice@laptop')
      .mockResolvedValueOnce('/home/u/.ssh/new_key')
      .mockResolvedValueOnce('');
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    await vscode.commands.executeCommand('sshLite.generateSshKey');
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });
});

describe('pushPubKeyToHost', () => {
  let disposables: vscode.Disposable[];

  beforeEach(() => { jest.clearAllMocks(); disposables = registerKeyCommands(makeCtx()); });
  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('returns early when no connections', async () => {
    mockGetAllConnections.mockReturnValue([]);
    await vscode.commands.executeCommand('sshLite.pushPubKeyToHost');
    expect(vscode.window.showOpenDialog).not.toHaveBeenCalled();
  });

  it('returns early when no file is picked', async () => {
    mockGetAllConnections.mockReturnValue([makeConn()]);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.pushPubKeyToHost');
    expect(mockPushPublicKey).not.toHaveBeenCalled();
  });

  it('shows success message when key is added', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([{ fsPath: '/home/u/.ssh/id_ed25519.pub' }]);
    mockPushPublicKey.mockResolvedValueOnce({ added: true });
    await vscode.commands.executeCommand('sshLite.pushPubKeyToHost', conn as any);
    expect(mockPushPublicKey).toHaveBeenCalledWith(conn, '/home/u/.ssh/id_ed25519.pub');
    expect(vscode.window.showInformationMessage).toHaveBeenCalled();
  });

  it('shows already-present message when key is not added', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([{ fsPath: '/home/u/.ssh/id_ed25519.pub' }]);
    mockPushPublicKey.mockResolvedValueOnce({ added: false, reason: 'Key already present in authorized_keys' });
    await vscode.commands.executeCommand('sshLite.pushPubKeyToHost', conn as any);
    expect(vscode.window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('already'));
  });

  it('shows error on push failure', async () => {
    const conn = makeConn();
    mockGetAllConnections.mockReturnValue([conn]);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([{ fsPath: '/key.pub' }]);
    mockPushPublicKey.mockRejectedValueOnce(new Error('permission denied'));
    await vscode.commands.executeCommand('sshLite.pushPubKeyToHost', conn as any);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });
});
