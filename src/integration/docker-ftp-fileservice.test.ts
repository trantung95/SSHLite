/**
 * Docker integration: the REAL FileService driven against live FTP servers
 * (issue #9). This is where the code-review crash bugs lived (shared file-op
 * paths that still called shell-only methods), so this exercises them for real:
 *
 *   - openRemoteFile on a >1MB file MUST route to connection.readFile, not the
 *     SFTP-only progressive/chunked path (which FTPConnection lacks) -> no crash.
 *   - downloadFileTo, deleteRemote (file + dir), createFolder/createFile,
 *     deleteRemotePath (recursive), and copyRemoteCrossHost over real FTP.
 *
 *   docker compose -f test-docker/docker-compose.yml up -d ftp ftp-pure
 *   npx jest --config jest.docker.config.js -- docker-ftp-fileservice
 */
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { FTPConnection } from '../connection/FTPConnection';
import { ConnectionManager } from '../connection/ConnectionManager';
import { FileService } from '../services/FileService';
import { IHostConfig, IRemoteFile } from '../types';
import { SavedCredential } from '../services/CredentialService';
import * as vscodeMock from '../__mocks__/vscode';
import { connectWithRetry } from './ftpTestHelpers';

jest.mock('../services/CredentialService', () => ({
  CredentialService: {
    getInstance: jest.fn().mockReturnValue({
      getCredentialSecret: jest.fn().mockResolvedValue('testpass'),
      updateCredentialPassword: jest.fn(),
      setSessionCredential: jest.fn(),
      deleteAll: jest.fn(),
    }),
  },
}));

const CRED: SavedCredential = { id: 'c1', label: 'pw', type: 'password' };

function ftpHost(port: number): IHostConfig {
  return {
    id: `127.0.0.1:${port}:testuser`,
    name: `ftp-${port}`,
    host: '127.0.0.1',
    port,
    username: 'testuser',
    source: 'saved',
    connectionType: 'ftp',
  };
}

function remoteFileOf(conn: FTPConnection, p: string, size: number): IRemoteFile {
  return { name: path.posix.basename(p), path: p, isDirectory: false, size, modifiedTime: 0, connectionId: conn.id };
}

