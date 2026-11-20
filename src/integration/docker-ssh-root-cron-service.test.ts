/**
 * Docker integration test: Save-as-Root, crontab save, service actions and sudo kill.
 *
 * These old features previously had mock-only coverage. This file drives them against a
 * real sshd + real sudo (container sshlite-test-sudo, port 2204; see
 * test-docker/Dockerfile.sshd-sudo) and a plain sshd (hybr8-prod-db-01, port 2203).
 *
 *  1. FileService.saveAsRootCommand (+ SSHConnection.sudoWriteFile): exact bytes (multi-byte
 *     UTF-8, quotes, `$`, backticks, empty, binary/NUL), owner and mode of the pre-existing
 *     root-owned 0644 / 0600 targets are preserved, `runAsUser` writes, and the sudo password
 *     never appears in the output channel, user-facing messages, the file, or temp files.
 *  2. saveCrontab (reached through the real `sshLite.saveRemoteCron` command): `crontab -l`
 *     equals the saved text exactly (incl. `%`, quotes, empty); the /tmp/sshlite-cron-* temp
 *     file is removed on success and on failure. Alpine/busybox crontab is not setuid, so a
 *     non-root user gets a REAL "must be suid" failure, which is how the failure path is driven.
 *  3. SystemToolsService.killProcess / runServiceAction: injection-shaped signals and service
 *     names are rejected before any remote command; sudo kill really kills a root-owned
 *     `sleep`; the container has no systemd, so service actions fail gracefully.
 *
 * Tests titled "issue regression" assert the CORRECT behaviour and failed on the pre-fix code.
 *
 * Isolation: only /tmp/sshlite-it-root/ is created (and removed); root's crontab is restored.
 * Run: npx jest --config <docker config> --no-coverage docker-ssh-root-cron-service
 */

import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { ConnectionManager } from '../connection/ConnectionManager';
import { FileService } from '../services/FileService';
import { SystemToolsService } from '../services/SystemToolsService';
import { CredentialService, SavedCredential } from '../services/CredentialService';
import { registerEnvAndCronCommands } from '../commands/envAndCronCommands';
import { CRON_SCHEME, buildUri } from '../providers/VirtualDocProviders';
import { setDiagOutputChannel } from '../utils/diagnosticLog';
import { IHostConfig } from '../types';

var HOST = '127.0.0.1';
var SUDO_PORT = 2204;
var DIR = '/tmp/sshlite-it-root';

type U = { id: string; username: string; password: string; port: number };
var ROOT: U = { id: 'rcs-root', username: 'root', password: 'rootpw', port: SUDO_PORT };
var NOPW: U = { id: 'rcs-nopw', username: 'usernopasswd', password: 'nopw', port: SUDO_PORT };
var PW: U = { id: 'rcs-pw', username: 'userpasswd', password: 'pwsecret', port: SUDO_PORT };
var ADMIN: U = { id: 'rcs-admin', username: 'admin', password: 'adminpass', port: 2203 };

var _knownHosts: Record<string, unknown> = {};
var logLines: string[] = [];
var sudoPwCache: Record<string, string> = {};

function setupMocks(): void {
  setGlobalState({
    get: <T>(key: string, def?: T) => (_knownHosts[key] as T) ?? (def as T),
    update: async (k: string, v: unknown) => { _knownHosts[k] = v; },
    keys: () => Object.keys(_knownHosts),
  } as vscode.Memento);
  (CredentialService as any)._instance = {
    getCredentialSecret: jest.fn().mockResolvedValue('placeholder'),
    getOrPrompt: jest.fn().mockResolvedValue('placeholder'),
    initialize: jest.fn(),
    getSudoPasswordCached: jest.fn((hostId: string) => sudoPwCache[hostId] ?? null),
    promptSudoPassword: jest.fn(async () => null),
    cacheSudoPassword: jest.fn(),
    clearSudoPassword: jest.fn(),
  };
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
  setDiagOutputChannel({
    appendLine: (l: string) => { logLines.push(l); },
    append: (l: string) => { logLines.push(l); },
    show: () => undefined, hide: () => undefined, clear: () => undefined, dispose: () => undefined,
    name: 'test', replace: () => undefined,
  } as unknown as vscode.OutputChannel);
}

