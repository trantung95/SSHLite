/**
 * URI-scheme-safety regression for the connection export/import commands
 * (issue #11). Per .adn/lessons.md "2026-05-22 — fs.writeFileSync(uri.fsPath, …)
 * is unsafe …", a path chosen via showSaveDialog/showOpenDialog can be a
 * vscode-remote:/vscode-vfs:/custom-scheme URI whose .fsPath does NOT point
 * where the user expects. Writes/reads MUST go through vscode.workspace.fs.
 */

import {
  workspace,
  window,
  commands,
  Uri,
  setMockConfig,
  clearMockConfig,
} from '../__mocks__/vscode';

var mockWriteFileSync = jest.fn();
var mockReadFileSync = jest.fn().mockReturnValue('{}');
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: (...a: unknown[]) => mockReadFileSync(...a),
  writeFileSync: (...a: unknown[]) => mockWriteFileSync(...a),
  statSync: jest.fn().mockReturnValue({ mtimeMs: 1000 }),
}));

jest.mock('os', () => ({ homedir: jest.fn().mockReturnValue('/home/test') }));

jest.mock('ssh-config', () => ({
  parse: jest.fn().mockImplementation(() => ({
    [Symbol.iterator]: function* () {},
    compute: jest.fn().mockReturnValue({}),
    remove: jest.fn(),
    toString: jest.fn().mockReturnValue(''),
  })),
  DIRECTIVE: 1,
}));

import { HostService } from '../services/HostService';
import { CredentialService } from '../services/CredentialService';
import { ConnectionPortabilityService } from '../services/ConnectionPortabilityService';
import { registerConnectionSyncCommands } from './connectionSyncCommands';

function resetSingletons(): void {
  (HostService as any)._instance = undefined;
  (CredentialService as any)._instance = undefined;
  (ConnectionPortabilityService as any)._instance = undefined;
}

const VALID_EXPORT = JSON.stringify({
  schema: 'sshlite-connections',
  version: 1,
  hosts: [{ name: 'H', host: '1.2.3.4', port: 22, username: 'u' }],
  credentials: {},
});

describe('connectionSyncCommands — URI-scheme-safe file I/O', () => {
  let disposables: { dispose(): void }[];

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockConfig();
    (commands as any)._clearRegistry();
    resetSingletons();
    (workspace.fs.writeFile as jest.Mock).mockResolvedValue(undefined);
    (workspace.fs.readFile as jest.Mock).mockReset();
    disposables = registerConnectionSyncCommands({ extensionVersion: '0.10.0', now: () => 'T' });
    // A saved host so export has something to write.
    setMockConfig('sshLite.hosts', [{ name: 'Prod', host: '10.0.0.1', port: 22, username: 'admin' }]);
  });

  afterEach(() => {
    disposables.forEach((d) => d.dispose());
    clearMockConfig();
  });

  describe('exportConnections', () => {
    const schemes: Array<[string, Uri]> = [
      ['file:', Uri.file('/home/test/sshlite-connections.json')],
      ['vscode-remote:', Uri.parse('vscode-remote://ssh-remote+box/home/userA/conns.json')],
      ['custom mem:', Uri.parse('mem://provider/in-memory/conns.json')],
    ];

    it.each(schemes)('writes via vscode.workspace.fs when scheme=%s', async (_label, saveUri) => {
      (window.showSaveDialog as jest.Mock).mockResolvedValueOnce(saveUri);

      await commands.executeCommand('sshLite.exportConnections');

      expect(workspace.fs.writeFile).toHaveBeenCalledTimes(1);
      const [calledUri, buf] = (workspace.fs.writeFile as jest.Mock).mock.calls[0];
      expect(calledUri).toBe(saveUri);
      // Content is the serialized export.
      expect(Buffer.from(buf).toString('utf8')).toContain('"schema": "sshlite-connections"');
      // The unsafe raw-fs write must never fire on the dialog URI.
      expect(mockWriteFileSync).not.toHaveBeenCalledWith(saveUri.fsPath, expect.anything());
    });

    it('does not write when the user cancels the save dialog', async () => {
      (window.showSaveDialog as jest.Mock).mockResolvedValueOnce(undefined);

      await commands.executeCommand('sshLite.exportConnections');

      expect(workspace.fs.writeFile).not.toHaveBeenCalled();
      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });
  });

  describe('importConnections', () => {
    const schemes: Array<[string, Uri]> = [
      ['file:', Uri.file('/home/test/conns.json')],
      ['vscode-remote:', Uri.parse('vscode-remote://ssh-remote+box/home/userA/conns.json')],
      ['custom mem:', Uri.parse('mem://provider/in-memory/conns.json')],
    ];

    it.each(schemes)('reads via vscode.workspace.fs when scheme=%s', async (_label, openUri) => {
      (window.showOpenDialog as jest.Mock).mockResolvedValueOnce([openUri]);
      (workspace.fs.readFile as jest.Mock).mockResolvedValueOnce(Buffer.from(VALID_EXPORT, 'utf8'));
      (window.showQuickPick as jest.Mock).mockResolvedValueOnce({ label: 'Merge', mode: 'merge' });

      await commands.executeCommand('sshLite.importConnections');

      expect(workspace.fs.readFile).toHaveBeenCalledTimes(1);
      expect((workspace.fs.readFile as jest.Mock).mock.calls[0][0]).toBe(openUri);
      // The unsafe raw-fs read must never fire on the dialog URI.
      expect(mockReadFileSync).not.toHaveBeenCalledWith(openUri.fsPath, expect.anything());
    });

    it('does not read when the user cancels the open dialog', async () => {
      (window.showOpenDialog as jest.Mock).mockResolvedValueOnce(undefined);

      await commands.executeCommand('sshLite.importConnections');

      expect(workspace.fs.readFile).not.toHaveBeenCalled();
    });

    it('surfaces a clear error and applies nothing for a malformed file', async () => {
      (window.showOpenDialog as jest.Mock).mockResolvedValueOnce([Uri.file('/home/test/bad.json')]);
      (workspace.fs.readFile as jest.Mock).mockResolvedValueOnce(Buffer.from('not json {', 'utf8'));

      await commands.executeCommand('sshLite.importConnections');

      expect(window.showErrorMessage).toHaveBeenCalled();
      // Never reached the merge/replace prompt.
      expect(window.showQuickPick).not.toHaveBeenCalled();
    });
  });
});
