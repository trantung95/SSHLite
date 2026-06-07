/**
 * Docker integration test for issue #7 — "Reveal in File Tree" must actually
 * SELECT the file in the folder structure, including over a slow/laggy link.
 *
 * Two root causes were behind the report; this test pins both end-to-end against
 * a REAL ssh2 connection to a deliberately laggy server (Toxiproxy latency toxic
 * on port 2206 -> slow-backend:22):
 *
 *  1. getParent() ancestor mismatch (the main bug). SFTP resolves '~' to an
 *     ABSOLUTE home (e.g. /home/testuser), so the tree renders the home's children
 *     directly under the connection. But the stored currentPath stayed the literal
 *     '~'. getParent() compared an always-absolute parent path against '~', so it
 *     never matched the root and emitted phantom /home, /home/testuser nodes that
 *     are NOT rendered. VS Code's reveal() walks getParent() to build the chain;
 *     a phantom node it can't find in the rendered tree aborts the walk and the
 *     file is never selected. The fix resolves '~' synchronously before comparing.
 *
 *  2. Timing race. The old code revealed after a fixed 300ms setTimeout; on a slow
 *     link the folder had not been listed yet, so reveal() silently no-oped. The
 *     fix (waitUntilVisible) makes revealFile() resolve only after the children are
 *     in the tree model — so this test runs under real added latency.
 *
 * The unit suite (FileTreeProvider.test.ts "issue #7") proves the getParent chain
 * with mocks; this closes the gap against a real server with a real SFTP-resolved
 * home and real network lag.
 *
 * Run: npm run test:docker
 */

import * as http from 'http';
import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { ConnectionManager } from '../connection/ConnectionManager';
import {
  FileTreeProvider,
  FileTreeItem,
  ConnectionTreeItem,
} from '../providers/FileTreeProvider';
import { IHostConfig } from '../types';
import { SavedCredential, CredentialService } from '../services/CredentialService';

// Connect THROUGH Toxiproxy (2206) so the latency toxic applies. slow-backend is
// the Dockerfile.sshd image, so /home/testuser/projects/src/app.ts exists.
const SLOW = { id: 'reveal-slow', label: 'slow-backend', host: '127.0.0.1', port: 2206, username: 'testuser', password: 'testpass' };
const TOXIPROXY_API = 'http://127.0.0.1:8474';
const NESTED_FILE = '/home/testuser/projects/src/app.ts';

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

/** Minimal Toxiproxy API call (no external deps). Resolves on 2xx, rejects otherwise. */
function toxiproxy(method: string, path: string, body?: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const url = new URL(TOXIPROXY_API + path);
    const req = http.request(
      { method, hostname: url.hostname, port: url.port, path: url.pathname,
        headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} },
      (res) => { res.resume(); res.on('end', () => {
        if ((res.statusCode ?? 500) < 300 || res.statusCode === 404) { resolve(); }
        else { reject(new Error(`toxiproxy ${method} ${path} -> ${res.statusCode}`)); }
      }); }
    );
    req.on('error', reject);
    if (data) { req.write(data); }
    req.end();
  });
}

/** Add a latency toxic so the proxied SSH link is laggy. Idempotent. */
async function seedLatency(latencyMs: number, jitterMs: number): Promise<void> {
  await toxiproxy('DELETE', '/proxies/ssh/toxics/reveal_latency').catch(() => undefined);
  await toxiproxy('POST', '/proxies/ssh/toxics', {
    name: 'reveal_latency', type: 'latency', stream: 'downstream',
    attributes: { latency: latencyMs, jitter: jitterMs },
  });
}

async function mkConn(): Promise<SSHConnection> {
  const host: IHostConfig = { id: SLOW.id, name: SLOW.label, host: SLOW.host, port: SLOW.port, username: SLOW.username, source: 'saved' };
  const cred: SavedCredential = { id: SLOW.id + '-pw', label: 'pw', type: 'password' };
  const c = new SSHConnection(host, cred);
  await c.connect();
  await new Promise((r) => setTimeout(r, 300));
  return c;
}

