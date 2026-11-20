/**
 * Docker integration test: FileService same-host copy/paste, upload and folder
 * download over a REAL SSH server (SFTP + exec), not mocks and not FTP.
 *
 * These features were previously covered only by mock-based unit tests or by the
 * FTP integration suite. Coverage (all under /home/testuser/sshlite-it-copy/ on
 * the web-01 container, 127.0.0.1:2201):
 *
 *  1. copyRemoteSameHost (`cp -r --`): file + folder copy, awkward names (space,
 *     single quote, `$`, backtick, leading dash, double quote, semicolon), the
 *     byte-identical + same-structure guarantee (sha256 manifest and `find` list,
 *     including empty dirs, 0-byte files and a symlink), refusing to copy a folder
 *     into itself / a descendant (and leaving no partial dest), and the paste
 *     collision flow (listFiles -> nextCopyName -> copyRemoteSameHost, mirroring
 *     the `sshLite.pasteRemoteItem` handler in extension.ts) never overwriting an
 *     existing entry.
 *  2. uploadFileTo: text, 0-byte, binary (all 256 byte values, 300 KB), names with
 *     spaces / unicode / quote / `$`, remote folder with spaces, repeat upload
 *     overwrites in place, and a file literally named "a%20b.txt".
 *     (FileService has no folder-upload API; a folder is uploaded by repeating
 *     uploadFileTo per file, which the nested test does.)
 *  3. downloadFolder: nested tree -> local temp dir, byte + structure compare,
 *     0-byte file, empty subfolder, symlink-to-file, symlink-to-dir, dangling link.
 *
 * Tests titled "issue regression" reproduce bugs fixed in the 1.0.x test sweep and failed on the
 * pre-fix code; the comment above each one records symptom and root cause.
 *
 * Run (single file): npx jest --config <docker config> --no-coverage docker-ssh-copy-transfer
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { FileService } from '../services/FileService';
import { CredentialService, SavedCredential } from '../services/CredentialService';
import { IHostConfig } from '../types';

const SERVER = { id: 'copy-xfer', host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' };
const BASE = '/home/testuser/sshlite-it-copy';
const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;

const _knownHosts: Record<string, unknown> = {};
const localDirs: string[] = [];

function setupMocks(): void {
  setGlobalState({
    get: <T>(key: string, def?: T) => (_knownHosts[key] as T) ?? (def as T),
    update: async (k: string, v: unknown) => { _knownHosts[k] = v; },
    keys: () => Object.keys(_knownHosts),
  } as vscode.Memento);
  (CredentialService as any)._instance = {
    getCredentialSecret: jest.fn().mockResolvedValue(SERVER.password),
    getOrPrompt: jest.fn().mockResolvedValue(SERVER.password),
    initialize: jest.fn(),
  };
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');

  // vscode.workspace.fs is a bare jest.fn mock; back it with the real local disk.
  const wfs = vscode.workspace.fs as any;
  wfs.stat.mockImplementation(async (u: vscode.Uri) => ({ size: fs.statSync(u.fsPath).size }));
  wfs.readFile.mockImplementation(async (u: vscode.Uri) => new Uint8Array(fs.readFileSync(u.fsPath)));
  wfs.writeFile.mockImplementation(async (u: vscode.Uri, data: Uint8Array) => { fs.writeFileSync(u.fsPath, data); });
  wfs.createDirectory.mockImplementation(async (u: vscode.Uri) => { fs.mkdirSync(u.fsPath, { recursive: true }); });
}

async function connect(): Promise<SSHConnection> {
  const host: IHostConfig = { id: SERVER.id, name: 'web-01', host: SERVER.host, port: SERVER.port, username: SERVER.username, source: 'saved' };
  const cred: SavedCredential = { id: SERVER.id + '-pw', label: 'pw', type: 'password' };
  const c = new SSHConnection(host, cred);
  await c.connect();
  return c;
}

/** Single-quote a string for the remote shell (test helper only). */
function q(s: string): string { return `'${s.replace(/'/g, "'\\''")}'`; }

