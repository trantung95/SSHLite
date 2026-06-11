/**
 * Docker integration test for issue #11 — imported credential metadata is
 * SECRET-FREE and prompts on first connect.
 *
 * When you import a connections file, SSH Lite restores the credential metadata
 * (label, type, pinned folders) but NEVER the password — passwords live only in
 * VS Code SecretStorage and are not part of the export. The unit suites prove
 * importCredentialMetadata never writes a secret; this closes the gap end-to-end
 * against a real sshd: after importing a password credential with no stored
 * secret, connecting must (a) prompt for the password and (b) authenticate for
 * real once the user types it.
 *
 * Run: npm run test:docker
 */

import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { IHostConfig } from '../types';
import { CredentialService } from '../services/CredentialService';
import { ConnectionPortabilityService } from '../services/ConnectionPortabilityService';
import {
  createMockExtensionContext,
  setMockConfig,
  clearMockConfig,
  workspace,
} from '../__mocks__/vscode';

const S = { host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' };
const HOST_ID = `${S.host}:${S.port}:${S.username}`;

const _state: Record<string, unknown> = {};

// Make config.update persist so the imported credential index round-trips.
function enableConfigPersistence(): void {
  const orig = workspace.getConfiguration;
  (workspace as any).getConfiguration = (section?: string) => {
    const config = orig(section);
    config.update = jest.fn().mockImplementation((key: string, value: unknown) => {
      setMockConfig(section ? `${section}.${key}` : key, value);
      return Promise.resolve();
    });
    return config;
  };
}

describe('issue #11 — imported password credential prompts then authenticates (docker)', () => {
  let conn: SSHConnection;

  beforeAll(() => {
    clearMockConfig();
    enableConfigPersistence();
    setGlobalState({
      get: <T>(key: string, def?: T) => (_state[key] as T) ?? (def as T),
      update: async (k: string, v: unknown) => { _state[k] = v; },
      keys: () => Object.keys(_state),
    } as vscode.Memento);

    // Real CredentialService backed by an empty SecretStorage (no secrets).
    (CredentialService as any)._instance = undefined;
    CredentialService.getInstance().initialize(
      createMockExtensionContext() as unknown as Parameters<CredentialService['initialize']>[0]
    );

    // Accept the host key / connect prompts; supply the password when prompted.
    (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
    (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
    (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('No, use only for this session');
    (vscode.window.showInputBox as jest.Mock).mockResolvedValue(S.password);
  });

  afterAll(async () => {
    try { await conn?.disconnect(); } catch { /* ignore */ }
    clearMockConfig();
  });

  it('imports the credential with NO stored secret', async () => {
    const payload = ConnectionPortabilityService.getInstance().parseAndValidate(
      JSON.stringify({
        schema: 'sshlite-connections',
        version: 1,
        hosts: [{ name: 'Docker', host: S.host, port: S.port, username: S.username }],
        credentials: { [HOST_ID]: [{ id: 'imported-pw', label: 'Imported', type: 'password' }] },
      })
    );

    await ConnectionPortabilityService.getInstance().applyImport(payload, 'replace');

    const creds = CredentialService.getInstance().listCredentials(HOST_ID);
    expect(creds).toHaveLength(1);
    expect(creds[0].label).toBe('Imported');
    // The secret was never imported.
    expect(await CredentialService.getInstance().getCredentialSecret(HOST_ID, creds[0].id)).toBeUndefined();
  });

  it('prompts for the password on connect and authenticates against the real server', async () => {
    const cred = CredentialService.getInstance().listCredentials(HOST_ID)[0];
    const host: IHostConfig = {
      id: HOST_ID,
      name: 'Docker',
      host: S.host,
      port: S.port,
      username: S.username,
      source: 'saved',
    };

    conn = new SSHConnection(host, cred);
    await conn.connect();
    await new Promise((r) => setTimeout(r, 300));

    // The prompt fired because no secret was stored by the import.
    expect(vscode.window.showInputBox as jest.Mock).toHaveBeenCalled();
    // Real authentication succeeded with the typed password.
    const out = await conn.exec('echo import-ok');
    expect(out).toContain('import-ok');
  }, 30000);
});