async function mkConn(u: U): Promise<SSHConnection> {
  const host: IHostConfig = { id: u.id, name: u.id, host: HOST, port: u.port, username: u.username, source: 'saved' };
  const cred: SavedCredential = { id: u.id + '-pw', label: 'pw', type: 'password' };
  (CredentialService.getInstance() as any).getCredentialSecret = jest.fn(() => Promise.resolve(u.password));
  const c = new SSHConnection(host, cred);
  await c.connect();
  return c;
}

/** Run a command, never throw; returns stdout (or a marker string on failure). */
async function sh(c: SSHConnection, cmd: string): Promise<string> {
  try { return await c.exec(cmd); } catch (e) { return 'EXEC-FAILED: ' + (e as Error).message; }
}

function userVisibleMessages(): string {
  const w = [
    ...(vscode.window.showErrorMessage as jest.Mock).mock.calls,
    ...(vscode.window.showWarningMessage as jest.Mock).mock.calls,
    ...(vscode.window.showInformationMessage as jest.Mock).mock.calls,
    ...(vscode.window.setStatusBarMessage as jest.Mock).mock.calls,
  ];
  return JSON.stringify(w);
}

function mapping(connId: string, remotePath: string): any {
  return { connectionId: connId, remotePath, localPath: 'C:/nope/' + remotePath.split('/').pop(), lastSyncTime: Date.now() };
}

var root: SSHConnection;
var nopw: SSHConnection;
var pw: SSHConnection;
var fileService: FileService;
var originalRootCron: string | null = null;

beforeAll(async () => {
  setupMocks();
  root = await mkConn(ROOT);
  nopw = await mkConn(NOPW);
  pw = await mkConn(PW);
  fileService = FileService.getInstance();
  await sh(root, `rm -rf ${DIR}; mkdir -p ${DIR} && chmod 755 ${DIR}`);
  // Remember root's crontab so afterAll can restore it.
  const cur = await sh(root, 'crontab -l 2>/dev/null && echo __HAS__ || echo __NONE__');
  originalRootCron = cur.endsWith('__HAS__\n') ? cur.slice(0, -'__HAS__\n'.length) : null;
}, 60000);

afterAll(async () => {
  try {
    if (originalRootCron === null) { await sh(root, 'crontab -r 2>/dev/null; true'); }
    else {
      const b64 = Buffer.from(originalRootCron, 'utf8').toString('base64');
      await sh(root, `echo '${b64}' | base64 -d | crontab -`);
    }
    await sh(root, `pkill -f 'sleep 313[7]' 2>/dev/null; rm -rf ${DIR}`);
  } catch { /* best effort */ }
  for (const c of [root, nopw, pw]) { try { await c.disconnect(); } catch { /* ignore */ } }
});

beforeEach(() => {
  logLines = [];
  sudoPwCache = {};
  jest.clearAllMocks();
});

// ───────────────────────── 1. Save as root ─────────────────────────

