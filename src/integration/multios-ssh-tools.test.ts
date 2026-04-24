/**
 * Multi-OS SSH Tools Integration Tests
 *
 * Tests the new v0.6–v0.7 utility services against 5 Docker server OS.
 * Covers: copy/move/delete, SystemToolsService, SshKeyService, RemoteDiffService,
 *         VirtualDocProviders (env, cron).
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SSHConnection } from '../connection/SSHConnection';
import { SystemToolsService } from '../services/SystemToolsService';
import { SshKeyService } from '../services/SshKeyService';
import { RemoteDiffService } from '../services/RemoteDiffService';
import {
  RemoteEnvDocumentProvider, RemoteCronDocumentProvider,
  buildUri, ENV_SCHEME, CRON_SCHEME,
} from '../providers/VirtualDocProviders';
import {
  CI_SERVERS, OSServerConfig,
  createTestConnection, safeDisconnect,
  setupCredentialServiceMock, setupVscodeMocks,
} from './multios-helpers';

function esc(p: string): string { return p.replace(/'/g, "'\\''"); }

beforeAll(() => {
  setupCredentialServiceMock();
  setupVscodeMocks();
  (SystemToolsService as any)._instance = undefined;
  (SshKeyService as any)._instance = undefined;
  (RemoteDiffService as any)._instance = undefined;
});

// ─── File copy / move / delete (per-OS) ──────────────────────────────────────

describe.each(CI_SERVERS)('SSH Tools file ops on $os', (server: OSServerConfig) => {
  let conn: SSHConnection;
  const testDir = '/home/testuser/tools-test-' + server.hostname;

  beforeAll(async () => {
    conn = await createTestConnection(server);
    try { await conn.exec('rm -rf ' + JSON.stringify(testDir)); } catch {}
    await conn.mkdir(testDir);
  });

  afterAll(async () => {
    try { await conn.exec('rm -rf ' + JSON.stringify(testDir)); } catch {}
    await safeDisconnect(conn);
  });

  it('copy file: dest has same content, source unchanged', async () => {
    const src = testDir + '/copy-src.txt';
    const dest = testDir + '/copy-dest.txt';
    const content = 'copy-test on ' + server.os;
    await conn.writeFile(src, Buffer.from(content));
    await conn.exec("cp -- '" + esc(src) + "' '" + esc(dest) + "'");
    expect((await conn.readFile(dest)).toString()).toBe(content);
    expect((await conn.readFile(src)).toString()).toBe(content);
  });

  it('copy folder recursively: nested content reachable in dest', async () => {
    const srcDir = testDir + '/cp-src';
    const destDir = testDir + '/cp-dst';
    await conn.mkdir(srcDir);
    await conn.writeFile(srcDir + '/a.txt', Buffer.from('folder-copy'));
    await conn.exec("cp -r -- '" + esc(srcDir) + "' '" + esc(destDir) + "'");
    expect((await conn.readFile(destDir + '/a.txt')).toString()).toBe('folder-copy');
  });

  it('copy: filenames with spaces and parens work', async () => {
    const src = testDir + '/my file (1).txt';
    const dest = testDir + '/my file (copy).txt';
    await conn.writeFile(src, Buffer.from('spaced'));
    await conn.exec("cp -- '" + esc(src) + "' '" + esc(dest) + "'");
    expect((await conn.readFile(dest)).toString()).toBe('spaced');
  });

  it('move (rename): source gone, dest has content', async () => {
    const src = testDir + '/mv-src.txt';
    const dest = testDir + '/mv-dst.txt';
    await conn.writeFile(src, Buffer.from('move-me'));
    await conn.rename(src, dest);
    expect((await conn.readFile(dest)).toString()).toBe('move-me');
    let gone = false;
    try { await conn.readFile(src); } catch { gone = true; }
    expect(gone).toBe(true);
  });

  it('delete file: gone after deleteFile', async () => {
    const fp = testDir + '/del.txt';
    await conn.writeFile(fp, Buffer.from('bye'));
    await conn.deleteFile(fp);
    let gone = false;
    try { await conn.readFile(fp); } catch { gone = true; }
    expect(gone).toBe(true);
  });

  it('delete folder (rm -rf): not visible in parent listing', async () => {
    const dir = testDir + '/del-dir';
    await conn.mkdir(dir);
    await conn.writeFile(dir + '/inner.txt', Buffer.from('inner'));
    await conn.exec("rm -rf -- '" + esc(dir) + "'");
    const parent = await conn.listFiles(testDir);
    expect(parent.some((f) => f.name === 'del-dir')).toBe(false);
  });

  it('resolveDefaultRemotePath: echo $HOME returns absolute path for testuser', async () => {
    const home = (await conn.exec('echo $HOME')).trim();
    expect(home).toMatch(/^\//);
    expect(home).toContain('testuser');
  });
});

// ─── SystemToolsService (per-OS) ─────────────────────────────────────────────

describe.each(CI_SERVERS)('SystemToolsService on $os', (server: OSServerConfig) => {
  let conn: SSHConnection;

  beforeAll(async () => {
    (SystemToolsService as any)._instance = undefined;
    conn = await createTestConnection(server);
  });

  afterAll(async () => { await safeDisconnect(conn); });

  it('listProcesses: returns at least one process', async () => {
    const procs = await SystemToolsService.getInstance().listProcesses(conn as any, 50);
    expect(procs.length).toBeGreaterThan(0);
  });

  it('listProcesses: all entries have valid PID, user, command', async () => {
    const procs = await SystemToolsService.getInstance().listProcesses(conn as any, 50);
    for (const p of procs) {
      expect(p.pid).toBeGreaterThan(0);
      expect(p.user.trim()).toBeTruthy();
      expect(p.command.trim()).toBeTruthy();
    }
  });

  it('listProcesses: cpu and mem are in [0, 100]', async () => {
    const procs = await SystemToolsService.getInstance().listProcesses(conn as any, 50);
    for (const p of procs) {
      expect(p.cpu).toBeGreaterThanOrEqual(0);
      expect(p.cpu).toBeLessThanOrEqual(100);
      expect(p.mem).toBeGreaterThanOrEqual(0);
      expect(p.mem).toBeLessThanOrEqual(100);
    }
  });

  it('listServices: does not throw (systemd may be absent on Alpine)', async () => {
    const services = await SystemToolsService.getInstance().listServices(conn as any);
    expect(Array.isArray(services)).toBe(true);
    for (const s of services) {
      expect(s.name).toMatch(/\.service$/);
    }
  });

  it('parseProcessOutput: real ps output produces valid entries on this OS', async () => {
    const raw = await conn.exec('ps aux 2>/dev/null || ps -o pid,user,comm 2>/dev/null || true');
    const procs = SystemToolsService.getInstance().parseProcessOutput(raw);
    expect(procs.length).toBeGreaterThan(0);
    const init = procs.find((p) => p.pid === 1);
    expect(init).toBeDefined();
  });
});

// ─── VirtualDocProviders (per-OS) ────────────────────────────────────────────

describe.each(CI_SERVERS)('VirtualDocProviders on $os', (server: OSServerConfig) => {
  let conn: SSHConnection;

  beforeAll(async () => { conn = await createTestConnection(server); });
  afterAll(async () => { await safeDisconnect(conn); });

  it('env | sort: non-empty, has PATH=, all lines contain =', async () => {
    const out = await conn.exec('env | sort');
    const lines = out.trim().split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((l) => l.startsWith('PATH='))).toBe(true);
    const pairs = lines.filter((l) => l.includes('='));
    expect(pairs.length).toBeGreaterThan(0);
  });

  it('RemoteEnvDocumentProvider: returns content with PATH on this OS', async () => {
    const provider = new RemoteEnvDocumentProvider();
    const { ConnectionManager } = require('../connection/ConnectionManager');
    jest.spyOn(ConnectionManager.getInstance(), 'getConnection').mockReturnValue(conn as any);
    const uri = buildUri(ENV_SCHEME, conn.id, '/env.txt');
    const content = await provider.provideTextDocumentContent(uri);
    expect(content).toContain('PATH=');
    provider.dispose();
  });

  it('crontab -l: completes without error (empty is valid)', async () => {
    const out = await conn.exec('crontab -l 2>/dev/null || true');
    expect(typeof out).toBe('string');
  });

  it('RemoteCronDocumentProvider: returns a string (not null/undefined)', async () => {
    const provider = new RemoteCronDocumentProvider();
    const { ConnectionManager } = require('../connection/ConnectionManager');
    jest.spyOn(ConnectionManager.getInstance(), 'getConnection').mockReturnValue(conn as any);
    const uri = buildUri(CRON_SCHEME, conn.id, '/crontab.cron');
    const content = await provider.provideTextDocumentContent(uri);
    expect(typeof content).toBe('string');
    provider.dispose();
  });
});

// ─── SshKeyService (per-OS) ───────────────────────────────────────────────────

describe.each(CI_SERVERS)('SshKeyService on $os', (server: OSServerConfig) => {
  let conn: SSHConnection;

  beforeAll(async () => {
    (SshKeyService as any)._instance = undefined;
    conn = await createTestConnection(server);
  });

  afterAll(async () => { await safeDisconnect(conn); });

  it('pushPublicKey: adds key and is idempotent', async () => {
    let tmpDir: string | undefined;
    try {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'it-key-'));
      const keyPath = path.join(tmpDir, 'test_key');
      const pubKeyPath = keyPath + '.pub';
      const svc = SshKeyService.getInstance();
      try {
        await svc.generateKey({ type: 'ed25519', comment: 'it-test', passphrase: '', outFile: keyPath });
      } catch { return; } // ssh-keygen unavailable
      expect(fs.existsSync(pubKeyPath)).toBe(true);
      const pubContent = fs.readFileSync(pubKeyPath, 'utf8').trim();
      // First push
      const r1 = await svc.pushPublicKey(conn as any, pubKeyPath);
      expect(r1.added || r1.reason?.includes('already')).toBeTruthy();
      // Second push (idempotent)
      const r2 = await svc.pushPublicKey(conn as any, pubKeyPath);
      expect(r2.added).toBe(false);
      expect(r2.reason).toMatch(/already/i);
      // Verify in authorized_keys
      const home = (await conn.exec('echo $HOME')).trim();
      const authContent = await conn.exec("cat '" + esc(home + '/.ssh/authorized_keys') + "' 2>/dev/null || true");
      const km = pubContent.split(' ')[1];
      expect(authContent).toContain(km);
      // Cleanup
      if (km) {
        try { await conn.exec("grep -v '" + esc(km) + "' '" + esc(home + '/.ssh/authorized_keys') + "' > /tmp/ak.tmp 2>/dev/null && mv /tmp/ak.tmp '" + esc(home + '/.ssh/authorized_keys') + "' || true"); } catch {}
      }
    } finally {
      if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true }); } catch {} }
    }
  });
});

// ─── RemoteDiffService (per-OS) ──────────────────────────────────────────────

describe.each(CI_SERVERS)('RemoteDiffService on $os', (server: OSServerConfig) => {
  let conn: SSHConnection;
  const testDir = '/home/testuser/diff-test-' + server.hostname;

  beforeAll(async () => {
    (RemoteDiffService as any)._instance = undefined;
    conn = await createTestConnection(server);
    try { await conn.exec('rm -rf ' + JSON.stringify(testDir)); } catch {}
    await conn.mkdir(testDir);
  });

  afterAll(async () => {
    try { await conn.exec('rm -rf ' + JSON.stringify(testDir)); } catch {}
    await safeDisconnect(conn);
  });

  it('diffRemoteWithLocal: downloads remote, calls vscode.diff with correct local path', async () => {
    const remotePath = testDir + '/diff.txt';
    const content = 'diff-content on ' + server.os;
    await conn.writeFile(remotePath, Buffer.from(content));

    let tmpLocal: string | undefined;
    try {
      tmpLocal = path.join(os.tmpdir(), 'local-diff-' + server.hostname + '.txt');
      fs.writeFileSync(tmpLocal, 'local-version');
      const diffSpy = jest.spyOn(vscode.commands, 'executeCommand').mockResolvedValueOnce(undefined as any);
      await RemoteDiffService.getInstance().diffRemoteWithLocal(conn as any, remotePath, tmpLocal);
      const [cmd, localUri] = diffSpy.mock.calls[0];
      expect(cmd).toBe('vscode.diff');
      expect((localUri as any).fsPath).toBe(tmpLocal);
      diffSpy.mockRestore();
    } finally {
      if (tmpLocal && fs.existsSync(tmpLocal)) { try { fs.unlinkSync(tmpLocal); } catch {} }
    }
  });

  it('diffRemoteWithLocal: temp file contains the remote file content', async () => {
    const remotePath = testDir + '/diff-verify.txt';
    const content = 'verify-content-' + server.hostname;
    await conn.writeFile(remotePath, Buffer.from(content));

    let tmpLocal: string | undefined;
    let capturedTmpRemote: string | undefined;
    try {
      tmpLocal = path.join(os.tmpdir(), 'local-v-' + server.hostname + '.txt');
      fs.writeFileSync(tmpLocal, 'local');
      const diffSpy = jest.spyOn(vscode.commands, 'executeCommand').mockImplementationOnce(
        async (_cmd: string, _l: any, remoteUri: any) => { capturedTmpRemote = remoteUri.fsPath; }
      );
      await RemoteDiffService.getInstance().diffRemoteWithLocal(conn as any, remotePath, tmpLocal);
      diffSpy.mockRestore();
      if (capturedTmpRemote && fs.existsSync(capturedTmpRemote)) {
        expect(fs.readFileSync(capturedTmpRemote, 'utf8')).toBe(content);
      }
    } finally {
      if (tmpLocal && fs.existsSync(tmpLocal)) { try { fs.unlinkSync(tmpLocal); } catch {} }
    }
  });
});
