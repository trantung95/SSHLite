/**
 * Repro: click-during-search bug.
 *
 * Drives the REAL SSHConnection.searchFiles (with stat-enrichment, grep
 * parsing, search worker semantics) + readFile concurrently against a docker
 * SSH server on port 2201, while measuring event-loop lag with
 * perf_hooks.monitorEventLoopDelay. Tests whether mid-search readFile
 * saturates the event loop or causes any runtime fault.
 *
 * Prereqs: docker compose -f test-docker/docker-compose.yml up -d ssh-server-1
 *          container seeded with /home/testuser/big/huge.log + small files.
 *
 * Run: npx jest --no-coverage src/integration/click-during-search.test.ts
 */

import { SSHConnection } from '../connection/SSHConnection';
import { CredentialService } from '../services/CredentialService';
import { IHostConfig } from '../types';
import { monitorEventLoopDelay } from 'perf_hooks';
import * as net from 'net';

const HOST: IHostConfig = {
  id: 'repro-1',
  name: 'docker-1',
  host: '127.0.0.1',
  port: 2201,
  username: 'testuser',
  source: 'saved',
};
const CRED_ID = 'cred1';
const PASSWORD = 'testpass';

function isDockerReachable(): Promise<boolean> {
  return new Promise((r) => {
    const s = net.createConnection({ host: HOST.host, port: HOST.port }, () => {
      s.destroy();
      r(true);
    });
    s.setTimeout(1500);
    s.on('error', () => r(false));
    s.on('timeout', () => { s.destroy(); r(false); });
  });
}

function startLag() {
  const h = monitorEventLoopDelay({ resolution: 10 });
  h.enable();
  return {
    snap() {
      const s = {
        meanMs: +(h.mean / 1e6).toFixed(2),
        p99Ms: +(h.percentile(99) / 1e6).toFixed(2),
        maxMs: +(h.max / 1e6).toFixed(2),
      };
      h.reset();
      return s;
    },
    stop() { h.disable(); },
  };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('click-during-search bug repro', () => {
  let dockerUp = false;
  let conn: SSHConnection;

  beforeAll(async () => {
    dockerUp = await isDockerReachable();
    if (!dockerUp) return;
    // SSHConnection.id is `${host.host}:${host.port}:${host.username}`, NOT host.id.
    // Seed the session credential under that key.
    const sshConnId = `${HOST.host}:${HOST.port}:${HOST.username}`;
    CredentialService.getInstance().setSessionCredential(sshConnId, CRED_ID, PASSWORD);
    // Auto-accept host key prompts (jest has no UI)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const vscode = require('vscode');
    vscode.window.showInformationMessage = jest.fn().mockResolvedValue('Yes, Connect');
    vscode.window.showWarningMessage = jest.fn().mockResolvedValue('Accept New Key');
    conn = new SSHConnection(HOST, { id: CRED_ID, type: 'password', label: 'test' } as never);
    await conn.connect();
  }, 30000);

  afterAll(async () => {
    if (conn) await conn.disconnect();
  });

  it('A: SSHConnection.searchFiles baseline', async () => {
    if (!dockerUp) { console.warn('docker not reachable'); return; }
    const lag = startLag();
    const t0 = Date.now();
    const r = await conn.searchFiles('/home/testuser/big', 'a', {
      searchContent: true, caseSensitive: false, regex: false, wholeWord: false,
      filePattern: '*', maxResults: 2000,
    });
    const t1 = Date.now();
    const s = lag.snap(); lag.stop();
    console.log(`[A] search-only duration=${t1 - t0}ms results=${r.length} lag mean=${s.meanMs} p99=${s.p99Ms} max=${s.maxMs}`);
  }, 60000);

  it('B: SSHConnection.readFile baseline (huge.log)', async () => {
    if (!dockerUp) { console.warn('docker not reachable'); return; }
    const lag = startLag();
    const t0 = Date.now();
    const buf = await conn.readFile('/home/testuser/big/huge.log');
    const t1 = Date.now();
    const s = lag.snap(); lag.stop();
    console.log(`[B] readFile-only duration=${t1 - t0}ms bytes=${buf.length} lag mean=${s.meanMs} p99=${s.p99Ms} max=${s.maxMs}`);
  }, 60000);

  it('C: REPRO click readFile mid-search', async () => {
    if (!dockerUp) { console.warn('docker not reachable'); return; }
    const lag = startLag();
    const t0 = Date.now();

    const s1 = conn.searchFiles('/home/testuser/big', 'a', {
      searchContent: true, caseSensitive: false, regex: false, wholeWord: false,
      filePattern: '*', maxResults: 2000,
    }).then((r) => ({ label: 's1', n: r.length, t: Date.now() - t0 }))
      .catch((e) => ({ label: 's1', err: (e as Error).message }));

    const s2 = conn.searchFiles('/home/testuser/projects', 'a', {
      searchContent: true, caseSensitive: false, regex: false, wholeWord: false,
      filePattern: '*', maxResults: 2000,
    }).then((r) => ({ label: 's2', n: r.length, t: Date.now() - t0 }))
      .catch((e) => ({ label: 's2', err: (e as Error).message }));

    await sleep(150);
    const tc = Date.now();
    const click = conn.readFile('/home/testuser/big/huge.log')
      .then((b) => ({ label: 'click', bytes: b.length, t: Date.now() - tc }))
      .catch((e) => ({ label: 'click', err: (e as Error).message }));

    const [r1, r2, rc] = await Promise.all([s1, s2, click]);
    const t1 = Date.now();
    const s = lag.snap(); lag.stop();
    console.log(`[C] mid-search readFile total=${t1 - t0}ms lag mean=${s.meanMs} p99=${s.p99Ms} max=${s.maxMs}`);
    console.log('  ', JSON.stringify(r1));
    console.log('  ', JSON.stringify(r2));
    console.log('  ', JSON.stringify(rc));
  }, 120000);

  it('D: STRESS many concurrent searches + readFile', async () => {
    if (!dockerUp) { console.warn('docker not reachable'); return; }
    const lag = startLag();
    const t0 = Date.now();
    const N = 6; // matches the global cap on simultaneous search workers
    const searches = Array.from({ length: N }, (_, i) =>
      conn.searchFiles('/home/testuser/big', 'a', {
        searchContent: true, caseSensitive: false, regex: false, wholeWord: false,
        filePattern: '*', maxResults: 2000,
      }).then((r) => ({ label: `s${i}`, n: r.length, t: Date.now() - t0 }))
        .catch((e) => ({ label: `s${i}`, err: (e as Error).message }))
    );
    await sleep(150);
    const tc = Date.now();
    const click = conn.readFile('/home/testuser/big/huge.log')
      .then((b) => ({ label: 'click', bytes: b.length, t: Date.now() - tc }))
      .catch((e) => ({ label: 'click', err: (e as Error).message }));
    const results = await Promise.all([...searches, click]);
    const t1 = Date.now();
    const s = lag.snap(); lag.stop();
    console.log(`[D] STRESS total=${t1 - t0}ms lag mean=${s.meanMs} p99=${s.p99Ms} max=${s.maxMs}`);
    for (const r of results) console.log(' ', JSON.stringify(r));
  }, 120000);
});