/** Local temp dir with forward slashes (the vscode Uri mock uses path as fsPath). */
function mkLocal(label: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `sshlite-it-copy-${label}-`)).replace(/\\/g, '/');
  localDirs.push(d);
  return d;
}

function binary(size: number): Buffer {
  const b = Buffer.alloc(size);
  for (let i = 0; i < 256 && i < size; i++) { b[i] = i; }
  if (size > 256) { crypto.randomBytes(size - 256).copy(b, 256); }
  return b;
}

/** Local manifest: sorted lines "type relpath [sha256]" (dirs, files; symlinks skipped). */
function localManifest(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir)) {
      const full = `${dir}/${name}`;
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.statSync(full);
      if (st.isDirectory()) { out.push(`d ${r}`); walk(full, r); }
      else { out.push(`f ${r} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')} ${st.size}`); }
    }
  };
  walk(root, '');
  return out.sort();
}

describe('Docker: FileService copy / upload / downloadFolder over real SSH', () => {
  let conn: SSHConnection;
  let svc: FileService;
  let seq = 0;

  /** Fresh remote working dir for one test. */
  async function mkRemote(label: string): Promise<string> {
    const d = `${BASE}/${label}-${++seq}`;
    await conn.exec(`mkdir -p ${q(d)}`);
    return d;
  }

  /** Remote manifest: dirs, files + sha256 + size, symlinks + target, sorted. Run inside `dir`. */
  async function remoteManifest(dir: string): Promise<string[]> {
    const script =
      `cd ${q(dir)} && { find . -mindepth 1 -type d | sed 's|^\\./|d |'; ` +
      `find . -type f -exec sh -c 'for f; do printf "f %s %s %s\\n" "\${f#./}" "$(sha256sum < "$f" | cut -d" " -f1)" "$(wc -c < "$f")"; done' _ {} +; ` +
      `find . -type l | while read -r l; do printf "l %s %s\\n" "\${l#./}" "$(readlink "$l")"; done; } | sort`;
    const out = await conn.exec(script);
    return out.split('\n').map((l) => l.replace(/\r$/, '')).filter(Boolean).sort();
  }

  /** Mirrors the sshLite.pasteRemoteItem same-host copy branch in extension.ts. */
  async function paste(srcPath: string, isDir: boolean, destFolder: string, existingExtra: string[] = []): Promise<string> {
    const existing = await conn.listFiles(destFolder).catch(() => []);
    const names = new Set([...existing.map((e) => e.name), ...existingExtra]);
    const name = srcPath.substring(srcPath.lastIndexOf('/') + 1);
    const destName = svc.nextCopyName(name, names, isDir);
    const destPath = destFolder.endsWith('/') ? `${destFolder}${destName}` : `${destFolder}/${destName}`;
    await svc.copyRemoteSameHost(conn, srcPath, destPath, isDir);
    return destPath;
  }

  beforeAll(async () => {
    setupMocks();
    conn = await connect();
    svc = FileService.getInstance();
    await conn.exec(`rm -rf ${q(BASE)} && mkdir -p ${q(BASE)}`);
  }, 60000);

  afterAll(async () => {
    try { await conn.exec(`rm -rf ${q(BASE)}`); } catch { /* ignore */ }
    try { await conn.disconnect(); } catch { /* ignore */ }
    for (const d of localDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  beforeEach(() => {
    (vscode.window.showErrorMessage as jest.Mock).mockClear();
    (vscode.window.showOpenDialog as jest.Mock).mockReset().mockResolvedValue(undefined);
  });

  // ───────────────────────── same-host copy ─────────────────────────

  describe('copyRemoteSameHost', () => {
    const awkwardNames = [
      'plain.txt',
      'with space.txt',
      "it's quoted.txt",
      'dollar $HOME $(id).txt',
      'back`tick`.txt',
      '-leading-dash.txt',
      'semi;colon && amp.txt',
      'dq"uote.txt',
      'unicode-éè-中文.txt',
    ];

    it.each(awkwardNames)('copies a file named %j byte-identically', async (name) => {
      const dir = await mkRemote('file');
      const src = `${dir}/${name}`;
      const content = binary(5000);
      await conn.writeFile(src, content);
      const dest = `${dir}/copied-${name}`;

      await svc.copyRemoteSameHost(conn, src, dest, false);

      expect((await conn.readFile(dest)).equals(content)).toBe(true);
      expect((await conn.readFile(src)).equals(content)).toBe(true); // source untouched
      // No shell side effects from `$(id)` / backticks / `;`: nothing extra in the dir.
      const names = (await conn.listFiles(dir)).map((f) => f.name).sort();
      expect(names).toEqual([name, `copied-${name}`].sort());
    }, 30000);

    it('copies a folder with awkward-named children: same files, bytes, empty dirs, symlink', async () => {
      const dir = await mkRemote('folder');
      const src = `${dir}/src folder's $dir`;
      await conn.exec(`mkdir -p ${q(src)}/empty ${q(src)}/sub/deep ${q(src)}/"sp ace"`);
      await conn.writeFile(`${src}/zero.bin`, Buffer.alloc(0));
      await conn.writeFile(`${src}/-dash.bin`, binary(70000));
      await conn.writeFile(`${src}/sub/it's.txt`, Buffer.from('quote'));
      await conn.writeFile(`${src}/sub/deep/\`bt\`.txt`, Buffer.from('backtick'));
      await conn.writeFile(`${src}/sp ace/$HOME.txt`, Buffer.from('dollar'));
      await conn.exec(`ln -s zero.bin ${q(src + '/link-to-zero')}`);

      const dest = `${dir}/dest folder's copy`;
      await svc.copyRemoteSameHost(conn, src, dest, true);

      const a = await remoteManifest(src);
      const b = await remoteManifest(dest);
      expect(a.length).toBeGreaterThan(8);
      expect(b).toEqual(a);
    }, 30000);

    // Fixed bug: copying a folder into itself IS refused (GNU cp exits 1), but only AFTER
    // cp has already created and partly filled the destination. Verified on the server:
    //   cp -r -- /tmp/cx/t /tmp/cx/t/c  ->  "cannot copy a directory ... into itself", rc=1,
    //   yet /tmp/cx/t/c and /tmp/cx/t/c/sub now exist. The user sees an error AND a stray
    //   "tree-copy" folder inside the source.
    // Root cause: FileService.ts:4622-4628 (SSH branch of copyRemoteSameHost) relies on cp to
    // detect it; only the FTP branch (4589) pre-checks. The doc comment at 4586-4588 wrongly
    // assumes cp refuses cleanly.
    // Fix: hoist the 4589 guard above the supportsExec branch:
    //   if (isDirectory && (destPath === srcPath || destPath.startsWith(srcPath.replace(/\/?$/, '/')))) throw new Error('Cannot copy a folder into itself.');
    it('issue regression: refuses to copy a folder into itself and leaves no destination behind', async () => {
      const dir = await mkRemote('self');
      const src = `${dir}/tree`;
      await conn.exec(`mkdir -p ${q(src)}/sub && printf x > ${q(src)}/sub/f.txt`);

      await expect(svc.copyRemoteSameHost(conn, src, `${src}/tree-copy`, true)).rejects.toThrow();
      await expect(svc.copyRemoteSameHost(conn, src, `${src}/sub/tree-copy`, true)).rejects.toThrow();
      await expect(svc.copyRemoteSameHost(conn, src, src, true)).rejects.toThrow();

      const m = await remoteManifest(src);
      expect(m.filter((l) => l.includes('tree-copy'))).toEqual([]);
      expect(m.filter((l) => l.startsWith('f '))).toHaveLength(1); // original file only, no runaway recursion
    }, 30000);

    it('copying a folder into a sibling prefix path (/a -> /a-copy) is NOT mistaken for "into itself"', async () => {
      const dir = await mkRemote('prefix');
      await conn.exec(`mkdir -p ${q(dir)}/a && printf x > ${q(dir)}/a/f.txt`);
      await svc.copyRemoteSameHost(conn, `${dir}/a`, `${dir}/a-copy`, true);
      expect((await conn.readFile(`${dir}/a-copy/f.txt`)).toString()).toBe('x');
    }, 30000);

    it('reports an error for a missing source (no silent success)', async () => {
      const dir = await mkRemote('missing');
      await expect(svc.copyRemoteSameHost(conn, `${dir}/nope`, `${dir}/nope2`, false)).rejects.toThrow();
      expect(await conn.fileExists(`${dir}/nope2`)).toBe(false);
    }, 30000);
  });

  // ───────────────────────── paste collision flow ─────────────────────────

  describe('paste (copy) collision handling', () => {
    it('pasting a file into its own folder creates "name (copy).ext" and never overwrites the original', async () => {
      const dir = await mkRemote('coll');
      const orig = Buffer.from('ORIGINAL');
      await conn.writeFile(`${dir}/doc.txt`, orig);

      const d1 = await paste(`${dir}/doc.txt`, false, dir);
      expect(d1).toBe(`${dir}/doc (copy).txt`);
      const d2 = await paste(`${dir}/doc.txt`, false, dir);
      expect(d2).toBe(`${dir}/doc (copy) 2.txt`);
      const d3 = await paste(`${dir}/doc (copy).txt`, false, dir);
      expect(d3).toBe(`${dir}/doc (copy) (copy).txt`);

      for (const p of [`${dir}/doc.txt`, d1, d2, d3]) {
        expect((await conn.readFile(p)).equals(orig)).toBe(true);
      }
      expect((await conn.listFiles(dir)).map((f) => f.name).sort())
        .toEqual(['doc (copy) (copy).txt', 'doc (copy) 2.txt', 'doc (copy).txt', 'doc.txt']);
    }, 30000);

    it('pasting a file into a different folder that has a same-named file keeps both contents', async () => {
      const dir = await mkRemote('coll2');
      await conn.exec(`mkdir -p ${q(dir)}/a ${q(dir)}/b`);
      await conn.writeFile(`${dir}/a/same.log`, Buffer.from('from-a'));
      await conn.writeFile(`${dir}/b/same.log`, Buffer.from('already-in-b'));

      const dest = await paste(`${dir}/a/same.log`, false, `${dir}/b`);
      expect(dest).toBe(`${dir}/b/same (copy).log`);
      expect((await conn.readFile(`${dir}/b/same.log`)).toString()).toBe('already-in-b');
      expect((await conn.readFile(dest)).toString()).toBe('from-a');
    }, 30000);

    it('pasting a folder next to itself makes a distinct copy with identical contents', async () => {
      const dir = await mkRemote('coll3');
      await conn.exec(`mkdir -p ${q(dir)}/proj/sub && printf 1 > ${q(dir)}/proj/a.txt && printf 2 > ${q(dir)}/proj/sub/b.txt`);
      const dest = await paste(`${dir}/proj`, true, dir);
      expect(dest).toBe(`${dir}/proj (copy)`);
      expect(await remoteManifest(dest)).toEqual(await remoteManifest(`${dir}/proj`));
      // Not nested inside the original (the classic `cp -r src existingDir` trap).
      expect(await conn.fileExists(`${dir}/proj/proj`)).toBe(false);
    }, 30000);

    // Fixed bug: same root cause as the "into itself" test above (cp leaves a partial copy
    // at proj/sub/proj before failing). Fixed by the same pre-check in copyRemoteSameHost.
    it('issue regression: pasting a folder into its own subfolder is refused (no recursion, no partial copy)', async () => {
      const dir = await mkRemote('coll4');
      await conn.exec(`mkdir -p ${q(dir)}/proj/sub && printf 1 > ${q(dir)}/proj/a.txt`);
      await expect(paste(`${dir}/proj`, true, `${dir}/proj/sub`)).rejects.toThrow();
      expect(await conn.fileExists(`${dir}/proj/sub/proj`)).toBe(false);
    }, 30000);

    // Fixed bug (cosmetic but user-visible): nextCopyName() treats the text after the
    // last '.' as an extension even for DIRECTORIES, so pasting the folder "release-1.0"
    // yields "release-1 (copy).0" instead of "release-1.0 (copy)".
    // Root cause: FileService.ts:4671 nextCopyName(originalName, existingNames) has no
    // isDirectory input; extension.ts:1916 caller has entry.isDirectory but does not pass it.
    // Fix: add `isDirectory = false` param, `const hasExt = !isDirectory && dotIdx > 0;`
    // and pass `entry.isDirectory` at extension.ts:1916.
    it('issue regression: folder named "release-1.0" is copied as "release-1.0 (copy)", not "release-1 (copy).0"', async () => {
      const dir = await mkRemote('coll5');
      await conn.exec(`mkdir -p ${q(dir)}/release-1.0`);
      const dest = await paste(`${dir}/release-1.0`, true, dir);
      expect(dest).toBe(`${dir}/release-1.0 (copy)`);
    }, 30000);

    it('dotfiles get "(copy)" appended after the whole name', async () => {
      const dir = await mkRemote('coll6');
      await conn.writeFile(`${dir}/.bashrc`, Buffer.from('rc'));
      expect(await paste(`${dir}/.bashrc`, false, dir)).toBe(`${dir}/.bashrc (copy)`);
    }, 30000);
  });

  // ───────────────────────── upload ─────────────────────────

  describe('uploadFileTo', () => {
    async function upload(localFile: string, remoteFolder: string): Promise<void> {
      (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([vscode.Uri.file(localFile)]);
      await svc.uploadFileTo(conn, remoteFolder);
    }

    it('uploads text, 0-byte and binary files byte-identically', async () => {
      const remote = await mkRemote('up');
      const local = mkLocal('up');
      const cases: Array<[string, Buffer]> = [
        ['hello.txt', Buffer.from('hello\r\nworld\n')],
        ['empty.dat', Buffer.alloc(0)],
        ['blob.bin', binary(300 * 1024)],
      ];
      for (const [name, data] of cases) {
        fs.writeFileSync(`${local}/${name}`, data);
        await upload(`${local}/${name}`, remote);
        expect((await conn.readFile(`${remote}/${name}`)).equals(data)).toBe(true);
        expect((await conn.stat(`${remote}/${name}`)).size).toBe(data.length);
      }
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    }, 60000);

    it('uploads files with space, unicode, quote and $ in the name into a folder with spaces/quote', async () => {
      const remote = await mkRemote("up special's dir");
      const local = mkLocal('upn');
      const names = ['with space.txt', "it's.txt", 'dollar $HOME.txt', 'unicode-é-中.txt', '-dash.txt'];
      for (const name of names) {
        const data = Buffer.from(`content of ${name}`);
        fs.writeFileSync(`${local}/${name}`, data);
        await upload(`${local}/${name}`, remote);
        expect((await conn.readFile(`${remote}/${name}`)).equals(data)).toBe(true);
      }
      expect((await conn.listFiles(remote)).map((f) => f.name).sort()).toEqual([...names].sort());
    }, 60000);

    it('uploads a nested local folder tree file-by-file (incl. empty subfolder) and structure matches', async () => {
      // FileService has no folder-upload API; the user uploads a tree by repeating uploadFileTo
      // per file into the matching remote folder. Verify that composition is lossless.
      const remote = await mkRemote('uptree');
      const local = mkLocal('uptree');
      fs.mkdirSync(`${local}/t/sub/deep`, { recursive: true });
      fs.mkdirSync(`${local}/t/empty`, { recursive: true });
      fs.writeFileSync(`${local}/t/root.txt`, 'root');
      fs.writeFileSync(`${local}/t/sub/zero`, Buffer.alloc(0));
      fs.writeFileSync(`${local}/t/sub/deep/bin.dat`, binary(65537));

      const walk = async (ldir: string, rdir: string) => {
        await conn.exec(`mkdir -p ${q(rdir)}`);
        for (const e of fs.readdirSync(ldir, { withFileTypes: true })) {
          if (e.isDirectory()) { await walk(`${ldir}/${e.name}`, `${rdir}/${e.name}`); }
          else { await upload(`${ldir}/${e.name}`, rdir); }
        }
      };
      await walk(`${local}/t`, `${remote}/t`);

      const lm = localManifest(`${local}/t`);
      const rm = (await remoteManifest(`${remote}/t`)).map((l) => {
        // remote 'f path sha size' already same shape as local; dirs 'd path'
        return l;
      });
      expect(rm).toEqual(lm);
    }, 60000);

    it('re-uploading an existing remote file overwrites it in place (shorter content leaves no stale tail)', async () => {
      const remote = await mkRemote('upow');
      const local = mkLocal('upow');
      fs.writeFileSync(`${local}/f.txt`, 'LONG-LONG-LONG-CONTENT');
      await upload(`${local}/f.txt`, remote);
      fs.writeFileSync(`${local}/f.txt`, 'short');
      await upload(`${local}/f.txt`, remote);
      expect((await conn.readFile(`${remote}/f.txt`)).toString()).toBe('short');
    }, 30000);

    // Fixed bug: a local file literally named "a%20b.txt" is uploaded as "a b.txt".
    // Root cause: FileService.ts:3944 runs decodeUriComponentSafe() on `selectedUri.path`.
    // vscode.Uri.path is ALREADY decoded (only Uri.toString()/Uri.parse of a string are
    // encoded), so a second decode corrupts any name containing a valid %XX sequence
    // (e.g. "100%25.txt" -> "100%.txt", "a%20b.txt" -> "a b.txt"). The upload lands under a
    // different name than the user's file, and can OVERWRITE an unrelated remote file
    // called "a b.txt".
    // Proof: this test (remote has "a b.txt" = SENTINEL, upload "a%20b.txt").
    // Fix: use path.posix.basename(selectedUri.path) directly (or path.basename(fsPath)
    // for file: URIs) and drop decodeUriComponentSafe.
    it('issue regression: file named "a%20b.txt" uploads as "a%20b.txt" and does not clobber "a b.txt"', async () => {
      const remote = await mkRemote('upct');
      const local = mkLocal('upct');
      await conn.writeFile(`${remote}/a b.txt`, Buffer.from('SENTINEL'));
      fs.writeFileSync(`${local}/a%20b.txt`, 'percent-file');
      await upload(`${local}/a%20b.txt`, remote);

      expect((await conn.readFile(`${remote}/a b.txt`)).toString()).toBe('SENTINEL');
      expect((await conn.readFile(`${remote}/a%20b.txt`)).toString()).toBe('percent-file');
    }, 30000);
  });

  // ───────────────────────── downloadFolder ─────────────────────────

  describe('downloadFolder', () => {
    async function download(remoteDir: string, localDest: string): Promise<string> {
      (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([vscode.Uri.file(localDest)]);
      const name = remoteDir.substring(remoteDir.lastIndexOf('/') + 1);
      await svc.downloadFolder(conn, {
        name, path: remoteDir, isDirectory: true, size: 0, modifiedTime: Date.now(), connectionId: conn.id,
      } as any);
      return `${localDest}/${name}`;
    }

    async function seedTree(root: string): Promise<void> {
      await conn.exec(`mkdir -p ${q(root)}/sub/deep ${q(root)}/empty ${q(root)}/"sp ace"`);
      await conn.writeFile(`${root}/root.txt`, Buffer.from('root\r\nline'));
      await conn.writeFile(`${root}/zero.bin`, Buffer.alloc(0));
      await conn.writeFile(`${root}/sub/blob.bin`, binary(200 * 1024));
      await conn.writeFile(`${root}/sub/deep/it's $x.txt`, Buffer.from('quote'));
      await conn.writeFile(`${root}/sp ace/f.txt`, Buffer.from('space'));
    }

    it('downloads a nested tree with 0-byte file, binary file and empty subfolder, bytes + structure identical', async () => {
      const root = `${await mkRemote('dl')}/tree`;
      await seedTree(root);
      const dest = mkLocal('dl');

      const got = await download(root, dest);

      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      const local = localManifest(got);
      const remote = await remoteManifest(root);
      expect(local).toEqual(remote);
      expect(local.some((l) => l === 'd empty')).toBe(true);
      expect(local.some((l) => l.startsWith('f zero.bin ') && l.endsWith(' 0'))).toBe(true);
    }, 60000);

    it('symlink to a FILE is downloaded as a regular file holding the target bytes', async () => {
      const root = `${await mkRemote('dlsf')}/tree`;
      await conn.exec(`mkdir -p ${q(root)}`);
      await conn.writeFile(`${root}/real.txt`, Buffer.from('target-bytes'));
      await conn.exec(`ln -s real.txt ${q(root + '/link.txt')}`);
      const dest = mkLocal('dlsf');

      const got = await download(root, dest);

      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(fs.readFileSync(`${got}/link.txt`, 'utf8')).toBe('target-bytes');
      expect(fs.readFileSync(`${got}/real.txt`, 'utf8')).toBe('target-bytes');
    }, 30000);

    // Fixed bug (verify on server below): a symlink to a DIRECTORY aborts the whole folder download.
    // Root cause: SSHConnection.mapFileList (SSHConnection.ts:1089) derives isDirectory from the
    // lstat mode bits of readdir, so a symlink (S_IFLNK 0o120000) is never "directory";
    // FileService.downloadFolderRecursive (FileService.ts:3902-3909) then calls readFile() on
    // the link, which resolves to a directory and fails (EISDIR / "Failure"). The thrown error
    // aborts the loop: all files listed after it are NOT downloaded and the user only sees
    // "Failed to download folder".
    // Expected: skip (or follow) the link and still download every other entry.
    // Fix: in downloadFolderRecursive, wrap per-entry readFile in try/catch for link entries,
    // or stat() the entry (follows links) when the listing item has no isDirectory and recurse.
    it('issue regression: a symlink to a directory must not abort the download of the remaining files', async () => {
      const root = `${await mkRemote('dlsd')}/tree`;
      await conn.exec(`mkdir -p ${q(root)}/realdir`);
      await conn.writeFile(`${root}/realdir/inner.txt`, Buffer.from('inner'));
      await conn.writeFile(`${root}/aaa-first.txt`, Buffer.from('first'));
      await conn.writeFile(`${root}/zzz-last.txt`, Buffer.from('last'));
      await conn.exec(`ln -s realdir ${q(root + '/dirlink')}`);
      const dest = mkLocal('dlsd');

      const got = await download(root, dest);

      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
      expect(fs.readFileSync(`${got}/aaa-first.txt`, 'utf8')).toBe('first');
      expect(fs.readFileSync(`${got}/zzz-last.txt`, 'utf8')).toBe('last');
      expect(fs.readFileSync(`${got}/realdir/inner.txt`, 'utf8')).toBe('inner');
    }, 30000);

    // Fixed bug (same root cause as above): a dangling symlink aborts the download.
    it('issue regression: a dangling symlink must not abort the download of the remaining files', async () => {
      const root = `${await mkRemote('dldang')}/tree`;
      await conn.exec(`mkdir -p ${q(root)}`);
      await conn.writeFile(`${root}/aaa-first.txt`, Buffer.from('first'));
      await conn.writeFile(`${root}/zzz-last.txt`, Buffer.from('last'));
      await conn.exec(`ln -s /nonexistent/target ${q(root + '/broken')}`);
      const dest = mkLocal('dldang');

      const got = await download(root, dest);

      expect(fs.readFileSync(`${got}/aaa-first.txt`, 'utf8')).toBe('first');
      expect(fs.readFileSync(`${got}/zzz-last.txt`, 'utf8')).toBe('last');
    }, 30000);

    it('downloading an empty remote folder creates an empty local folder', async () => {
      const root = `${await mkRemote('dlempty')}/nothing`;
      await conn.exec(`mkdir -p ${q(root)}`);
      const dest = mkLocal('dlempty');
      const got = await download(root, dest);
      expect(fs.existsSync(got)).toBe(true);
      expect(fs.readdirSync(got)).toEqual([]);
    }, 30000);
  });

  // keep `stamp` referenced for traceability in failure output
  it('uses a unique run stamp', () => { expect(stamp).toMatch(/^\d+_\d+$/); });
});
