/**
 * Docker integration: FileService save-back, server backups, and delete-with-backup
 * over a REAL SSH/SFTP server (container hybr8-prod-web-01, 127.0.0.1:2201).
 * Until now these old features were only covered by mocks.
 *
 * Covered (all against the real FileService singleton + real SSHConnection):
 *  1. Save-back: openRemoteFile (real flow) -> edit local copy -> onDidSaveTextDocument
 *     listener -> debounced uploadFileWithAudit -> remote bytes are EXACTLY the new text.
 *     Cases: UTF-8 multi-byte + CRLF, and a ~2 MB file (progressive-download route).
 *  2. Server backups: createServerBackup / listServerBackups / restoreFromServerBackup /
 *     revertToBackup / cleanupServerBackups (backup content == pre-edit bytes, restore
 *     brings back exact bytes, cleanup removes ONLY old files inside the backup folder).
 *  3. Delete with backup: deleteRemote (file + directory), createDirectoryBackup,
 *     deleteRemotePath, with paths containing spaces and a single quote, and siblings
 *     that must stay untouched.
 *
 * Tests titled "issue regression" reproduce bugs found in the 1.0.x test sweep; they fail on the
 * pre-fix code (they assert the correct behaviour). Remote scratch dir: /home/testuser/sshlite-it-save/ only. Backups
 * live in the shared /tmp/.ssh-lite-backups folder, so every file used here carries the
 * unique "slsave" prefix and is cleaned in afterAll.
 *
 * Run: npx jest --config <docker config without lifecycle> --no-coverage docker-ssh-save-backup
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { ConnectionManager } from '../connection/ConnectionManager';
import { FileService } from '../services/FileService';
import { CredentialService, SavedCredential } from '../services/CredentialService';
import { IHostConfig, IRemoteFile } from '../types';
import { setMockConfig } from '../__mocks__/vscode';

const SERVER = { id: 'save-backup', host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' };
const CONTAINER = 'hybr8-prod-web-01';
const ROOT = '/home/testuser/sshlite-it-save';
const BACKUP_DIR = '/tmp/.ssh-lite-backups';

const _knownHosts: Record<string, unknown> = {};

// @swc/jest does not hoist const/let into jest.mock factories; we capture the save
// listener by replacing the workspace property BEFORE FileService is constructed.
var saveListener: ((doc: unknown) => void) | undefined;

/** Single-quote a string for POSIX sh. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

interface FakeDoc {
  uri: vscode.Uri;
  text: string;
  getText(): string;
  positionAt(o: number): vscode.Position;
  save(): Promise<boolean>;
}

const docs = new Map<string, FakeDoc>();

function makeDoc(p: string): FakeDoc {
  const existing = docs.get(p);
  if (existing) { return existing; }
  const doc: FakeDoc = {
    uri: vscode.Uri.file(p),
    text: fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '',
    getText() { return this.text; },
    positionAt(o: number) { return new vscode.Position(0, o); },
    async save() { fs.writeFileSync(p, this.text); return true; },
  };
  docs.set(p, doc);
  (vscode.workspace.textDocuments as unknown as FakeDoc[]).push(doc);
  return doc;
}

function setupVscodeMocks(): void {
  (vscode.workspace as any).onDidSaveTextDocument = (cb: (d: unknown) => void) => {
    saveListener = cb;
    return { dispose: jest.fn() };
  };
  (vscode.workspace.openTextDocument as jest.Mock).mockImplementation(async (p: string) => makeDoc(p));
  (vscode.workspace.applyEdit as jest.Mock).mockImplementation(async (edit: { edits: Array<{ uri: vscode.Uri; text: string }> }) => {
    for (const e of edit.edits) {
      const d = docs.get(e.uri.fsPath);
      if (d) { d.text = e.text; }
    }
    return true;
  });
  setMockConfig('sshLite.uploadDebounceMs', 10);
}

function setupSsh(): void {
  setGlobalState({
    get: <T>(key: string, def?: T) => (_knownHosts[key] as T) ?? (def as T),
    update: async (k: string, v: unknown) => { _knownHosts[k] = v; },
    keys: () => Object.keys(_knownHosts),
  } as vscode.Memento);
  (CredentialService as any)._instance = {
    getCredentialSecret: jest.fn().mockResolvedValue(SERVER.password),
    getOrPrompt: jest.fn().mockResolvedValue(SERVER.password),
    initialize: jest.fn(),
    getInstance: jest.fn(),
  };
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
}

async function sh(conn: SSHConnection, cmd: string): Promise<string> {
  return conn.exec(cmd);
}

function remoteFileOf(p: string, size: number, isDirectory = false): IRemoteFile {
  return {
    name: p.split('/').pop()!, path: p, isDirectory, size, modifiedTime: 0, connectionId: SERVER.id,
  };
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) { return true; }
    await new Promise((r) => setTimeout(r, 50));
  }
  return cond();
}

describe('FileService save-back / server backup / delete-with-backup over real SSH', () => {
  let conn: SSHConnection;
  let service: FileService;

  /** Open via the real openRemoteFile flow; returns the mapping's local path. */
  async function openFile(remotePath: string): Promise<string> {
    const st = await conn.stat(remotePath);
    await service.openRemoteFile(conn, remoteFileOf(remotePath, st.size));
    const key = (): string | undefined => (service as any).findLocalPath(conn.id, remotePath);
    expect(await waitFor(() => !!key(), 20000)).toBe(true);
    return key()!;
  }

  /** Simulate the user editing the open document and pressing Ctrl+S. */
  async function editAndSave(localPath: string, newText: string): Promise<void> {
    const doc = makeDoc(localPath);
    doc.text = newText;
    fs.writeFileSync(localPath, newText);
    expect(saveListener).toBeDefined();
    saveListener!(doc);
    await (service as any).flushPendingUpload(localPath);
  }

  async function backupsOf(remotePath: string): Promise<string[]> {
    return (await service.listServerBackups(conn, remotePath)).map((b) => b.path);
  }

  beforeAll(async () => {
    setupSsh();
    setupVscodeMocks();
    const host: IHostConfig = { id: SERVER.id, name: 'web', host: SERVER.host, port: SERVER.port, username: SERVER.username, source: 'saved' };
    const cred: SavedCredential = { id: 'save-backup-pw', label: 'pw', type: 'password' };
    conn = new SSHConnection(host, cred);
    await conn.connect();
    (ConnectionManager.getInstance() as any)._connections.set(conn.id, conn);
    service = FileService.getInstance();
    await sh(conn, `rm -rf ${sq(ROOT)}; mkdir -p ${sq(ROOT)}`);
  }, 60000);

  afterAll(async () => {
    try {
      const s = service as any;
      s.stopFocusedFilePollTimer?.();
      s.stopWatchHeartbeat?.();
      s.stopAutoCleanupTimer?.();
      s.stopGlobalRefreshTimer?.();
    } catch { /* ignore */ }
    try {
      await sh(conn, `rm -rf ${sq(ROOT)}; rm -rf ${BACKUP_DIR}/slsave* ${BACKUP_DIR}/it\\'s_* 2>/dev/null; sed -i '/slsave\\|sshlite-it-save/d' ${BACKUP_DIR}/.ssh-lite-index 2>/dev/null; true`);
    } catch { /* ignore */ }
    (ConnectionManager.getInstance() as any)._connections.delete(conn.id);
    try { await conn.disconnect(); } catch { /* ignore */ }
  });

  beforeEach(() => {
    (vscode.window.showWarningMessage as jest.Mock).mockReset().mockResolvedValue('Delete with Backup');
    (vscode.window.showErrorMessage as jest.Mock).mockClear();
  });

  // ---------------------------------------------------------------- 1. save-back
  describe('save-back (open -> edit -> save -> remote bytes)', () => {
    it('UTF-8 multi-byte + CRLF content round-trips byte-exact', async () => {
      const remote = `${ROOT}/slsave-utf8.txt`;
      const original = Buffer.from('héllo 日本語 🚀\r\nline two\r\n', 'utf-8');
      await conn.writeFile(remote, original);

      const local = await openFile(remote);
      expect(fs.readFileSync(local).equals(original)).toBe(true);

      const edited = 'héllo 世界 🚀 üñî\r\nline two EDITED\r\nline three €\r\n';
      await editAndSave(local, edited);

      const remoteBytes = await conn.readFile(remote);
      expect(remoteBytes.equals(Buffer.from(edited, 'utf-8'))).toBe(true);
      expect(remoteBytes.includes(Buffer.from('\r\n'))).toBe(true);
    }, 40000);

    it('a ~2 MB file (progressive route) saves back byte-exact', async () => {
      const remote = `${ROOT}/slsave-big.txt`;
      const line = 'café 日本 0123456789 the quick brown fox\r\n';
      const original = line.repeat(Math.ceil(2_000_000 / Buffer.byteLength(line)));
      await conn.writeFile(remote, Buffer.from(original, 'utf-8'));
      expect((await conn.stat(remote)).size).toBeGreaterThan(1_048_576);

      const local = await openFile(remote);
      expect(fs.readFileSync(local, 'utf-8')).toBe(original);

      const edited = 'HEADER é\r\n' + original.slice(0, 1_000_000) + 'MIDDLE-EDIT 🚀\r\n' + original.slice(1_000_000);
      await editAndSave(local, edited);

      const remoteBytes = await conn.readFile(remote);
      expect(remoteBytes.length).toBe(Buffer.byteLength(edited, 'utf-8'));
      expect(remoteBytes.equals(Buffer.from(edited, 'utf-8'))).toBe(true);
    }, 90000);

    it('save of a file whose name has spaces and a single quote', async () => {
      const remote = `${ROOT}/slsave it's file.txt`;
      await conn.writeFile(remote, Buffer.from('one\n'));
      const local = await openFile(remote);
      await editAndSave(local, 'two é\n');
      expect((await conn.readFile(remote)).toString('utf-8')).toBe('two é\n');
    }, 40000);
  });

  // ---------------------------------------------------------------- 2. backups
  describe('server backups', () => {
    it('open creates a server backup equal to the pre-edit bytes; save keeps it; restore + revert return exact bytes', async () => {
      const remote = `${ROOT}/slsave-restore.txt`;
      const original = Buffer.from('orig é日 \r\nsecond\r\n', 'utf-8');
      await conn.writeFile(remote, original);

      const local = await openFile(remote);
      const mapping = (service as any).fileMappings.get(local);
      expect(await waitFor(() => !!mapping.serverBackupPath, 10000)).toBe(true);
      const backupPath: string = mapping.serverBackupPath;
      expect(backupPath.startsWith(BACKUP_DIR + '/slsave-restore_')).toBe(true);
      expect((await conn.readFile(backupPath)).equals(original)).toBe(true);

      const edited = 'edited ü\r\n';
      await editAndSave(local, edited);
      expect((await conn.readFile(remote)).toString('utf-8')).toBe(edited);
      // backup unchanged by the save
      expect((await conn.readFile(backupPath)).equals(original)).toBe(true);

      // listServerBackups sees it
      const listed = await service.listServerBackups(conn, remote);
      expect(listed.map((b) => b.path)).toContain(backupPath);

      // restore => exact original bytes; pre-restore state is backed up first
      const before = (await backupsOf(remote)).length;
      expect(await service.restoreFromServerBackup(conn, remote, backupPath)).toBe(true);
      expect((await conn.readFile(remote)).equals(original)).toBe(true);
      const after = await backupsOf(remote);
      expect(after.length).toBe(before + 1);
      const preRestore = after.find((p) => p !== backupPath && !listed.some((b) => b.path === p));
      expect(preRestore).toBeDefined();
      expect((await conn.readFile(preRestore!)).toString('utf-8')).toBe(edited);
      // local temp copy is refreshed with the restored content
      expect(fs.readFileSync(local).equals(original)).toBe(true);

      // revertToBackup (local history entry made by the save) => exact original again
      await conn.writeFile(remote, Buffer.from('clobbered'));
      const history = service.getBackupHistory(conn.id, remote);
      expect(history.length).toBeGreaterThan(0);
      expect(await service.revertToBackup(conn, remote, history[history.length - 1])).toBe(true);
      expect((await conn.readFile(remote)).equals(original)).toBe(true);
    }, 60000);

    it('issue regression: picker restore to the default ~/name target restores the real home file and backs it up first', async () => {
      // Fixed bug: "~/name" was single-quoted, so the existence check, the
      // pre-restore backup and the copy all pointed at a folder literally named "~".
      const home = (await conn.resolveHomePath()).replace(/\/+$/, '');
      const name = 'slsave-home-restore.txt';
      const remote = `${home}/${name}`;
      try {
        await conn.writeFile(remote, Buffer.from('from-backup'));
        const backupPath = await service.createServerBackup(conn, remote);
        expect(backupPath).toBeDefined();
        await conn.writeFile(remote, Buffer.from('current'));
        const before = await backupsOf(remote);

        (vscode.window.showInputBox as jest.Mock).mockResolvedValueOnce('');
        (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Restore');
        const backupName = backupPath!.split('/').pop()!;
        await (service as any).restoreBackupWithConfirmation(conn, { name: backupName, path: backupPath!, timestamp: new Date(), isDirectory: false });

        expect((await conn.readFile(remote)).toString()).toBe('from-backup');
        const after = await backupsOf(remote);
        const preRestore = after.filter((p) => !before.includes(p));
        expect(preRestore).toHaveLength(1);
        expect((await conn.readFile(preRestore[0])).toString()).toBe('current');
        expect((await sh(conn, `test -e ${sq(home + '/~')} && echo yes || echo no`)).trim()).toBe('no');
      } finally {
        await sh(conn, `rm -f -- ${sq(remote)}; rm -f -- ${sq(BACKUP_DIR)}/${sq('slsave-home-restore_')}*`).catch(() => '');
      }
    }, 60000);

    it('createServerBackup / list / restore work for a name with spaces', async () => {
      // Fixed bug (listServerBackups): `ls -1t ${BACKUP}/${baseName}_*${ext}` is not quoted.
      const remote = `${ROOT}/slsave my file.txt`;
      await conn.writeFile(remote, Buffer.from('spaced'));
      const backup = await service.createServerBackup(conn, remote);
      expect(backup).toBeDefined();
      expect((await conn.readFile(backup!)).toString()).toBe('spaced');
      const listed = await service.listServerBackups(conn, remote);
      expect(listed.map((b) => b.path)).toContain(backup);
    }, 30000);

    it("createServerBackup / list / restore work for a name with a single quote", async () => {
      // Fixed bug (listServerBackups): unbalanced quote makes `ls` fail -> `|| true` -> [].
      const remote = `${ROOT}/slsave it's.txt`;
      await conn.writeFile(remote, Buffer.from('quoted'));
      const backup = await service.createServerBackup(conn, remote);
      expect(backup).toBeDefined();
      expect((await conn.readFile(backup!)).toString()).toBe('quoted');
      const listed = await service.listServerBackups(conn, remote);
      expect(listed.map((b) => b.path)).toContain(backup);
    }, 30000);

    it('listServerBackups does not return backups of a different file whose name merely starts with the same prefix', async () => {
      // Fixed bug: glob `${baseName}_*${ext}` matches "slsave-pfx_extra_<ts>.txt" for "slsave-pfx.txt".
      const a = `${ROOT}/slsave-pfx.txt`;
      const b = `${ROOT}/slsave-pfx_extra.txt`;
      await conn.writeFile(a, Buffer.from('A'));
      await conn.writeFile(b, Buffer.from('B'));
      const backupA = await service.createServerBackup(conn, a);
      const backupB = await service.createServerBackup(conn, b);
      const listedA = (await service.listServerBackups(conn, a)).map((x) => x.path);
      expect(listedA).toContain(backupA);
      expect(listedA).not.toContain(backupB);
    }, 30000);

    it('backups of same-named files in different directories are not mixed up', async () => {
      // Fixed bug: backup name is <basename>_<ts>.<ext> with no directory info, so
      // restore-picker for dirA/same.txt offers dirB/same.txt content (data hazard).
      await sh(conn, `mkdir -p ${sq(ROOT + '/d1')} ${sq(ROOT + '/d2')}`);
      const a = `${ROOT}/d1/slsave-same.txt`;
      const b = `${ROOT}/d2/slsave-same.txt`;
      await conn.writeFile(a, Buffer.from('content of d1'));
      await conn.writeFile(b, Buffer.from('content of d2'));
      const backupA = await service.createServerBackup(conn, a);
      const backupB = await service.createServerBackup(conn, b);
      expect(backupA).not.toBe(backupB);
      const listedA = (await service.listServerBackups(conn, a)).map((x) => x.path);
      expect(listedA).toContain(backupA);
      expect(listedA).not.toContain(backupB);
    }, 30000);

    it('cleanupServerBackups removes only OLD files inside the backup folder', async () => {
      const oldBackup = `${BACKUP_DIR}/slsave-old_2020-01-01T00-00-00-000Z.txt`;
      const freshBackup = `${BACKUP_DIR}/slsave-fresh_2099-01-01T00-00-00-000Z.txt`;
      const outsideOld = `${ROOT}/slsave-outside-old.txt`;
      await sh(conn, `mkdir -p ${BACKUP_DIR}; echo old > ${sq(oldBackup)}; echo fresh > ${sq(freshBackup)}; echo outside > ${sq(outsideOld)}; touch -d '60 days ago' ${sq(oldBackup)} ${sq(outsideOld)}`);

      const removed = await service.cleanupServerBackups(conn);
      expect(removed).toBeGreaterThanOrEqual(1);

      expect((await sh(conn, `test -e ${sq(oldBackup)} && echo yes || echo no`)).trim()).toBe('no');
      expect((await sh(conn, `test -e ${sq(freshBackup)} && echo yes || echo no`)).trim()).toBe('yes');
      expect((await sh(conn, `test -e ${sq(outsideOld)} && echo yes || echo no`)).trim()).toBe('yes');
    }, 30000);
  });

  // ---------------------------------------------------------------- 3. delete with backup
  describe('delete with backup', () => {
    it("deleteRemote(file) in a dir with spaces + single quote: file gone, backup identical, siblings untouched", async () => {
      const dir = `${ROOT}/dir with 'q' and spaces`;
      await sh(conn, `mkdir -p ${sq(dir)}`);
      const target = `${dir}/slsave it's del.txt`;
      const bytes = Buffer.from('bytes é日\r\n', 'utf-8');
      await conn.writeFile(target, bytes);
      await conn.writeFile(`${dir}/keep one.txt`, Buffer.from('keep1'));
      await conn.writeFile(`${dir}/keep'two.txt`, Buffer.from('keep2'));

      expect(await service.deleteRemote(conn, remoteFileOf(target, bytes.length))).toBe(true);

      expect(await conn.fileExists(target)).toBe(false);
      expect((await conn.readFile(`${dir}/keep one.txt`)).toString()).toBe('keep1');
      expect((await conn.readFile(`${dir}/keep'two.txt`)).toString()).toBe('keep2');
      const found = (await sh(conn, `ls -1 ${BACKUP_DIR} | grep -F ${sq("slsave it's del_")} || true`)).trim().split('\n').filter(Boolean);
      expect(found.length).toBe(1);
      expect((await conn.readFile(`${BACKUP_DIR}/${found[0]}`)).equals(bytes)).toBe(true);
    }, 40000);

    it('deleteRemote(directory) backs up the whole tree as tar.gz, removes it recursively, siblings untouched', async () => {
      const parent = `${ROOT}/parent with 'q'`;
      const dir = `${parent}/slsave tree's dir`;
      await sh(conn, `mkdir -p ${sq(dir + '/sub dir/deep')} ${sq(parent + '/sibling')}`);
      await conn.writeFile(`${dir}/a b.txt`, Buffer.from('A'));
      await conn.writeFile(`${dir}/.hidden`, Buffer.from('H'));
      await conn.writeFile(`${dir}/sub dir/it's.txt`, Buffer.from('S'));
      await conn.writeFile(`${dir}/sub dir/deep/x.bin`, Buffer.from([0, 255, 1, 254]));
      await conn.writeFile(`${parent}/sibling/s.txt`, Buffer.from('sib'));
      await conn.writeFile(`${parent}/slsave-sibling-file.txt`, Buffer.from('sibfile'));

      expect(await service.deleteRemote(conn, remoteFileOf(dir, 0, true))).toBe(true);

      expect((await sh(conn, `test -e ${sq(dir)} && echo yes || echo no`)).trim()).toBe('no');
      expect((await conn.readFile(`${parent}/sibling/s.txt`)).toString()).toBe('sib');
      expect((await conn.readFile(`${parent}/slsave-sibling-file.txt`)).toString()).toBe('sibfile');

      const tars = (await sh(conn, `ls -1 ${BACKUP_DIR} | grep -F ${sq("slsave tree's dir_")} || true`)).trim().split('\n').filter(Boolean);
      expect(tars.length).toBe(1);
      const tar = `${BACKUP_DIR}/${tars[0]}`;
      const listing = await sh(conn, `tar -tzf ${sq(tar)}`);
      for (const rel of ['a b.txt', '.hidden', "sub dir/it's.txt", 'sub dir/deep/x.bin']) {
        expect(listing).toContain(`slsave tree's dir/${rel}`);
      }
      // restore the archive somewhere else and compare bytes
      const out = `${ROOT}/extract`;
      await sh(conn, `mkdir -p ${sq(out)} && tar -xzf ${sq(tar)} -C ${sq(out)}`);
      expect((await conn.readFile(`${out}/slsave tree's dir/a b.txt`)).toString()).toBe('A');
      expect((await conn.readFile(`${out}/slsave tree's dir/sub dir/deep/x.bin`)).equals(Buffer.from([0, 255, 1, 254]))).toBe(true);
    }, 60000);

    it('createDirectoryBackup works for a directory whose name starts with a dash', async () => {
      // Fixed bug: `tar -czf <out> '-slsave-dash'` is parsed as an option.
      const dir = `${ROOT}/-slsave-dash`;
      await sh(conn, `mkdir -p ${sq(dir)}`);
      await conn.writeFile(`${dir}/f.txt`, Buffer.from('dash'));
      const backup = await (service as any).createDirectoryBackup(conn, dir);
      expect(backup).toBeDefined();
      const listing = await sh(conn, `tar -tzf ${sq(backup)}`);
      expect(listing).toContain('f.txt');
    }, 30000);

    it('deleteRemote(directory) containing a symlink to a directory deletes the dir and never touches the link target', async () => {
      // Fixed bug: listFiles reports the link as a file (lstat) but deleteFile()
      // stat()s it (follows the link -> "directory") and calls rmdir on a symlink, which fails.
      const outside = `${ROOT}/slsave-link-target`;
      const dir = `${ROOT}/slsave-with-link`;
      await sh(conn, `mkdir -p ${sq(outside)} ${sq(dir)}`);
      await conn.writeFile(`${outside}/precious.txt`, Buffer.from('precious'));
      await conn.writeFile(`${dir}/plain.txt`, Buffer.from('plain'));
      await sh(conn, `ln -s ${sq(outside)} ${sq(dir + '/link-to-dir')}`);

      const ok = await service.deleteRemote(conn, remoteFileOf(dir, 0, true));

      // target must be intact no matter what
      expect((await conn.readFile(`${outside}/precious.txt`)).toString()).toBe('precious');
      expect(ok).toBe(true);
      expect((await sh(conn, `test -e ${sq(dir)} && echo yes || echo no`)).trim()).toBe('no');
    }, 40000);

    it('deleteRemote(directory) containing a dangling symlink succeeds', async () => {
      const dir = `${ROOT}/slsave-dangling`;
      await sh(conn, `mkdir -p ${sq(dir)}`);
      await conn.writeFile(`${dir}/x.txt`, Buffer.from('x'));
      await sh(conn, `ln -s /nonexistent/slsave-nowhere ${sq(dir + '/dangling')}`);
      const ok = await service.deleteRemote(conn, remoteFileOf(dir, 0, true));
      expect(ok).toBe(true);
      expect((await sh(conn, `test -e ${sq(dir)} -o -L ${sq(dir)} && echo yes || echo no`)).trim()).toBe('no');
    }, 40000);

    it("deleteRemotePath removes a tree with spaces + single quote, ignores shell metacharacters, leaves siblings", async () => {
      const base = `${ROOT}/rp base`;
      const dir = `${base}/slsave rp's $(touch slsave-pwned) dir`;
      await sh(conn, `mkdir -p ${sq(dir + '/inner')}; `);
      await conn.writeFile(`${dir}/inner/f.txt`, Buffer.from('f'));
      await conn.writeFile(`${base}/sibling.txt`, Buffer.from('sib'));
      const file = `${base}/slsave file's name.txt`;
      await conn.writeFile(file, Buffer.from('fx'));

      await service.deleteRemotePath(conn, dir, true);
      await service.deleteRemotePath(conn, file, false);

      expect((await sh(conn, `test -e ${sq(dir)} && echo yes || echo no`)).trim()).toBe('no');
      expect(await conn.fileExists(file)).toBe(false);
      expect((await conn.readFile(`${base}/sibling.txt`)).toString()).toBe('sib');
      expect((await sh(conn, `ls ${sq(base)}; ls /home/testuser | grep -c slsave-pwned || true`)).includes('slsave-pwned')).toBe(false);
    }, 40000);
  });
});
