/**
 * Docker integration test — issue #18 ("no move file") over FTP.
 *
 * The reporter's video shows an FTP account hosting several sites: they drag
 * `e-clothes.ru/public_html/index-copy.html` onto `diapic.ru/public_html/test`
 * (same server) and nothing moves. The v1.0.4 fix (drag-to-move) is proven over
 * SSH by docker-ssh-dnd-move.test.ts; this suite drives the SAME real
 * FileTreeProvider.handleDrag -> handleDrop path against real FTP servers and
 * mixed FTP/SSH pairs, because the reporter uses FTP:
 *   - same FTP server, file and folder (RNFR/RNTO rename)        vsftpd 2207
 *   - FTP -> SSH and SSH -> FTP (copy then delete source)         vsftpd 2207 + sshd 2201
 *   - FTP -> FTP across two different implementations             vsftpd 2207 -> pure-ftpd 2208
 *   - same-server move on pure-ftpd: moved, or refused WITHOUT data loss
 *
 * Run: npm run test:docker   (globalSetup brings up test-docker/docker-compose.yml)
 */

import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { FTPConnection } from '../connection/FTPConnection';
import { ConnectionManager } from '../connection/ConnectionManager';
import { FileTreeProvider, FileTreeItem } from '../providers/FileTreeProvider';
import { IHostConfig, IRemoteFile } from '../types';
import { SavedCredential, CredentialService } from '../services/CredentialService';
import { connectWithRetry } from './ftpTestHelpers';

type AnyConn = SSHConnection | FTPConnection;

const CRED: SavedCredential = { id: 'dnd-ftp-pw', label: 'pw', type: 'password' };
const _knownHosts: Record<string, unknown> = {};