/** Walk getParent() from `element` to the root, collecting node ids. */
async function parentChain(provider: FileTreeProvider, element: any): Promise<string[]> {
  const chain: string[] = [element.id];
  let node: any = element;
  for (let i = 0; i < 12; i++) {
    const parent = await provider.getParent(node);
    if (!parent) { break; }
    chain.push((parent as any).id);
    node = parent;
  }
  return chain;
}

describe('issue #7 reveal-in-tree over a laggy link — docker integration', () => {
  let conn: SSHConnection;
  let provider: FileTreeProvider;

  beforeAll(async () => {
    setupMocks();
    // globalSetup only waits for ports 2201-2204, not Toxiproxy (2206/8474), so
    // retry until the proxy API and the proxied SSH port are both ready.
    let lastErr: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        // ~250ms added latency (+/-100ms jitter): clearly laggy, fast enough for CI.
        await seedLatency(250, 100);
        conn = await mkConn();
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        try { await conn?.disconnect(); } catch { /* ignore */ }
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (lastErr) { throw lastErr; }
    // Register the live connection so FileTreeProvider can resolve it by id.
    (ConnectionManager.getInstance() as any)._connections.set(conn.id, conn);
    provider = new FileTreeProvider();
    provider.setCurrentPath(conn.id, '~');
  }, 60000);

  afterAll(async () => {
    try { provider.dispose(); } catch { /* ignore */ }
    try { (ConnectionManager.getInstance() as any)._connections.delete(conn.id); } catch { /* ignore */ }
    try { await conn.disconnect(); } catch { /* ignore */ }
    try { await toxiproxy('DELETE', '/proxies/ssh/toxics/reveal_latency'); } catch { /* ignore */ }
  });

  // ---- Premise: SFTP resolves '~' to an ABSOLUTE home (the condition that broke getParent) ----
  it('lists the home (~) with ABSOLUTE child paths, complete, under latency', async () => {
    const files = await conn.listFiles('~');
    expect(files.length).toBeGreaterThan(0);
    // Every entry must carry an absolute path (this is what made currentPath="~"
    // and file.path diverge, breaking the getParent comparison).
    for (const f of files) {
      expect(f.path.startsWith('/')).toBe(true);
    }
    // The seeded 'projects' folder is present and absolute.
    expect(files.some((f) => f.path === '/home/testuser/projects')).toBe(true);
  }, 30000);

  // ---- End-to-end: revealFile resolves the right item under lag (timing fix) ----
  it('revealFile() returns the nested file under a laggy connection', async () => {
    const item = await provider.revealFile(conn.id, NESTED_FILE);
    expect(item).toBeDefined();
    expect(item!.file.path).toBe(NESTED_FILE);
    // currentPath stays '~' (we never force-navigate the user away from home).
    expect(provider.getCurrentPath(conn.id)).toBe('~');
  }, 30000);

  // ---- The core fix: getParent chain matches the rendered tree (no phantoms) ----
  it('getParent() builds a chain reveal() can walk — no phantom /home nodes', async () => {
    const item = await provider.revealFile(conn.id, NESTED_FILE);
    expect(item).toBeDefined();

    const chain = await parentChain(provider, item);

    // Must terminate at the connection node.
    expect(chain[chain.length - 1]).toBe(`connection:${conn.id}`);
    // No phantom ancestors above the resolved home root (/home/testuser).
    expect(chain).not.toContain(`file:${conn.id}:/home`);
    expect(chain).not.toContain(`file:${conn.id}:/home/testuser`);
    // The real rendered ancestors ARE present.
    expect(chain).toContain(`file:${conn.id}:/home/testuser/projects`);
    expect(chain).toContain(`file:${conn.id}:/home/testuser/projects/src`);
  }, 30000);
});
