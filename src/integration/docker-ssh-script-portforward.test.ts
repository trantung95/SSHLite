/**
 * Docker integration test: "Run local script on host", "Batch run" and Port Forwarding
 * against REAL sshd containers (2203 admin, 2202 testuser). No SSH mocks; only VS Code UI is mocked.
 *
 * Coverage
 *  A. sshLite.runLocalScriptRemote (src/commands/batchAndScriptCommands.ts)
 *     - >1 MB stdout is captured completely
 *     - stdout and stderr are both surfaced to the user
 *     - non-zero exit code is reported to the user (with and without stderr text)
 *     - remote /tmp/sshlite-run-* temp file is removed after success AND failure
 *     - a script saved with CRLF line endings (typical on a Windows client) runs correctly
 *  B. sshLite.batchRun: per-host results, one failing host does not hide the others,
 *     an unreachable (wrong port) host fails cleanly.
 *  C. PortForwardService.forwardPort / stopForward (src/services/PortForwardService.ts)
 *     - real TCP round trip through the tunnel (incl. 1 MB), local port freed after stop,
 *       established connections do not outlive the stop,
 *       local port already in use -> clean error and no saved rule / tree row,
 *       remote target refused -> client socket closed, nothing leaked, tunnel still usable.
 *
 * Tests tagged [BUG] encode expected behaviour that current product code does NOT meet and
 * are intentionally failing; see the report that accompanied this file.
 *
 * Remote scratch: /tmp/sshlite-it-script/ ; remote listener ports 18081-18082 (nc inside container).
 */

import * as fs from 'fs';
import { execSync } from 'child_process';
import * as os from 'os';
import * as net from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { ConnectionManager } from '../connection/ConnectionManager';
import { CredentialService, SavedCredential } from '../services/CredentialService';
import { PortForwardService } from '../services/PortForwardService';
import { registerBatchAndScriptCommands } from '../commands/batchAndScriptCommands';
import { IHostConfig } from '../types';

const S_API = { id: 'sp-api', name: 'api', host: '127.0.0.1', port: 2202, username: 'testuser', password: 'testpass' };
const S_DB = { id: 'sp-db', name: 'db', host: '127.0.0.1', port: 2203, username: 'admin', password: 'adminpass' };
// The shared Alpine test servers ship `AllowTcpForwarding no` (Alpine default), so real tunnels cannot be
// opened through them. Port-forward tests use a private throw-away container started from the same image
// with forwarding enabled (127.0.0.1:2296 -> 22); it is removed in afterAll. Shared stack is not touched.
const S_PF = { id: 'sp-pf', name: 'pf', host: '127.0.0.1', port: 2296, username: 'admin', password: 'adminpass' };
const PF_CONTAINER = 'sshlite-it-pf';
const REMOTE_DIR = '/tmp/sshlite-it-script';
const ECHO_PORT = 18081;
const REFUSED_PORT = 18082; // nothing ever listens here

const _knownHosts: Record<string, unknown> = {};

function setupMocks(): void {
  setGlobalState({
    get: <T>(key: string, def?: T) => (_knownHosts[key] as T) ?? (def as T),
    update: async (k: string, v: unknown) => { _knownHosts[k] = v; },
    keys: () => Object.keys(_knownHosts),
  } as vscode.Memento);
  (CredentialService as any)._instance = {
    getCredentialSecret: jest.fn().mockImplementation((_h: string, cid: string) =>
      Promise.resolve(cid.includes('db') || cid.includes('pf') ? 'adminpass' : 'testpass')),
    getOrPrompt: jest.fn().mockResolvedValue('testpass'),
    initialize: jest.fn(),
  };
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
}

function hostCfg(s: typeof S_API, port = s.port): IHostConfig {
  return { id: s.id, name: s.name, host: s.host, port, username: s.username, source: 'saved' };
}

async function connect(s: typeof S_API, port = s.port): Promise<SSHConnection> {
  const cred: SavedCredential = { id: s.id + '-pw', label: 'pw', type: 'password' };
  const c = new SSHConnection(hostCfg(s, port), cred);
  await c.connect();
  return c;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(p));
    });
  });
}

/** True when nothing is listening on 127.0.0.1:port (we can bind it ourselves). */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) { return true; }
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

/** Open a client socket through a local port, resolves with the socket (connected). */
function dial(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => resolve(s));
    s.once('error', reject);
  });
}