describe('saveAsRootCommand (real sudo)', () => {
  var TRICKY = [
    'héllo wörld — 日本語 😀 ünïcödé',
    "it's a 'single' \"double\" $HOME ${PATH} `backtick` $(touch " + DIR + '/pwn) \\n \\\\',
    'line with trailing spaces   ',
    'no trailing newline',
  ].join('\n');

  async function fixture(name: string, mode: string, owner = 'root:root'): Promise<string> {
    const p = `${DIR}/${name}`;
    const out = await sh(root, `printf 'ORIGINAL' > '${p}' && chown ${owner} '${p}' && chmod ${mode} '${p}' && echo ok`);
    expect(out.trim()).toBe('ok');
    return p;
  }
  async function stat(p: string): Promise<string> {
    return (await sh(root, `stat -c '%U:%G %a' '${p}'`)).trim();
  }

  async function assertNoLeak(secret: string): Promise<void> {
    expect(logLines.join('\n')).not.toContain(secret);
    expect(userVisibleMessages()).not.toContain(secret);
    // Only our own fixtures (f-*) may live in the dir: no leftover sudo temp files.
    const listing = (await sh(root, `ls -A ${DIR}`)).split('\n').filter(Boolean);
    expect(listing.filter((n) => !n.startsWith('f-'))).toEqual([]);
    const hit = await sh(root, `grep -rlF '${secret}' ${DIR} 2>/dev/null; true`);
    expect(hit.trim()).toBe('');
  }

  it('NOPASSWD user: exact content, root:root 0644 preserved, password never leaks', async () => {
    const p = await fixture('f-644', '644');
    const SECRET = 'LEAK-SENTINEL-nopw-91c2';
    sudoPwCache[nopw.host.id] = SECRET;
    await fileService.saveAsRootCommand(nopw, mapping(nopw.id, p), TRICKY);

    expect((await root.readFile(p)).toString('utf8')).toBe(TRICKY);
    expect(await stat(p)).toBe('root:root 644');
    expect((await sh(root, `test -e ${DIR}/pwn && echo PWNED || echo clean`)).trim()).toBe('clean');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    await assertNoLeak(SECRET);
  }, 30000);

  it('password-sudo user: exact content, root:root 0600 preserved, real password never leaks', async () => {
    await sh(pw, 'sudo -k');
    const p = await fixture('f-600', '600');
    sudoPwCache[pw.host.id] = PW.password;
    await fileService.saveAsRootCommand(pw, mapping(pw.id, p), TRICKY);

    expect((await root.readFile(p)).toString('utf8')).toBe(TRICKY);
    expect(await stat(p)).toBe('root:root 600');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    await assertNoLeak(PW.password);
  }, 30000);

  it('empty content truncates the file without touching owner/mode', async () => {
    const p = await fixture('f-empty', '640');
    sudoPwCache[nopw.host.id] = 'x';
    await fileService.saveAsRootCommand(nopw, mapping(nopw.id, p), '');
    expect((await root.readFile(p)).length).toBe(0);
    expect(await stat(p)).toBe('root:root 640');
  }, 30000);

  it('binary content (NUL bytes) path keeps bytes, owner and mode', async () => {
    const p = await fixture('f-bin', '600');
    const bytes = Buffer.from([0x00, 0xff, 0x41, 0x0a, 0x00, 0x27, 0x24]);
    await nopw.sudoWriteFile(p, bytes, 'x');
    expect(Buffer.compare(await root.readFile(p), bytes)).toBe(0);
    expect(await stat(p)).toBe('root:root 600');
  }, 30000);

  it('"Save as User" (runAsUser) writes as that user and keeps its ownership', async () => {
    const p = await fixture('f-target', '640', 'targetuser:targetuser');
    sudoPwCache[nopw.host.id] = 'x';
    await fileService.saveAsRootCommand(nopw, mapping(nopw.id, p), TRICKY, 'targetuser');
    expect((await root.readFile(p)).toString('utf8')).toBe(TRICKY);
    expect(await stat(p)).toBe('targetuser:targetuser 640');
  }, 30000);

  it('wrong sudo password: no file change, error shown, cached password cleared', async () => {
    await sh(pw, 'sudo -k');
    const p = await fixture('f-wrong', '644');
    sudoPwCache[pw.host.id] = 'definitely-wrong-pw';
    await fileService.saveAsRootCommand(pw, mapping(pw.id, p), 'SHOULD-NOT-LAND');
    expect((await root.readFile(p)).toString('utf8')).toBe('ORIGINAL');
    expect(vscode.window.showErrorMessage).toHaveBeenCalled();
    expect((CredentialService.getInstance() as any).clearSudoPassword).toHaveBeenCalledWith(pw.host.id);
    expect(userVisibleMessages()).not.toContain('definitely-wrong-pw');
    expect(logLines.join('\n')).not.toContain('definitely-wrong-pw');
  }, 30000);
});

// ───────────────────────── 2. Crontab save ─────────────────────────

