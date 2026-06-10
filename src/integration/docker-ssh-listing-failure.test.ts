/**
 * Docker integration test for issue #13 — clicking the root icon (or expanding
 * any directory) that the server cannot list froze VS Code in an infinite loop
 * and endlessly spammed "Failed to list directory" notifications.
 *
 * Root cause (FileTreeProvider): a failed directory load deleted the loading
 * key and fired a tree refresh; the refresh re-entered getChildren(), saw
 * "not cached, not loading", and started the load again → fail → notify →
 * refresh → load, forever.
 *
 * The unit suite (FileTreeProvider.issue13.test.ts) proves the provider logic
 * with a mock that rejects. This closes the gap against a REAL ssh2/SFTP
 * connection: it first proves a real chmod-000 directory actually makes
 * listFiles() REJECT (the whole fix hinges on that), then drives the real
 * provider end-to-end and proves it renders an error item, does NOT re-list in
 * a loop, and recovers once the directory becomes readable again.
 *
 * Run: npm run test:docker
 */

import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { ConnectionManager } from '../connection/ConnectionManager';
import {
  FileTreeProvider,
  ConnectionTreeItem,
  LoadingTreeItem,
  LoadErrorTreeItem,
} from '../providers/FileTreeProvider';
import { IHostConfig } from '../types';
import { SavedCredential, CredentialService } from '../services/CredentialService';

const WEB = { id: 'fail-web', label: 'hybr8-prod-web-01', host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' };
const DENIED_DIR = '/home/testuser/issue13-denied';

const _knownHosts: Record<string, unknown> = {};

function setupMocks(): void {
  setGlobalState({
    get: <T>(key: string, def?: T) => (_knownHosts[key] as T) ?? (def as T),
    update: async (k: string, v: unknown) => { _knownHosts[k] = v; },
    keys: () => Object.keys(_knownHosts),
  } as vscode.Memento);
  (CredentialService as any)._instance = undefined;
  (CredentialService as any)._instance = {
    getCredentialSecret: jest.fn().mockResolvedValue('testpass'),
    getOrPrompt: jest.fn().mockResolvedValue('testpass'),
    initialize: jest.fn(),
  };
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
  (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('No, use only for this session');
}

async function mkConn(): Promise<SSHConnection> {
  const host: IHostConfig = { id: WEB.id, name: WEB.label, host: WEB.host, port: WEB.port, username: WEB.username, source: 'saved' };
  const cred: SavedCredential = { id: WEB.id + '-pw', label: 'pw', type: 'password' };
  const c = new SSHConnection(host, cred);
  await c.connect();
  await new Promise((r) => setTimeout(r, 300));
  return c;
}

/** Let the provider's background load promise chain settle. */
async function flushAsync(): Promise<void> {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));
}

describe('issue #13 failed directory listing must not loop — docker integration', () => {
  let conn: SSHConnection;
  let provider: FileTreeProvider;

  beforeAll(async () => {
    setupMocks();
    conn = await mkConn();
    // Seed a directory the user owns but cannot read/exec (chmod 000).
    await conn.exec(`rm -rf ${DENIED_DIR} && mkdir -p ${DENIED_DIR} && chmod 000 ${DENIED_DIR}`);
    (ConnectionManager.getInstance() as any)._connections.set(conn.id, conn);
    provider = new FileTreeProvider();
  }, 60000);

  afterAll(async () => {
    try { provider.dispose(); } catch { /* ignore */ }
    try { (ConnectionManager.getInstance() as any)._connections.delete(conn.id); } catch { /* ignore */ }
    try { await conn.exec(`chmod 755 ${DENIED_DIR} && rm -rf ${DENIED_DIR}`); } catch { /* ignore */ }
    try { await conn.disconnect(); } catch { /* ignore */ }
  });

  // ---- Premise: a real chmod-000 directory makes listFiles() REJECT ----
  it('listFiles() on a chmod-000 directory rejects (the condition the fix depends on)', async () => {
    await expect(conn.listFiles(DENIED_DIR)).rejects.toBeDefined();
  }, 30000);

  // ---- End-to-end: the provider renders an error item and does NOT loop ----
  it('renders a LoadErrorTreeItem and stops re-listing after the failure', async () => {
    const listSpy = jest.spyOn(conn, 'listFiles');

    provider.setCurrentPath(conn.id, DENIED_DIR); // user navigates into the denied dir
    await flushAsync();

    const rootItems = await provider.getChildren();
    const connItem = rootItems.find((i) => i instanceof ConnectionTreeItem) as ConnectionTreeItem;
    expect(connItem).toBeInstanceOf(ConnectionTreeItem);

    // First render starts the (doomed) load and shows the spinner
    const first = await provider.getChildren(connItem);
    expect(first[0]).toBeInstanceOf(LoadingTreeItem);
    await flushAsync();

    const callsAfterFailure = listSpy.mock.calls.filter((c) => c[0] === DENIED_DIR).length;
    expect(callsAfterFailure).toBeGreaterThanOrEqual(1);

    // The failure fired a refresh; VS Code re-enters getChildren repeatedly.
    // It must render the error item and NOT start another listFiles.
    for (let i = 0; i < 5; i++) {
      const children = await provider.getChildren(connItem);
      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(LoadErrorTreeItem);
      await flushAsync();
    }
    const callsAtEnd = listSpy.mock.calls.filter((c) => c[0] === DENIED_DIR).length;
    expect(callsAtEnd).toBe(callsAfterFailure);

    listSpy.mockRestore();
  }, 30000);

  // ---- The notification fires exactly once, not in a loop ----
  it('shows the failure notification exactly once', async () => {
    (vscode.window.showErrorMessage as jest.Mock).mockClear();

    provider.refreshFolder(conn.id, DENIED_DIR); // un-stick, drive a fresh failed load
    const rootItems = await provider.getChildren();
    const connItem = rootItems.find((i) => i instanceof ConnectionTreeItem) as ConnectionTreeItem;
    await provider.getChildren(connItem);
    await flushAsync();
    for (let i = 0; i < 5; i++) {
      await provider.getChildren(connItem);
      await flushAsync();
    }

    const errorCalls = (vscode.window.showErrorMessage as jest.Mock).mock.calls
      .filter((c) => String(c[0]).startsWith('Failed to list directory'));
    expect(errorCalls.length).toBe(1);
  }, 30000);

  // ---- Recovery: once the directory is readable, an explicit refresh succeeds ----
  it('recovers and lists normally after the directory becomes readable + refresh', async () => {
    await conn.exec(`chmod 755 ${DENIED_DIR}`);

    provider.refreshFolder(conn.id, DENIED_DIR); // explicit retry clears the failure
    const rootItems = await provider.getChildren();
    const connItem = rootItems.find((i) => i instanceof ConnectionTreeItem) as ConnectionTreeItem;

    const retry = await provider.getChildren(connItem);
    expect(retry[0]).toBeInstanceOf(LoadingTreeItem); // it actually retries
    await flushAsync();

    const loaded = await provider.getChildren(connItem);
    expect(loaded.some((i) => i instanceof LoadErrorTreeItem)).toBe(false);
  }, 30000);
});
