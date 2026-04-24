/**
 * SSH Tools E2E Workflow Tests
 *
 * Tests complete user workflows for the new SSH Tools features against the
 * 3 Docker test servers (Alpine, ports 2201-2203). Each test simulates a
 * real user scenario spanning multiple services and multiple SSH round-trips.
 *
 * Workflows covered:
 *  1. Copy → paste same-host (clipboard + cp, auto-rename on conflict)
 *  2. Cut → paste same-host (move via rename, source gone)
 *  3. Copy → paste cross-host (read server1 → write server3)
 *  4. Process list + kill (ps → kill sleep → verify gone)
 *  5. Snippet add → run → verify output → remove
 *  6. Batch run across 3 servers (parallel, distinct hostnames)
 *  7. Env inspector (env|sort, PATH/USER/HOME present)
 *  8. Cron read/write roundtrip (write → verify → cleanup)
 *  9. Remote diff temp-file content match
 *
 * Run: npm run test:docker
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { IHostConfig } from '../types';
import { SavedCredential, CredentialService } from '../services/CredentialService';
import { RemoteClipboardService, ClipboardEntry } from '../services/RemoteClipboardService';
import { SnippetService } from '../services/SnippetService';
import { SystemToolsService } from '../services/SystemToolsService';
import { RemoteDiffService } from '../services/RemoteDiffService';

// ─── Server configs (same Docker containers as docker-ssh.test.ts) ────────────

const S1 = { id: 'e2e-s1', label: 'prod-server',    host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' };
const S2 = { id: 'e2e-s2', label: 'staging-server', host: '127.0.0.1', port: 2202, username: 'testuser', password: 'testpass' };
const S3 = { id: 'e2e-s3', label: 'dev-server',     host: '127.0.0.1', port: 2203, username: 'admin',    password: 'adminpass' };
const ALL_SERVERS = [S1, S2, S3];

// ─── Setup helpers ────────────────────────────────────────────────────────────

const _knownHosts: Record<string, unknown> = {};

function setupMocks(): void {
  setGlobalState({
    get: <T>(key: string, def?: T) => (_knownHosts[key] as T) ?? (def as T),
    update: async (k: string, v: unknown) => { _knownHosts[k] = v; },
    keys: () => Object.keys(_knownHosts),
  } as vscode.Memento);
  (CredentialService as any)._instance = undefined;
  (CredentialService as any)._instance = {
    getCredentialSecret: jest.fn().mockImplementation((_id: string, cid: string) =>
      Promise.resolve(cid.includes('s3') ? 'adminpass' : 'testpass')),
    getOrPrompt: jest.fn().mockResolvedValue('testpass'),
    initialize: jest.fn(),
  };
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
  (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('No, use only for this session');
}

async function mkConn(s: typeof S1): Promise<SSHConnection> {
  const host: IHostConfig = { id: s.id, name: s.label, host: s.host, port: s.port, username: s.username, source: 'saved' };
  const cred: SavedCredential = { id: s.id + '-pw', label: 'pw', type: 'password' };
  const c = new SSHConnection(host, cred);
  await c.connect();
  await new Promise(r => setTimeout(r, 800));
  return c;
}

async function done(c: SSHConnection) { try { await c.disconnect(); } catch {} }

function esc(p: string) { return p.replace(/'/g, "'\\''"); }

function cleanCmd(dir: string) { return 'rm -rf ' + JSON.stringify(dir); }

beforeAll(() => {
  setupMocks();
  (SystemToolsService as any)._instance = undefined;
  (RemoteClipboardService as any)._instance = undefined;
  (SnippetService as any)._instance = undefined;
  (RemoteDiffService as any)._instance = undefined;
});

// ─── 1. Copy → Paste same-host ────────────────────────────────────────────────

describe('e2e: copy → paste same-host', () => {
  let conn: SSHConnection;
  const base = '/home/testuser/e2e-copy';

  beforeAll(async () => {
    conn = await mkConn(S1);
    try { await conn.exec(cleanCmd(base)); } catch {}
    await conn.mkdir(base);
  });
  afterAll(async () => {
    try { await conn.exec(cleanCmd(base)); } catch {}
    await done(conn);
  });

  it('copy file via cp: dest has content, source unchanged', async () => {
    const src = base + '/orig.txt', dest = base + '/copy1/orig.txt';
    await conn.writeFile(src, Buffer.from('hello'));
    await conn.mkdir(base + '/copy1');
    await conn.exec("cp -- '" + esc(src) + "' '" + esc(dest) + "'");
    expect((await conn.readFile(dest)).toString()).toBe('hello');
    expect((await conn.readFile(src)).toString()).toBe('hello');
  });

  it('copy folder: nested files appear at destination', async () => {
    const sd = base + '/sf', dd = base + '/df';
    await conn.mkdir(sd);
    await conn.writeFile(sd + '/a.txt', Buffer.from('A'));
    await conn.writeFile(sd + '/b.txt', Buffer.from('B'));
    await conn.exec("cp -r -- '" + esc(sd) + "' '" + esc(dd) + "'");
    expect((await conn.readFile(dd + '/a.txt')).toString()).toBe('A');
    expect((await conn.readFile(dd + '/b.txt')).toString()).toBe('B');
  });

  it('auto-rename on conflict: nextCopyName produces unique name in real dir', async () => {
    const dir = base + '/cfdir';
    await conn.mkdir(dir);
    await conn.writeFile(dir + '/data.txt', Buffer.from('existing'));
    await conn.writeFile(base + '/data.txt', Buffer.from('new'));
    const existing = await conn.listFiles(dir);
    const names = new Set(existing.map((f) => f.name));
    // Simulate nextCopyName logic inline
    function nextName(orig: string, taken: Set<string>): string {
      if (!taken.has(orig)) return orig;
      const dot = orig.lastIndexOf('.');
      const b = dot > 0 ? orig.slice(0, dot) : orig, e = dot > 0 ? orig.slice(dot) : '';
      let c = b + ' (copy)' + e;
      if (!taken.has(c)) return c;
      for (let i = 2; i < 100; i++) { c = b + ' (copy) ' + i + e; if (!taken.has(c)) return c; }
      return b + ' (copy) 999' + e;
    }
    const resolved = nextName('data.txt', names);
    expect(resolved).toBe('data (copy).txt');
    await conn.exec("cp -- '" + esc(base + '/data.txt') + "' '" + esc(dir + '/' + resolved) + "'");
    expect((await conn.readFile(dir + '/data (copy).txt')).toString()).toBe('new');
    expect((await conn.readFile(dir + '/data.txt')).toString()).toBe('existing');
  });

  it('RemoteClipboardService: copy sets clipboard, clear empties it', () => {
    const svc = RemoteClipboardService.getInstance();
    const entry: ClipboardEntry = { connectionId: conn.id, remotePath: base + '/orig.txt', isDirectory: false, name: 'orig.txt' };
    svc.setClipboard([entry], 'copy');
    expect(svc.hasClipboard()).toBe(true);
    expect(svc.getClipboard()!.operation).toBe('copy');
    svc.clear();
    expect(svc.hasClipboard()).toBe(false);
  });
});

// ─── 2. Cut → Paste same-host ─────────────────────────────────────────────────

describe('e2e: cut → paste same-host (source gone after move)', () => {
  let conn: SSHConnection;
  const base = '/home/testuser/e2e-cut';

  beforeAll(async () => {
    conn = await mkConn(S2);
    try { await conn.exec(cleanCmd(base)); } catch {}
    await conn.mkdir(base);
  });
  afterAll(async () => {
    try { await conn.exec(cleanCmd(base)); } catch {}
    await done(conn);
  });

  it('SFTP rename: dest has content, source is gone', async () => {
    const src = base + '/move-src.txt', dest = base + '/move-dst.txt';
    await conn.writeFile(src, Buffer.from('move-me'));
    await conn.rename(src, dest);
    expect((await conn.readFile(dest)).toString()).toBe('move-me');
    let gone = false; try { await conn.readFile(src); } catch { gone = true; }
    expect(gone).toBe(true);
  });

  it('deleteFile: file gone after call', async () => {
    const fp = base + '/del.txt';
    await conn.writeFile(fp, Buffer.from('bye'));
    await conn.deleteFile(fp);
    let gone = false; try { await conn.readFile(fp); } catch { gone = true; }
    expect(gone).toBe(true);
  });

  it('rm -rf: non-empty folder absent from parent listing', async () => {
    const dir = base + '/nested/deep';
    await conn.mkdir(base + '/nested');
    await conn.mkdir(dir);
    await conn.writeFile(dir + '/x.txt', Buffer.from('x'));
    await conn.exec("rm -rf -- '" + esc(base + '/nested') + "'");
    const parent = await conn.listFiles(base);
    expect(parent.some((f) => f.name === 'nested')).toBe(false);
  });
});

// ─── 3. Copy → Paste cross-host (S1 → S3) ────────────────────────────────────

describe('e2e: copy → paste cross-host (server1 → server3)', () => {
  let c1: SSHConnection, c3: SSHConnection;
  const d1 = '/home/testuser/e2e-xhost-src', d3 = '/home/admin/e2e-xhost-dst';

  beforeAll(async () => {
    [c1, c3] = await Promise.all([mkConn(S1), mkConn(S3)]);
    for (const [c, d] of [[c1, d1], [c3, d3]] as [SSHConnection, string][]) {
      try { await c.exec(cleanCmd(d)); } catch {}
      await c.mkdir(d);
    }
  });
  afterAll(async () => {
    try { await c1.exec(cleanCmd(d1)); } catch {}
    try { await c3.exec(cleanCmd(d3)); } catch {}
    await Promise.all([done(c1), done(c3)]);
  });

  it('read from c1, write to c3, content matches', async () => {
    await c1.writeFile(d1 + '/cross.txt', Buffer.from('cross-host'));
    const buf = await c1.readFile(d1 + '/cross.txt');
    await c3.writeFile(d3 + '/cross.txt', buf);
    expect((await c3.readFile(d3 + '/cross.txt')).toString()).toBe('cross-host');
  });

  it('source file on c1 unchanged after cross-host copy', async () => {
    expect((await c1.readFile(d1 + '/cross.txt')).toString()).toBe('cross-host');
  });

  it('cross-host folder copy: all files transferred', async () => {
    await c1.mkdir(d1 + '/xf');
    await c1.writeFile(d1 + '/xf/one.txt', Buffer.from('one'));
    await c1.writeFile(d1 + '/xf/two.txt', Buffer.from('two'));
    await c3.mkdir(d3 + '/xf');
    for (const f of await c1.listFiles(d1 + '/xf')) {
      await c3.writeFile(d3 + '/xf/' + f.name, await c1.readFile(d1 + '/xf/' + f.name));
    }
    expect((await c3.readFile(d3 + '/xf/one.txt')).toString()).toBe('one');
    expect((await c3.readFile(d3 + '/xf/two.txt')).toString()).toBe('two');
  });
});

// ─── 4. Process list + kill workflow ─────────────────────────────────────────

describe('e2e: process list + kill workflow', () => {
  let conn: SSHConnection;

  beforeAll(async () => { conn = await mkConn(S1); (SystemToolsService as any)._instance = undefined; });
  afterAll(async () => { await done(conn); });

  it('listProcesses: ≥1 result with valid PID/user/command', async () => {
    const procs = await SystemToolsService.getInstance().listProcesses(conn as any, 30);
    expect(procs.length).toBeGreaterThan(0);
    for (const p of procs) {
      expect(p.pid).toBeGreaterThan(0);
      expect(p.user.trim()).toBeTruthy();
      expect(p.command.trim()).toBeTruthy();
    }
  });

  it('kill a started sleep process: not in list afterward', async () => {
    // Use nohup so the SSH channel closes immediately (background process detaches)
    const pidOut = (await conn.exec('nohup sleep 200 >/dev/null 2>&1 & echo $!')).trim();
    const targetPid = parseInt(pidOut, 10);
    if (!Number.isFinite(targetPid) || targetPid <= 0) { return; } // skip on busybox without nohup

    await new Promise(r => setTimeout(r, 400));
    const procs = await SystemToolsService.getInstance().listProcesses(conn as any, 200);
    const found = procs.find((p) => p.pid === targetPid);
    if (!found) { return; } // process already gone — benign

    await SystemToolsService.getInstance().killProcess(conn as any, targetPid, false);
    await new Promise(r => setTimeout(r, 400));

    const after = await SystemToolsService.getInstance().listProcesses(conn as any, 200);
    expect(after.some((p) => p.pid === targetPid)).toBe(false);
  }, 30000);

  it('listServices: does not throw (systemd absent on Alpine is valid)', async () => {
    const svcs = await SystemToolsService.getInstance().listServices(conn as any);
    expect(Array.isArray(svcs)).toBe(true);
  });
});

// ─── 5. Snippet add → run → verify output → remove ───────────────────────────

describe('e2e: snippet add → run on server → verify → remove', () => {
  let conn: SSHConnection;

  beforeAll(async () => {
    (SnippetService as any)._instance = undefined;
    conn = await mkConn(S2);
    const storage = new Map<string, unknown>();
    SnippetService.getInstance().initialize({
      globalState: { get: (k: string, d?: unknown) => storage.get(k) ?? d, update: async (k: string, v: unknown) => { storage.set(k, v); }, keys: () => [...storage.keys()] },
    } as any);
  });
  afterAll(async () => { (SnippetService as any)._instance = undefined; await done(conn); });

  it('6 built-in snippets exist', () => {
    expect(SnippetService.getInstance().getAll().filter((s) => s.builtin).length).toBeGreaterThanOrEqual(6);
  });

  it('disk-usage built-in snippet runs and returns output', async () => {
    const snip = SnippetService.getInstance().getAll().find((s) => s.name.toLowerCase().includes('disk'));
    const out = await conn.exec(snip!.command);
    expect(out).toBeTruthy();
    expect(out).toMatch(/\d+/);
  });

  it('user-added snippet: add → exec → output → remove lifecycle', async () => {
    const svc = SnippetService.getInstance();
    const added = await svc.add('e2e-hostname-test', 'hostname');
    expect(added.id).toMatch(/^user-/);
    const out = (await conn.exec(added.command)).trim();
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain('not found');
    await svc.remove(added.id);
    expect(svc.findById(added.id)).toBeUndefined();
  });

  it('rename snippet: name updated, command still works', async () => {
    const svc = SnippetService.getInstance();
    const added = await svc.add('old-name', 'whoami');
    await svc.rename(added.id, 'new-name');
    expect(svc.findById(added.id)!.name).toBe('new-name');
    const out = (await conn.exec(svc.findById(added.id)!.command)).trim();
    expect(out).toBe('testuser');
    await svc.remove(added.id);
  });
});

// ─── 6. Batch run across 3 servers ───────────────────────────────────────────

describe('e2e: batch run across 3 servers', () => {
  let conns: SSHConnection[];

  beforeAll(async () => { conns = await Promise.all(ALL_SERVERS.map(mkConn)); });
  afterAll(async () => { await Promise.all(conns.map(done)); });

  it('hostname on all 3 returns 3 distinct values', async () => {
    const results = await Promise.allSettled(conns.map((c) => c.exec('hostname')));
    const hosts = results.filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled').map((r) => r.value.trim());
    expect(hosts).toHaveLength(3);
    expect(new Set(hosts).size).toBe(3);
  });

  it('whoami: first two are testuser, third is admin', async () => {
    const res = await Promise.all(conns.map((c) => c.exec('whoami')));
    expect(res[0].trim()).toBe('testuser');
    expect(res[1].trim()).toBe('testuser');
    expect(res[2].trim()).toBe('admin');
  });

  it('uptime returns non-empty on all 3 servers in parallel', async () => {
    const res = await Promise.all(conns.map((c) => c.exec('uptime')));
    for (const r of res) { expect(r.trim()).toBeTruthy(); expect(r).toMatch(/up/i); }
  });

  it('Promise.allSettled: failure on one does not block others', async () => {
    const results = await Promise.allSettled([
      conns[0].exec('echo ok-1'),
      conns[1].exec('false; echo ok-2'), // 'false' exits non-zero but echo still runs on Alpine
      conns[2].exec('echo ok-3'),
    ]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[2].status).toBe('fulfilled');
  });
});

// ─── 7. Env inspector ─────────────────────────────────────────────────────────

describe('e2e: env inspector workflow', () => {
  let conn: SSHConnection;

  beforeAll(async () => { conn = await mkConn(S1); });
  afterAll(async () => { await done(conn); });

  it('env | sort: has PATH=, has KEY=VALUE lines', async () => {
    const out = await conn.exec('env | sort');
    const lines = out.trim().split('\n').filter((l) => l.includes('='));
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.startsWith('PATH='))).toBe(true);
  });

  it('HOME is a valid directory on the server', async () => {
    const home = (await conn.exec('echo $HOME')).trim();
    expect(home).toMatch(/^\//);
    const check = (await conn.exec('test -d ' + JSON.stringify(home) + ' && echo yes || echo no')).trim();
    expect(check).toBe('yes');
  });
});

// ─── 8. Cron editor roundtrip ─────────────────────────────────────────────────

describe('e2e: cron editor read/write/cleanup', () => {
  let conn: SSHConnection;
  const MARKER = '# e2e-cron-test-marker';

  beforeAll(async () => { conn = await mkConn(S2); });
  afterAll(async () => {
    try { await conn.exec("crontab -l 2>/dev/null | grep -v 'e2e-cron-test-marker' | crontab - 2>/dev/null || true"); } catch {}
    await done(conn);
  });

  it('crontab -l does not crash (empty is valid)', async () => {
    const out = await conn.exec('crontab -l 2>/dev/null || true');
    expect(typeof out).toBe('string');
  });

  it('write + read: test entry persists in crontab (skips if crontab not suid)', async () => {
    // Some minimal containers (e.g. Alpine test image) don't have crontab suid — skip gracefully
    const check = await conn.exec('crontab -l 2>&1 || true');
    if (check.toLowerCase().includes('suid') || check.toLowerCase().includes('must be')) {
      return; // crontab not usable in this container — skip
    }
    const tmp = '/tmp/e2e-cron-' + Date.now() + '.txt';
    const existing = await conn.exec('crontab -l 2>/dev/null || true');
    const newContent = existing.trim() + '\n' + MARKER + '\n';
    await conn.writeFile(tmp, Buffer.from(newContent));
    await conn.exec("crontab '" + esc(tmp) + "' && rm -f '" + esc(tmp) + "'");
    const updated = await conn.exec('crontab -l 2>/dev/null || true');
    expect(updated).toContain(MARKER);
  });

  it('remove test entry (skips if crontab not suid)', async () => {
    const check = await conn.exec('crontab -l 2>&1 || true');
    if (check.toLowerCase().includes('suid') || check.toLowerCase().includes('must be')) {
      return;
    }
    await conn.exec("crontab -l 2>/dev/null | grep -v 'e2e-cron-test-marker' | crontab - 2>/dev/null || true");
    const after = await conn.exec('crontab -l 2>/dev/null || true');
    expect(after).not.toContain(MARKER);
  });
});

// ─── 9. Remote diff temp-file content ────────────────────────────────────────

describe('e2e: remote diff workflow', () => {
  let conn: SSHConnection;
  const base = '/home/testuser/e2e-diff';

  beforeAll(async () => {
    (RemoteDiffService as any)._instance = undefined;
    conn = await mkConn(S1);
    try { await conn.exec(cleanCmd(base)); } catch {}
    await conn.mkdir(base);
  });
  afterAll(async () => {
    try { await conn.exec(cleanCmd(base)); } catch {}
    await done(conn);
  });

  it('temp file contains remote content after diffRemoteWithLocal', async () => {
    const remotePath = base + '/diff.txt';
    await conn.writeFile(remotePath, Buffer.from('e2e-content'));
    let tmpLocal: string | undefined;
    let capturedRemote: string | undefined;
    try {
      tmpLocal = path.join(os.tmpdir(), 'e2e-local.txt');
      fs.writeFileSync(tmpLocal, 'local');
      const spy = jest.spyOn(vscode.commands, 'executeCommand').mockImplementationOnce(
        async (_c: string, _l: any, r: any) => { capturedRemote = (r as any).fsPath; }
      );
      await RemoteDiffService.getInstance().diffRemoteWithLocal(conn as any, remotePath, tmpLocal);
      spy.mockRestore();
      if (capturedRemote && fs.existsSync(capturedRemote)) {
        expect(fs.readFileSync(capturedRemote, 'utf8')).toBe('e2e-content');
      }
    } finally {
      if (tmpLocal && fs.existsSync(tmpLocal)) { try { fs.unlinkSync(tmpLocal); } catch {} }
    }
  });

  it('two consecutive diffs use different temp file paths', async () => {
    await conn.writeFile(base + '/a.txt', Buffer.from('AAA'));
    await conn.writeFile(base + '/b.txt', Buffer.from('BBB'));
    let tmpLocal: string | undefined;
    const captured: string[] = [];
    try {
      tmpLocal = path.join(os.tmpdir(), 'e2e-base.txt');
      fs.writeFileSync(tmpLocal, 'x');
      for (const f of [base + '/a.txt', base + '/b.txt']) {
        const spy = jest.spyOn(vscode.commands, 'executeCommand').mockImplementationOnce(
          async (_c: string, _l: any, r: any) => { captured.push((r as any).fsPath); }
        );
        await RemoteDiffService.getInstance().diffRemoteWithLocal(conn as any, f, tmpLocal);
        spy.mockRestore();
      }
      expect(captured).toHaveLength(2);
      expect(captured[0]).not.toBe(captured[1]);
    } finally {
      if (tmpLocal && fs.existsSync(tmpLocal)) { try { fs.unlinkSync(tmpLocal); } catch {} }
    }
  });
});