describe('saveCrontab via sshLite.saveRemoteCron (real crontab)', () => {
  var disposables: vscode.Disposable[] = [];
  var current: { conn: SSHConnection; text: string } | undefined;
  var getConnSpy: jest.SpyInstance;

  beforeAll(() => {
    disposables = registerEnvAndCronCommands({
      log: () => undefined, logResult: () => undefined, envProvider: {} as any, cronProvider: {} as any,
      outputChannel: { appendLine: () => undefined } as any,
    });
    getConnSpy = jest.spyOn(ConnectionManager.getInstance(), 'getConnection').mockImplementation((id: string) =>
      current && current.conn.id === id ? current.conn : undefined);
  });
  afterAll(() => {
    disposables.forEach((d) => d.dispose());
    getConnSpy.mockRestore();
    (vscode.window as any).activeTextEditor = undefined;
  });

  async function save(conn: SSHConnection, text: string): Promise<string[]> {
    current = { conn, text };
    (vscode.window as any).activeTextEditor = {
      document: { uri: buildUri(CRON_SCHEME, conn.id, 'crontab-x.cron'), getText: () => text },
    };
    const tmpPaths: string[] = [];
    const orig = conn.writeFile.bind(conn);
    const spy = jest.spyOn(conn, 'writeFile').mockImplementation(async (p: string, b: Buffer) => {
      if (p.startsWith('/tmp/sshlite-cron-')) { tmpPaths.push(p); }
      return orig(p, b);
    });
    try { await vscode.commands.executeCommand('sshLite.saveRemoteCron'); } finally { spy.mockRestore(); }
    return tmpPaths;
  }
  async function exists(p: string): Promise<boolean> {
    return (await sh(root, `test -e '${p}' && echo yes || echo no`)).trim() === 'yes';
  }
  async function crontabL(): Promise<string> {
    return sh(root, 'crontab -l 2>/dev/null; true');
  }

  it('saves exact text incl. %, quotes and $; temp file removed on success', async () => {
    const text = [
      '# comment ünï 日本',
      "*/5 * * * * echo 'it'\"s\" 100% done $HOME >> /tmp/x.log 2>&1",
      '0 3 * * * date +\\%Y-\\%m-\\%d',
      '',
    ].join('\n');
    const tmps = await save(root, text);
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(await crontabL()).toBe(text);
    expect(tmps).toHaveLength(1);
    expect(await exists(tmps[0])).toBe(false);
  }, 30000);

  it('saving an empty buffer leaves an empty crontab and no temp file', async () => {
    await save(root, '* * * * * true\n');
    const tmps = await save(root, '');
    expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    expect(await crontabL()).toBe('');
    expect(await exists(tmps[0])).toBe(false);
  }, 30000);

  it('crontab failure (non-setuid busybox for a normal user): error shown, temp file removed', async () => {
    const before = await crontabL();
    const tmps = await save(nopw, '* * * * * true\n');
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to save crontab'));
    expect(tmps).toHaveLength(1);
    expect(await exists(tmps[0])).toBe(false);
    expect(await crontabL()).toBe(before); // root's crontab untouched
  }, 30000);

  it('crontab failure on the plain sshd server (2203) also cleans up the temp file', async () => {
    const admin = await mkConn(ADMIN);
    try {
      const tmps = await save(admin, '* * * * * true\n');
      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('Failed to save crontab'));
      expect(tmps).toHaveLength(1);
      expect((await sh(admin, `test -e '${tmps[0]}' && echo yes || echo no`)).trim()).toBe('no');
    } finally { await admin.disconnect(); }
  }, 30000);
});

// ───────────────── 3. Service actions + sudo kill ─────────────────