describe('FileService over real FTP (issue #9)', () => {
  let conn: FTPConnection;     // primary (delfer vsftpd, 2207)
  let conn2: FTPConnection;    // second host (pure-ftpd, 2208) for cross-host copy
  let base: string;
  let base2: string;
  let service: FileService;

  beforeAll(async () => {
    conn = new FTPConnection(ftpHost(2207), CRED);
    await connectWithRetry(conn);
    base = (await conn.resolveHomePath()).replace(/\/$/, '');

    conn2 = new FTPConnection(ftpHost(2208), CRED); // pure-ftpd: tolerate cold-start warmup
    await connectWithRetry(conn2);
    base2 = (await conn2.resolveHomePath()).replace(/\/$/, '');

    // Register both so FileService's ConnectionManager.getConnection lookups
    // (e.g. the polling file-watch) resolve them and run the real FTP path.
    const cm = ConnectionManager.getInstance() as unknown as { _connections: Map<string, unknown> };
    cm._connections.set(conn.id, conn);
    cm._connections.set(conn2.id, conn2);

    service = FileService.getInstance();
  }, 130000);

  afterAll(async () => {
    try {
      const s = service as unknown as { stopFocusedFilePollTimer?: () => void; stopWatchHeartbeat?: () => void };
      s.stopFocusedFilePollTimer?.();
      s.stopWatchHeartbeat?.();
    } catch { /* ignore */ }
    const cm = ConnectionManager.getInstance() as unknown as { _connections: Map<string, unknown> };
    cm._connections.delete(conn.id);
    cm._connections.delete(conn2.id);
    if (conn) await conn.disconnect();
    if (conn2) await conn2.disconnect();
  });

  beforeEach(() => {
    (vscodeMock.window.showWarningMessage as jest.Mock).mockReset().mockResolvedValue(undefined);
    (vscodeMock.window.showInputBox as jest.Mock).mockReset().mockResolvedValue(undefined);
    (vscodeMock.window.showSaveDialog as jest.Mock).mockReset().mockResolvedValue(undefined);
  });

  const p = (n: string) => `${base}/${n}`;

  it('opens a >1MB FTP file via readFile (no SFTP-chunked crash)', async () => {
    const big = p(`big-${Date.now()}.txt`);
    const payload = Buffer.from('A'.repeat(1_500_000)); // 1.5MB > 1MB progressive threshold
    await conn.writeFile(big, payload);

    const readSpy = jest.spyOn(conn, 'readFile');
    // The bug: this used to route to ProgressiveDownloadManager.readFileChunked
    // (SFTP-only) and throw "readFileChunked is not a function" for FTP.
    await expect(
      service.openRemoteFile(conn as never, remoteFileOf(conn, big, payload.length))
    ).resolves.toBeUndefined();
    expect(readSpy).toHaveBeenCalledWith(big);

    readSpy.mockRestore();
    await conn.deleteFile(big);
  }, 30000);

  it('downloadFileTo downloads an FTP file to local disk', async () => {
    const src = p(`dl-${Date.now()}.txt`);
    await conn.writeFile(src, Buffer.from('download me'));
    const localTarget = path.join(os.tmpdir(), `sshlite-ftp-dl-${Date.now()}.txt`);
    (vscodeMock.window.showSaveDialog as jest.Mock).mockResolvedValue(vscodeMock.Uri.file(localTarget));

    const readSpy = jest.spyOn(conn, 'readFile');
    await service.downloadFileTo(conn as never, remoteFileOf(conn, src, 11));
    expect(readSpy).toHaveBeenCalledWith(src);

    readSpy.mockRestore();
    try { fs.unlinkSync(localTarget); } catch { /* best effort */ }
    await conn.deleteFile(src);
  });

  it('deleteRemote removes a file (server backup skipped for FTP)', async () => {
    const f = p(`del-${Date.now()}.txt`);
    await conn.writeFile(f, Buffer.from('x'));
    (vscodeMock.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete with Backup');

    const ok = await service.deleteRemote(conn as never, remoteFileOf(conn, f, 1));
    expect(ok).toBe(true);
    expect(await conn.fileExists(f)).toBe(false);
  });

  it('deleteRemote removes a non-empty directory recursively over FTP', async () => {
    const dir = p(`deldir-${Date.now()}`);
    await conn.mkdir(dir);
    await conn.writeFile(`${dir}/a.txt`, Buffer.from('a'));
    await conn.writeFile(`${dir}/b.txt`, Buffer.from('b'));
    (vscodeMock.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Permanently');

    const dirFile: IRemoteFile = { name: path.posix.basename(dir), path: dir, isDirectory: true, size: 0, modifiedTime: 0, connectionId: conn.id };
    const ok = await service.deleteRemote(conn as never, dirFile);
    expect(ok).toBe(true);
    expect(await conn.fileExists(dir)).toBe(false);
  });

  it('createFolder and createFile work over FTP', async () => {
    const folderName = `mk-${Date.now()}`;
    (vscodeMock.window.showInputBox as jest.Mock).mockResolvedValue(folderName);
    const created = await service.createFolder(conn as never, base || '/');
    expect(created).toBeTruthy();
    expect(await conn.fileExists(p(folderName))).toBe(true);

    const fileName = `nf-${Date.now()}.txt`;
    (vscodeMock.window.showInputBox as jest.Mock).mockResolvedValue(fileName);
    const createdFile = await service.createFile(conn as never, base || '/');
    expect(createdFile).toBeTruthy();
    expect(await conn.fileExists(p(fileName))).toBe(true);

    await conn.deleteFile(p(fileName));
    await conn.deleteFile(p(folderName));
  });

  it('deleteRemotePath deletes an FTP directory recursively without a shell', async () => {
    const dir = p(`rp-${Date.now()}`);
    await conn.mkdir(dir);
    await conn.writeFile(`${dir}/x.txt`, Buffer.from('x'));
    await service.deleteRemotePath(conn as never, dir, true);
    expect(await conn.fileExists(dir)).toBe(false);
  });

  it('copyRemoteCrossHost copies a file between two FTP hosts', async () => {
    const src = p(`xh-${Date.now()}.txt`);
    const body = Buffer.from('cross-host payload');
    await conn.writeFile(src, body);
    const dest = `${base2}/xh-dest-${Date.now()}.txt`;

    await service.copyRemoteCrossHost(conn as never, src, conn2 as never, dest, false);

    expect(await conn2.fileExists(dest)).toBe(true);
    expect((await conn2.readFile(dest)).toString()).toBe(body.toString());

    await conn.deleteFile(src);
    await conn2.deleteFile(dest);
  });

  // issue #14: same-server copy used to throw "Copy on the same FTP server is
  // not supported." It is now a client-mediated download + re-upload.
  it('copyRemoteSameHost copies a file on the SAME FTP server (issue #14)', async () => {
    const src = p(`same-${Date.now()}.php`);
    const body = Buffer.from('<?php echo "index"; ?>');
    await conn.writeFile(src, body);
    const dest = p(`same-copy-${Date.now()}.php`);

    await service.copyRemoteSameHost(conn as never, src, dest, false);

    expect(await conn.fileExists(dest)).toBe(true);
    expect((await conn.readFile(dest)).toString()).toBe(body.toString());
    // Original must survive a copy.
    expect(await conn.fileExists(src)).toBe(true);

    await conn.deleteFile(src);
    await conn.deleteFile(dest);
  });

  it('copyRemoteSameHost copies a folder recursively on the SAME FTP server (issue #14)', async () => {
    const dir = p(`samedir-${Date.now()}`);
    await conn.mkdir(dir);
    await conn.writeFile(`${dir}/a.txt`, Buffer.from('aaa'));
    await conn.writeFile(`${dir}/b.txt`, Buffer.from('bbb'));
    const destDir = p(`samedir-copy-${Date.now()}`);

    await service.copyRemoteSameHost(conn as never, dir, destDir, true);

    expect(await conn.fileExists(`${destDir}/a.txt`)).toBe(true);
    expect((await conn.readFile(`${destDir}/b.txt`)).toString()).toBe('bbb');

    await service.deleteRemotePath(conn as never, dir, true);
    await service.deleteRemotePath(conn as never, destDir, true);
  });

  // issue #15: a freshly-written file must list with a real recent mtime, not
  // 0 / 1970 ("56 years ago"). vsftpd answers LIST, so this exercises the
  // rawModifiedAt parser end-to-end.
  it('listFiles returns a real recent modifiedTime, not 1970 (issue #15)', async () => {
    const name = `mtime-${Date.now()}.txt`;
    await conn.writeFile(p(name), Buffer.from('now'));

    const listed = (await conn.listFiles(base || '/')).find((f) => f.name === name);
    expect(listed).toBeDefined();
    expect(listed!.modifiedTime).toBeGreaterThan(0);
    // Within the last day (LIST has no timezone, so allow a generous window).
    const ageMs = Date.now() - listed!.modifiedTime;
    expect(ageMs).toBeLessThan(2 * 24 * 60 * 60 * 1000);
    expect(ageMs).toBeGreaterThan(-2 * 24 * 60 * 60 * 1000);

    await conn.deleteFile(p(name));
  });
});