function sendAndCollect(sock: net.Socket, payload: Buffer, expectBytes: number, ms: number): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let got = 0;
    const done = () => { clearTimeout(t); sock.removeAllListeners('data'); resolve(Buffer.concat(chunks)); };
    const t = setTimeout(done, ms);
    sock.on('data', (d: Buffer) => { chunks.push(d); got += d.length; if (got >= expectBytes) { done(); } });
    sock.write(payload);
  });
}

describe('Docker: run local script / batch run / port forwarding (real sshd)', () => {
  let db: SSHConnection;
  let pf: SSHConnection;
  let api: SSHConnection;
  let localDir: string;
  const outputLines: string[] = [];
  const outputChannel = {
    appendLine: jest.fn((l: string) => { outputLines.push(l); }),
    append: jest.fn(), show: jest.fn(), clear: jest.fn(), dispose: jest.fn(),
  };
  const ctx: any = { log: jest.fn(), logResult: jest.fn(), outputChannel, envProvider: {}, cronProvider: {} };
  let disposables: vscode.Disposable[] = [];
  const mgrConns = (): Map<string, unknown> => (ConnectionManager.getInstance() as any)._connections;

  const outText = (): string => outputLines.join('\n');

  async function listRunTemps(c: SSHConnection): Promise<string[]> {
    const out = await c.exec('ls -1 /tmp 2>/dev/null | grep "^sshlite-run-" || true');
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  }

  /** Write a local script, run it through the real command, return what the user would see. */
  async function runScript(content: string | Buffer, ext = '.sh') {
    const p = path.join(localDir, 'script-' + Date.now() + '-' + Math.random().toString(36).slice(2) + ext);
    fs.writeFileSync(p, content);
    (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([vscode.Uri.file(p)]);
    outputLines.length = 0;
    (vscode.window.showErrorMessage as jest.Mock).mockClear();
    const before = new Set(await listRunTemps(db));
    await vscode.commands.executeCommand('sshLite.runLocalScriptRemote', db);
    const after = await listRunTemps(db);
    return {
      output: outText(),
      errors: (vscode.window.showErrorMessage as jest.Mock).mock.calls.map((c) => String(c[0])),
      leakedTemps: after.filter((f) => !before.has(f)),
    };
  }

  beforeAll(async () => {
    setupMocks();
    localDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshlite-it-script-'));
    db = await connect(S_DB);
    api = await connect(S_API);
    mgrConns().set(db.id, db);
    mgrConns().set(api.id, api);
    disposables = registerBatchAndScriptCommands(ctx);
    await db.exec(`mkdir -p ${REMOTE_DIR}`);
    // Private forwarding-enabled sshd + persistent TCP echo server (busybox nc -lk -e cat) on remote port 18081.
    try { execSync(`docker rm -f ${PF_CONTAINER}`, { stdio: 'ignore' }); } catch { /* none */ }
    execSync(
      `docker run -d --name ${PF_CONTAINER} -p 127.0.0.1:${S_PF.port}:22 hybr8-prod-db sh -c "sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /etc/ssh/sshd_config; nohup nc -lk -p ${ECHO_PORT} -e /bin/cat </dev/null >/dev/null 2>&1 & exec /usr/sbin/sshd -D -e"`,
      { stdio: 'pipe' });
    let lastErr: unknown;
    for (let i = 0; i < 40 && !pf; i++) {
      try { pf = await connect(S_PF); } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 250)); }
    }
    if (!pf) { throw lastErr; }
    expect(await waitFor(async () => (await pf.exec(`nc -z 127.0.0.1 ${ECHO_PORT} && echo up || echo down`)).includes('up'), 5000)).toBe(true);
  }, 90000);

  afterAll(async () => {
    try { PortForwardService.getInstance().dispose(); } catch { /* ignore */ }
    for (const c of [db, api, pf]) {
      if (!c) { continue; }
      for (const p of c.getActiveForwards()) { try { await c.stopForward(p); } catch { /* ignore */ } }
    }
    try {
      await db.exec(`rm -rf ${REMOTE_DIR}; rm -f /tmp/sshlite-run-* || true`);
    } catch { /* ignore */ }
    mgrConns().delete(S_DB.id); mgrConns().delete(S_API.id);
    disposables.forEach((d) => d.dispose());
    try { db?.disconnect(); api?.disconnect(); pf?.disconnect(); } catch { /* ignore */ }
    try { execSync(`docker rm -f ${PF_CONTAINER}`, { stdio: 'ignore' }); } catch { /* ignore */ }
    try { fs.rmSync(localDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 30000);

  // ───────────────────────── A. run local script ─────────────────────────

  describe('runLocalScriptRemote', () => {
    it('captures >1 MB of stdout completely and cleans the temp file', async () => {
      const r = await runScript('#!/bin/sh\nseq 1 250000\n');
      const lines = r.output.split('\n').filter((l) => /^\d+$/.test(l));
      expect(lines.length).toBe(250000);
      expect(lines[0]).toBe('1');
      expect(lines[lines.length - 1]).toBe('250000');
      expect(r.output.length).toBeGreaterThan(1024 * 1024);
      expect(r.leakedTemps).toEqual([]);
    }, 60000);

    it('removes the temp file when the script fails with stderr', async () => {
      const r = await runScript('#!/bin/sh\necho boom >&2\nexit 5\n');
      expect(r.errors.some((e) => /boom|exit code 5/.test(e))).toBe(true);
      expect(r.leakedTemps).toEqual([]);
    }, 30000);

    it('[BUG] reports a non-zero exit code even when the script prints nothing to stderr', async () => {
      // exec() resolves successfully when exit!=0 and stderr is empty, so the command shows
      // "partial" as if the script succeeded and never raises "Script run failed".
      const r = await runScript('#!/bin/sh\necho partial\nexit 3\n');
      expect(r.leakedTemps).toEqual([]);
      expect(r.errors.length).toBeGreaterThan(0);
    }, 30000);

    it('[BUG] surfaces stderr output of a successful (exit 0) script', async () => {
      // exec() drops stderr whenever the exit code is 0.
      const r = await runScript('#!/bin/sh\necho to-stdout\necho to-stderr >&2\n');
      expect(r.output).toContain('to-stdout');
      expect(r.output).toContain('to-stderr');
    }, 30000);

    it('[BUG] runs a CRLF script (saved on a Windows client) correctly', async () => {
      // "#!/bin/sh\r" -> kernel looks for interpreter "/bin/sh\r" -> exit 127. Bytes are uploaded verbatim.
      const r = await runScript('#!/bin/sh\r\necho crlf-ok\r\n');
      expect(r.output).toContain('crlf-ok');
      expect(r.errors).toEqual([]);
      expect(r.leakedTemps).toEqual([]);
    }, 30000);

    it('uses a generated temp name (not derived from the local file name)', async () => {
      const r = await runScript('#!/bin/sh\nbasename "$0" | cut -c1-12\n');
      expect(r.output).toContain('sshlite-run-');
      expect(r.leakedTemps).toEqual([]);
    }, 30000);
  });

  // ───────────────────────── B. batch run ─────────────────────────

  describe('batchRun', () => {
    async function runBatch(command: string): Promise<string> {
      (vscode.window.showQuickPick as jest.Mock).mockImplementationOnce(async (items: any[]) => items);
      (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce(command);
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Run');
      outputLines.length = 0;
      await vscode.commands.executeCommand('sshLite.batchRun');
      return outText();
    }

    it('returns one result block per host', async () => {
      const out = await runBatch('echo user=$(whoami)');
      expect(out).toMatch(/\[db\] ──\nuser=admin/);
      expect(out).toMatch(/\[api\] ──\nuser=testuser/);
      expect(out).toContain('Batch complete');
    }, 30000);

    it('a failing host is reported as FAILED and the other host still returns its result', async () => {
      await db.exec(`touch ${REMOTE_DIR}/only-on-db`);
      const out = await runBatch(`test -f ${REMOTE_DIR}/only-on-db && echo present || { echo missing-here >&2; exit 1; }`);
      expect(out).toMatch(/\[db\] ──\npresent/);
      expect(out).toMatch(/\[api\] ── FAILED/);
      expect(out).toContain('missing-here');
      expect(out).toContain('Batch complete');
    }, 30000);

    it('a host whose session died mid-batch fails cleanly without hiding the others', async () => {
      const dead = await connect(S_API);
      (dead as any).host = { ...dead.host, id: 'sp-dead', name: 'dead' };
      mgrConns().set('sp-dead', dead);
      mgrConns().delete(S_API.id); // keep exactly two hosts: db + dead
      (dead as any)._client = undefined; // state still 'connected', transport gone
      try {
        const out = await runBatch('echo alive');
        expect(out).toMatch(/\[db\] ──\nalive/);
        expect(out).toMatch(/\[dead\] ── FAILED/);
      } finally {
        mgrConns().delete('sp-dead');
        mgrConns().set(S_API.id, api);
      }
    }, 30000);

    it('connecting to a wrong-port host rejects with a clean error (no hang, no crash)', async () => {
      const t0 = Date.now();
      await expect(connect(S_API, 2299)).rejects.toBeTruthy();
      expect(Date.now() - t0).toBeLessThan(20000);
    }, 30000);
  });

  // ───────────────────────── C. port forwarding ─────────────────────────

  describe('PortForwardService', () => {
    let svc: PortForwardService;
    let tree: { addForward: jest.Mock; removeForward: jest.Mock; getForwardsForConnection: jest.Mock };
    let rows: Array<{ localPort: number; connectionId: string }> = [];
    const gState: Record<string, unknown> = {};

    beforeEach(() => {
      (PortForwardService as any)._instance = undefined;
      svc = PortForwardService.getInstance();
      svc.initialize({
        globalState: {
          get: (k: string) => gState[k],
          update: async (k: string, v: unknown) => { gState[k] = v; },
          keys: () => Object.keys(gState),
        },
      } as any);
      rows = [];
      mgrConns().set(pf.id, pf);
      tree = {
        addForward: jest.fn((cid: string, lp: number) => { rows.push({ localPort: lp, connectionId: cid }); }),
        removeForward: jest.fn((lp: number, cid: string) => { rows = rows.filter((r) => !(r.localPort === lp && r.connectionId === cid)); }),
        getForwardsForConnection: jest.fn((cid: string) => rows.filter((r) => r.connectionId === cid)),
      };
      svc.setTreeProvider(tree as any);
      (vscode.window.showErrorMessage as jest.Mock).mockReset().mockResolvedValue(undefined);
    });

    afterEach(async () => {
      for (const p of pf.getActiveForwards()) { await pf.stopForward(p); }
      mgrConns().delete(pf.id);
    });

    it('[BUG] tells the user when the server refuses to open the tunnel channel (AllowTcpForwarding no)', async () => {
      // db (shared Alpine server) has AllowTcpForwarding no. forwardPort() happily reports success
      // and every connection silently dies; forwardOut errors are only written to the log.
      const lp = await freePort();
      (vscode.window.showWarningMessage as jest.Mock).mockClear();
      await svc.forwardPort(db, lp, '127.0.0.1', 22);
      const s = await dial(lp);
      s.on('error', () => undefined);
      s.write('x');
      await new Promise((r) => setTimeout(r, 2500));
      s.destroy();
      await db.stopForward(lp);
      const told = (vscode.window.showErrorMessage as jest.Mock).mock.calls.length
        + (vscode.window.showWarningMessage as jest.Mock).mock.calls.length;
      expect(told).toBeGreaterThan(0);
    }, 30000);

    const fwd = (lp: number, rp: number): any =>
      ({ connectionId: pf.id, localPort: lp, remoteHost: '127.0.0.1', remotePort: rp });

    it('round-trips real bytes (incl. 1 MB) and frees the local port after stop', async () => {
      const lp = await freePort();
      await svc.forwardPort(pf, lp, '127.0.0.1', ECHO_PORT);
      expect(pf.getActiveForwards()).toContain(lp);
      expect(tree.addForward).toHaveBeenCalledWith(pf.id, lp, '127.0.0.1', ECHO_PORT);
      expect(svc.getSavedRules(pf.id).some((r) => r.localPort === lp)).toBe(true);

      const s = await dial(lp);
      const small = await sendAndCollect(s, Buffer.from('hello-tunnel\n'), 13, 5000);
      expect(small.toString()).toBe('hello-tunnel\n');
      const big = Buffer.alloc(1024 * 1024);
      for (let i = 0; i < big.length; i++) { big[i] = (i * 31 + 7) & 0xff; }
      const echoed = await sendAndCollect(s, big, big.length, 20000);
      expect(echoed.length).toBe(big.length);
      expect(echoed.equals(big)).toBe(true);
      s.destroy();

      await svc.stopForward(fwd(lp, ECHO_PORT));
      expect(pf.getActiveForwards()).not.toContain(lp);
      expect(await isPortFree(lp)).toBe(true);
      await expect(dial(lp)).rejects.toBeTruthy();
      expect(svc.getSavedRules(pf.id).some((r) => r.localPort === lp)).toBe(true); // rule kept for reactivation
    }, 60000);

    it('[BUG] stopping a forward also closes already-established tunnel connections', async () => {
      // server.close() only stops accepting; piped sockets stay alive, so a "stopped" forward
      // keeps carrying traffic through a tunnel the user believes is closed.
      const lp = await freePort();
      await svc.forwardPort(pf, lp, '127.0.0.1', ECHO_PORT);
      const s = await dial(lp);
      expect((await sendAndCollect(s, Buffer.from('a\n'), 2, 5000)).toString()).toBe('a\n');
      let closed = false;
      s.on('close', () => { closed = true; });
      await svc.stopForward(fwd(lp, ECHO_PORT));
      const stillWorks = (await sendAndCollect(s, Buffer.from('b\n'), 2, 1500)).toString() === 'b\n';
      s.destroy();
      expect(closed || !stillWorks).toBe(true);
    }, 30000);

    it('local port already in use: clean error, no saved rule, no tree row, original owner untouched', async () => {
      const blocker = net.createServer();
      await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
      const lp = (blocker.address() as net.AddressInfo).port;
      try {
        await expect(svc.forwardPort(pf, lp, '127.0.0.1', ECHO_PORT)).resolves.toBeUndefined();
        expect(vscode.window.showErrorMessage).toHaveBeenCalledTimes(1);
        expect(String((vscode.window.showErrorMessage as jest.Mock).mock.calls[0][0])).toMatch(/EADDRINUSE|address already in use|Failed to start port forward/i);
        expect(pf.getActiveForwards()).not.toContain(lp);
        expect(tree.addForward).not.toHaveBeenCalled();
        expect(svc.getSavedRules(pf.id).some((r) => r.localPort === lp)).toBe(false);
        expect(blocker.listening).toBe(true);
      } finally {
        await new Promise<void>((r) => blocker.close(() => r()));
      }
    }, 30000);

    it('forwarding the same local port twice is rejected cleanly and keeps the first tunnel working', async () => {
      const lp = await freePort();
      await svc.forwardPort(pf, lp, '127.0.0.1', ECHO_PORT);
      await svc.forwardPort(pf, lp, '127.0.0.1', ECHO_PORT);
      expect(String((vscode.window.showErrorMessage as jest.Mock).mock.calls[0]?.[0])).toMatch(/already forwarded/i);
      const s = await dial(lp);
      expect((await sendAndCollect(s, Buffer.from('still\n'), 6, 5000)).toString()).toBe('still\n');
      s.destroy();
    }, 30000);

    it('remote target refused: client socket is closed, no crash, tunnel keeps working afterwards', async () => {
      const lp = await freePort();
      const lp2 = await freePort();
      await svc.forwardPort(pf, lp, '127.0.0.1', REFUSED_PORT);
      await svc.forwardPort(pf, lp2, '127.0.0.1', ECHO_PORT);
      const s = await dial(lp);
      const closed = new Promise<boolean>((res) => {
        s.on('error', () => undefined);
        s.once('close', () => res(true));
        setTimeout(() => res(false), 8000);
      });
      s.write('x');
      expect(await closed).toBe(true);
      // the listener on the refused tunnel is still alive (accepts another client) and the sibling works
      const again = await dial(lp);
      again.on('error', () => undefined);
      again.destroy();
      const ok = await dial(lp2);
      expect((await sendAndCollect(ok, Buffer.from('ok\n'), 3, 5000)).toString()).toBe('ok\n');
      ok.destroy();
      expect(await pf.exec('echo conn-alive')).toContain('conn-alive');
    }, 40000);

    it('stopping every forward leaves no local listener behind (no leaked listeners)', async () => {
      const ports = [await freePort(), await freePort(), await freePort()];
      for (const p of ports) { await svc.forwardPort(pf, p, '127.0.0.1', REFUSED_PORT); }
      expect([...pf.getActiveForwards()].sort()).toEqual([...ports].sort());
      await svc.deactivateAllForwardsForConnection(pf.id);
      expect(pf.getActiveForwards()).toEqual([]);
      for (const p of ports) { expect(await isPortFree(p)).toBe(true); }
    }, 30000);

    it('disconnect frees forwarded local ports', async () => {
      const tmp = await connect(S_API);
      const lp = await freePort();
      await tmp.forwardPort(lp, '127.0.0.1', 22);
      expect(await isPortFree(lp)).toBe(false);
      tmp.disconnect();
      expect(await waitFor(() => isPortFree(lp), 3000)).toBe(true);
    }, 30000);
  });
});