describe('SystemToolsService.killProcess / runServiceAction', () => {
  var svc: SystemToolsService;
  var PWN = '/tmp/sshlite-it-root/pwn-injection';
  beforeAll(() => { svc = SystemToolsService.getInstance(); });

  async function startRootSleep(): Promise<number> {
    const out = await sh(root, 'setsid sleep 3137 >/dev/null 2>&1 </dev/null & echo $!');
    const pid = parseInt(out.trim(), 10);
    expect(pid).toBeGreaterThan(1);
    return pid;
  }
  async function alive(pid: number): Promise<boolean> {
    const s = await sh(root, `cat /proc/${pid}/stat 2>/dev/null | cut -d' ' -f3`);
    return s.trim() !== '' && s.trim() !== 'Z';
  }
  async function waitDead(pid: number): Promise<boolean> {
    for (let i = 0; i < 20; i++) { if (!(await alive(pid))) { return true; } await new Promise((r) => setTimeout(r, 150)); }
    return false;
  }

  it('rejects injection-shaped signals and bad pids before touching the server', async () => {
    const spy = jest.spyOn(nopw, 'exec');
    const spy2 = jest.spyOn(nopw, 'sudoExec');
    for (const sig of ['TERM; touch ' + PWN, 'TERM && id', '$(id)', 'term', '-9', '', 'KILL ']) {
      await expect(svc.killProcess(nopw, 99999, true, sig)).rejects.toThrow(/Invalid signal/);
      await expect(svc.killProcess(nopw, 99999, false, sig)).rejects.toThrow(/Invalid signal/);
    }
    for (const pid of [0, -1, NaN, Infinity, 2 ** 22 + 1, ('1; touch ' + PWN) as unknown as number]) {
      await expect(svc.killProcess(nopw, pid, true)).rejects.toThrow(/Invalid PID/);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
    spy.mockRestore(); spy2.mockRestore();
    expect((await sh(root, `test -e ${PWN} && echo PWNED || echo clean`)).trim()).toBe('clean');
  }, 30000);

  it('rejects injection-shaped service names before any remote command', async () => {
    const spy = jest.spyOn(nopw, 'exec');
    const spy2 = jest.spyOn(nopw, 'sudoExec');
    for (const name of ['x; touch ' + PWN, 'x && touch ' + PWN, '$(touch ' + PWN + ')', 'a b', 'x\ntouch ' + PWN, '`id`', '', 'x|id', "x'y"]) {
      await expect(svc.runServiceAction(nopw, name, 'status', false)).rejects.toThrow(/Invalid service name/);
      await expect(svc.runServiceAction(nopw, name, 'restart', true)).rejects.toThrow(/Invalid service name/);
    }
    expect(spy).not.toHaveBeenCalled();
    expect(spy2).not.toHaveBeenCalled();
    spy.mockRestore(); spy2.mockRestore();
    expect((await sh(root, `test -e ${PWN} && echo PWNED || echo clean`)).trim()).toBe('clean');
  }, 30000);

  it('no service manager in the container: listServices is empty, actions fail gracefully', async () => {
    expect((await sh(root, 'command -v systemctl || echo none')).trim()).toBe('none');
    expect(await svc.listServices(nopw)).toEqual([]);
    await expect(svc.runServiceAction(nopw, 'nginx.service', 'status', false)).rejects.toThrow();
    await expect(svc.runServiceAction(nopw, 'sshd@1:x_y-z.service', 'status', false)).rejects.toThrow();
    nopw.enableSudoMode('nopw');
    try {
      await expect(svc.runServiceAction(nopw, 'nginx', 'restart', true)).rejects.toThrow();
    } finally { nopw.disableSudoMode(); }
    expect((await nopw.exec('echo alive')).trim()).toBe('alive');
  }, 40000);

  it('plain kill of a root-owned process is refused and the process survives', async () => {
    const pid = await startRootSleep();
    try {
      await expect(svc.killProcess(nopw, pid, false)).rejects.toThrow();
      expect(await alive(pid)).toBe(true);
    } finally { await sh(root, `kill -9 ${pid}`); }
  }, 30000);

  it('sudo kill (NOPASSWD, sudo mode on) really kills a root-owned sleep', async () => {
    const pid = await startRootSleep();
    nopw.enableSudoMode('nopw');
    try {
      await svc.killProcess(nopw, pid, true);
      expect(await waitDead(pid)).toBe(true);
    } finally { nopw.disableSudoMode(); await sh(root, `kill -9 ${pid} 2>/dev/null; true`); }
  }, 30000);

  it('sudo kill with an explicit signal (KILL) works', async () => {
    const pid = await startRootSleep();
    nopw.enableSudoMode('nopw');
    try {
      await svc.killProcess(nopw, pid, true, 'KILL');
      expect(await waitDead(pid)).toBe(true);
    } finally { nopw.disableSudoMode(); await sh(root, `kill -9 ${pid} 2>/dev/null; true`); }
  }, 30000);

  it('password-sudo user with sudo mode enabled can sudo kill', async () => {
    await sh(pw, 'sudo -k');
    const pid = await startRootSleep();
    pw.enableSudoMode(PW.password);
    try {
      await svc.killProcess(pw, pid, true);
      expect(await waitDead(pid)).toBe(true);
    } finally { pw.disableSudoMode(); await sh(root, `kill -9 ${pid} 2>/dev/null; true`); }
  }, 30000);

  // Fixed bug: "Kill (sudo)" (processAndServiceCommands.ts:37) and service start/stop/restart
  // (:77) call killProcess/runServiceAction(useSudo=true) WITHOUT ever asking for a password.
  // SystemToolsService passes `connection.sudoPassword || ''`, which is '' unless the user
  // happened to enable "Sudo All" earlier. For a password-requiring sudo user the empty password
  // is sent to sudo -> "Incorrect sudo password" and the kill never happens. Expected: the
  // service should obtain/prompt for the password (like FileService.getSudoPassword does).
  it('issue regression: sudo kill for a password-sudo user WITHOUT sudo mode should still work (prompt for password)', async () => {
    await sh(pw, 'sudo -k');
    expect(pw.sudoPassword).toBeNull();
    (CredentialService.getInstance() as any).promptSudoPassword = jest.fn(async () => PW.password);
    sudoPwCache[pw.host.id] = PW.password;
    const pid = await startRootSleep();
    try {
      await svc.killProcess(pw, pid, true);
      expect(await waitDead(pid)).toBe(true);
    } finally { await sh(root, `kill -9 ${pid} 2>/dev/null; true`); }
  }, 30000);
});
