/**
 * Import review flow (issue #11 follow-up). On import, if any connection
 * conflicts with an existing one, the review webview opens IMMEDIATELY — no
 * Merge/Replace QuickPick in between. With no conflict, the file is merged in
 * directly. Drives the webview via the createWebviewPanel mock.
 */

import {
  workspace,
  window,
  commands,
  Uri,
  setMockConfig,
  clearMockConfig,
} from '../__mocks__/vscode';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue(''),
  statSync: jest.fn().mockReturnValue({ mtimeMs: 1000 }),
  writeFileSync: jest.fn(),
}));
jest.mock('os', () => ({ homedir: jest.fn().mockReturnValue('/home/test') }));
jest.mock('ssh-config', () => ({
  parse: jest.fn(() => ({ [Symbol.iterator]: function* () {}, compute: () => ({}), remove: jest.fn(), toString: () => '' })),
  DIRECTIVE: 1,
}));

import { HostService } from '../services/HostService';
import { CredentialService } from '../services/CredentialService';
import { ConnectionPortabilityService } from '../services/ConnectionPortabilityService';
import { registerConnectionSyncCommands } from './connectionSyncCommands';

const A = { name: 'Alpha', host: '1.1.1.1', port: 22, username: 'a' };
const B = { name: 'Bravo', host: '2.2.2.2', port: 22, username: 'b' };
function payloadJson() {
  return JSON.stringify({
    schema: 'sshlite-connections',
    version: 1,
    hosts: [A, B],
    credentials: { '1.1.1.1:22:a': [{ id: 'c', label: 'x', type: 'password' }] },
  });
}
const lastPanel = () => (window.createWebviewPanel as jest.Mock).mock.results.at(-1)!.value;
async function waitFor(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('waitFor timed out');
}

describe('importConnections — conflict-gated review UI (no mode prompt)', () => {
  let disposables: { dispose(): void }[];

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockConfig();
    (commands as any)._clearRegistry();
    (HostService as any)._instance = undefined;
    (CredentialService as any)._instance = undefined;
    (ConnectionPortabilityService as any)._instance = undefined;
    (workspace.fs.readFile as jest.Mock).mockReset();
    disposables = registerConnectionSyncCommands({ extensionVersion: '0.10.0', now: () => 'T' });
  });
  afterEach(() => {
    disposables.forEach((d) => d.dispose());
    clearMockConfig();
  });

  it('imports directly without any prompt when there are no conflicts', async () => {
    (window.showOpenDialog as jest.Mock).mockResolvedValueOnce([Uri.file('/x.json')]);
    (workspace.fs.readFile as jest.Mock).mockResolvedValueOnce(Buffer.from(payloadJson(), 'utf8'));

    await commands.executeCommand('sshLite.importConnections');

    expect(window.createWebviewPanel).not.toHaveBeenCalled();
    expect(window.showQuickPick).not.toHaveBeenCalled(); // no Merge/Replace step
    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('imported'));
  });

  it('opens the review webview immediately when a connection conflicts', async () => {
    setMockConfig('sshLite.hosts', [{ name: 'Alpha', host: '1.1.1.1', port: 22, username: 'a' }]); // conflicts with A
    (window.showOpenDialog as jest.Mock).mockResolvedValueOnce([Uri.file('/x.json')]);
    (workspace.fs.readFile as jest.Mock).mockResolvedValueOnce(Buffer.from(payloadJson(), 'utf8'));

    const pending = commands.executeCommand('sshLite.importConnections');
    await waitFor(() => (window.createWebviewPanel as jest.Mock).mock.calls.length > 0);

    expect(window.showQuickPick).not.toHaveBeenCalled(); // straight to the webview
    lastPanel()._fireMessage({ type: 'import', selectedIds: ['1.1.1.1:22:a', '2.2.2.2:22:b'] });
    await pending;

    expect(window.showInformationMessage).toHaveBeenCalledWith(expect.stringContaining('imported'));
  });

  it('applies nothing when the review is cancelled', async () => {
    setMockConfig('sshLite.hosts', [{ name: 'Alpha', host: '1.1.1.1', port: 22, username: 'a' }]);
    (window.showOpenDialog as jest.Mock).mockResolvedValueOnce([Uri.file('/x.json')]);
    (workspace.fs.readFile as jest.Mock).mockResolvedValueOnce(Buffer.from(payloadJson(), 'utf8'));

    const pending = commands.executeCommand('sshLite.importConnections');
    await waitFor(() => (window.createWebviewPanel as jest.Mock).mock.calls.length > 0);
    lastPanel()._fireMessage({ type: 'cancel' });
    await pending;

    expect(window.showInformationMessage).not.toHaveBeenCalledWith(expect.stringContaining('imported'));
  });
});