function setupMocks(): void {
  setGlobalState({
    get: <T>(key: string, def?: T) => (_knownHosts[key] as T) ?? (def as T),
    update: async (k: string, v: unknown) => {
      _knownHosts[k] = v;
    },
    keys: () => Object.keys(_knownHosts),
  } as vscode.Memento);
  (CredentialService as any)._instance = {
    getCredentialSecret: jest.fn().mockResolvedValue('testpass'),
    getOrPrompt: jest.fn().mockResolvedValue('testpass'),
    updateCredentialPassword: jest.fn(),
    setSessionCredential: jest.fn(),
    initialize: jest.fn(),
  };
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
  (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('No, use only for this session');
}

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

/** Build the FileTreeItem VS Code would hand to handleDrag/handleDrop. */
function fileItem(conn: AnyConn, p: string, isDir: boolean): FileTreeItem {
  const file: IRemoteFile = {
    name: p.substring(p.lastIndexOf('/') + 1),
    path: p,
    isDirectory: isDir,
    size: 0,
    modifiedTime: Date.now(),
    connectionId: conn.id,
  };
  return new FileTreeItem(file, conn as SSHConnection);
}

async function put(conn: AnyConn, p: string, text: string): Promise<void> {
  await conn.writeFile(p, Buffer.from(text));
}
async function text(conn: AnyConn, p: string): Promise<string> {
  return (await conn.readFile(p)).toString();
}
async function mkdirs(conn: AnyConn, ...dirs: string[]): Promise<void> {
  for (const d of dirs) {
    let cur = '';
    for (const seg of d.split('/').filter(Boolean)) {
      cur += '/' + seg;
      if (!(await conn.fileExists(cur))) {
        await conn.mkdir(cur);
      }
    }
  }
}
async function drag(provider: FileTreeProvider, from: FileTreeItem, onto: FileTreeItem): Promise<void> {
  const dt = new vscode.DataTransfer();
  provider.handleDrag([from], dt, {} as any);
  await provider.handleDrop(onto, dt, {} as any);
}

describe('issue #18 — drag-and-drop move over FTP (e2e)', () => {
  let ftp: FTPConnection; // vsftpd 2207
  let pure: FTPConnection; // pure-ftpd 2208
  let ssh: SSHConnection; // sshd 2201
  let provider: FileTreeProvider;
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let fBase: string;
  let pBase: string;
  const sBase = `/tmp/dndftp_${stamp}`;

  beforeAll(async () => {
    setupMocks();
    ftp = new FTPConnection(ftpHost(2207), CRED);
    await connectWithRetry(ftp);
    pure = new FTPConnection(ftpHost(2208), CRED);
    await connectWithRetry(pure);
    const sshHost: IHostConfig = {
      id: 'dndftp-ssh',
      name: 'hybr8-prod-web-01',
      host: '127.0.0.1',
      port: 2201,
      username: 'testuser',
      source: 'saved',
    };
    ssh = new SSHConnection(sshHost, { id: 'dndftp-ssh-pw', label: 'pw', type: 'password' });
    await ssh.connect();

    fBase = (await ftp.resolveHomePath()).replace(/\/$/, '') + `/dnd_${stamp}`;
    pBase = (await pure.resolveHomePath()).replace(/\/$/, '') + `/dnd_${stamp}`;

    const cm = ConnectionManager.getInstance() as any;
    for (const c of [ftp, pure, ssh]) {
      cm._connections.set(c.id, c);
    }
    provider = new FileTreeProvider();
    provider.setCurrentPath(ftp.id, fBase);
    provider.setCurrentPath(pure.id, pBase);
    provider.setCurrentPath(ssh.id, sBase);

    // The reporter's layout: several sites under one FTP account.
    await mkdirs(ftp, `${fBase}/e-clothes.ru/public_html`, `${fBase}/diapic.ru/public_html/test`);
    await mkdirs(pure, `${pBase}/src`, `${pBase}/dst`);
    await ssh.exec(`mkdir -p ${sBase}/in ${sBase}/out`);
  }, 200000);

  afterAll(async () => {
    try {
      provider.dispose();
    } catch {
      /* ignore */
    }
    try {
      await ssh.exec(`rm -rf ${sBase}`);
    } catch {
      /* ignore */
    }
    const cm = ConnectionManager.getInstance() as any;
    for (const c of [ftp, pure, ssh]) {
      try {
        cm._connections.delete(c.id);
      } catch {
        /* ignore */
      }
      try {
        await c.disconnect();
      } catch {
        /* ignore */
      }
    }
    // FTP fixtures live inside each container's home and vanish with
    // `docker compose down` in globalTeardown.
  });

  it('moves a file between two sites on the SAME FTP server (the video scenario)', async () => {
    const src = `${fBase}/e-clothes.ru/public_html/index-copy.html`;
    await put(ftp, src, '<h1>moved</h1>');

    await drag(provider, fileItem(ftp, src, false), fileItem(ftp, `${fBase}/diapic.ru/public_html/test`, true));

    const dest = `${fBase}/diapic.ru/public_html/test/index-copy.html`;
    expect(await ftp.fileExists(src)).toBe(false);
    expect(await ftp.fileExists(dest)).toBe(true);
    expect(await text(ftp, dest)).toBe('<h1>moved</h1>');
  }, 60000);

  it('moves a folder with its contents on the same FTP server', async () => {
    const srcDir = `${fBase}/e-clothes.ru/public_html/assets`;
    await mkdirs(ftp, `${srcDir}/css`);
    await put(ftp, `${srcDir}/a.txt`, 'a');
    await put(ftp, `${srcDir}/css/site.css`, 'body{}');

    await drag(provider, fileItem(ftp, srcDir, true), fileItem(ftp, `${fBase}/diapic.ru/public_html`, true));

    const destDir = `${fBase}/diapic.ru/public_html/assets`;
    expect(await ftp.fileExists(srcDir)).toBe(false);
    expect(await text(ftp, `${destDir}/a.txt`)).toBe('a');
    expect(await text(ftp, `${destDir}/css/site.css`)).toBe('body{}');
  }, 60000);

  it('keeps both files when the name already exists at the destination (never overwrites)', async () => {
    const dstFolder = `${fBase}/diapic.ru/public_html/test`;
    await put(ftp, `${dstFolder}/dup.html`, 'existing');
    const src = `${fBase}/e-clothes.ru/public_html/dup.html`;
    await put(ftp, src, 'incoming');

    await drag(provider, fileItem(ftp, src, false), fileItem(ftp, dstFolder, true));

    expect(await ftp.fileExists(src)).toBe(false);
    expect(await text(ftp, `${dstFolder}/dup.html`)).toBe('existing');
    const names = (await ftp.listFiles(dstFolder)).map((f) => f.name);
    const copyName = names.find((n) => n !== 'dup.html' && n.startsWith('dup') && n.endsWith('.html'));
    expect(copyName).toBeDefined();
    expect(await text(ftp, `${dstFolder}/${copyName}`)).toBe('incoming');
  }, 60000);

  it('moves a file FTP -> SSH (copy then delete source)', async () => {
    const src = `${fBase}/e-clothes.ru/public_html/to-ssh.txt`;
    await put(ftp, src, 'ftp-to-ssh');

    await drag(provider, fileItem(ftp, src, false), fileItem(ssh, `${sBase}/in`, true));

    expect(await ftp.fileExists(src)).toBe(false);
    expect(await text(ssh, `${sBase}/in/to-ssh.txt`)).toBe('ftp-to-ssh');
  }, 60000);

  it('moves a folder SSH -> FTP and removes the source tree', async () => {
    await ssh.exec(`mkdir -p ${sBase}/out/pack && printf x > ${sBase}/out/pack/x.txt && printf y > ${sBase}/out/pack/y.txt`);

    await drag(provider, fileItem(ssh, `${sBase}/out/pack`, true), fileItem(ftp, `${fBase}/diapic.ru`, true));

    expect(await ssh.fileExists(`${sBase}/out/pack`)).toBe(false);
    expect(await text(ftp, `${fBase}/diapic.ru/pack/x.txt`)).toBe('x');
    expect(await text(ftp, `${fBase}/diapic.ru/pack/y.txt`)).toBe('y');
  }, 60000);

  it('moves a file across two different FTP servers (vsftpd -> pure-ftpd)', async () => {
    const src = `${fBase}/e-clothes.ru/public_html/cross-ftp.txt`;
    await put(ftp, src, 'vsftpd-to-pureftpd');

    await drag(provider, fileItem(ftp, src, false), fileItem(pure, `${pBase}/dst`, true));

    expect(await ftp.fileExists(src)).toBe(false);
    expect(await text(pure, `${pBase}/dst/cross-ftp.txt`)).toBe('vsftpd-to-pureftpd');
  }, 60000);

  it('same-server move on pure-ftpd either moves or fails loudly — never loses the file', async () => {
    const src = `${pBase}/src/keep.txt`;
    await put(pure, src, 'precious');
    const errSpy = vscode.window.showErrorMessage as jest.Mock;
    errSpy.mockClear();

    await drag(provider, fileItem(pure, src, false), fileItem(pure, `${pBase}/dst`, true));

    const dest = `${pBase}/dst/keep.txt`;
    if (await pure.fileExists(dest)) {
      expect(await text(pure, dest)).toBe('precious');
      expect(await pure.fileExists(src)).toBe(false);
    } else {
      // Rename refused by the server: the source must be intact and the user told.
      expect(await text(pure, src)).toBe('precious');
      expect(errSpy).toHaveBeenCalled();
    }
  }, 60000);
});
