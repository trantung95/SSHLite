/**
 * diffCommand tests
 *
 * Covers:
 *  - Returns early when no item / non-file / no local file picked
 *  - Calls RemoteDiffService.diffRemoteWithLocal with correct args
 *  - Shows error message on failure
 */

import * as vscode from 'vscode';

jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: { getInstance: jest.fn().mockImplementation(() => ({})) },
}));

var mockDiffRemoteWithLocal = jest.fn().mockResolvedValue(undefined);
jest.mock('../services/RemoteDiffService', () => ({
  RemoteDiffService: { getInstance: jest.fn().mockImplementation(() => ({ diffRemoteWithLocal: mockDiffRemoteWithLocal })) },
}));

import { registerDiffCommand } from './diffCommand';
import { ToolsContext } from './sshToolsCommands';

function makeCtx(): ToolsContext {
  return { log: jest.fn(), logResult: jest.fn(), envProvider: {} as any, cronProvider: {} as any, outputChannel: { appendLine: jest.fn(), show: jest.fn() } as any };
}
function makeItem(isDirectory = false) {
  return { connection: { id: 'c1', host: { name: 'box' } }, file: { path: '/etc/motd', isDirectory } };
}

describe('diffWithLocal', () => {
  let disposables: vscode.Disposable[];
  let ctx: ToolsContext;

  beforeEach(() => { jest.clearAllMocks(); ctx = makeCtx(); disposables = registerDiffCommand(ctx); });
  afterEach(() => disposables.forEach((d) => d.dispose()));

  it('shows error when item is undefined', async () => {
    await vscode.commands.executeCommand('sshLite.diffWithLocal', undefined);
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
  });

  it('shows error when item is a directory', async () => {
    await vscode.commands.executeCommand('sshLite.diffWithLocal', makeItem(true));
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(vscode.window.showOpenDialog).not.toHaveBeenCalled();
  });

  it('returns early when no local file is picked', async () => {
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce(undefined);
    await vscode.commands.executeCommand('sshLite.diffWithLocal', makeItem());
    expect(mockDiffRemoteWithLocal).not.toHaveBeenCalled();
  });

  it('calls diffRemoteWithLocal with correct paths', async () => {
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([{ fsPath: '/local/motd' }]);
    await vscode.commands.executeCommand('sshLite.diffWithLocal', makeItem());
    expect(mockDiffRemoteWithLocal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'c1' }),
      '/etc/motd',
      '/local/motd'
    );
    expect(ctx.logResult).toHaveBeenCalledWith('diffWithLocal', true, '/etc/motd');
  });

  it('shows error and logs failure when diff throws', async () => {
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([{ fsPath: '/local/motd' }]);
    mockDiffRemoteWithLocal.mockRejectedValueOnce(new Error('read failed'));
    await vscode.commands.executeCommand('sshLite.diffWithLocal', makeItem());
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect(ctx.logResult).toHaveBeenCalledWith('diffWithLocal', false, 'read failed');
  });
});
