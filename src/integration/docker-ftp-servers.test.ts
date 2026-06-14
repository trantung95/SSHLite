/**
 * Docker integration: FTPConnection against MULTIPLE real FTP server
 * implementations (issue #9).
 *
 * Mocks miss server-specific behavior (LIST vs MLSD output, chroot vs real home,
 * rename permission, TLS handshake). This matrix runs the real FTPConnection
 * against:
 *   - vsftpd      (delfer/alpine-ftp-server, port 2207) - NOT chrooted, home /ftp/testuser, rename allowed
 *   - pure-ftpd   (stilliard/pure-ftpd,      port 2208) - chrooted home /, rename DENIED (hardened)
 *   - pure-ftpd over explicit FTPS/TLS       (port 2208, secure) - self-signed cert
 *
 *   docker compose -f test-docker/docker-compose.yml up -d ftp ftp-pure
 *   npx jest --config jest.docker.config.js -- docker-ftp-servers
 */
import { FTPConnection } from '../connection/FTPConnection';
import { ConnectionState, IHostConfig } from '../types';
import { SavedCredential } from '../services/CredentialService';
import { setMockConfig, clearMockConfig } from '../__mocks__/vscode';
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

interface ServerCase {
  name: string;
  port: number;
  secure: boolean;
  renameSupported: boolean;
}

const SERVERS: ServerCase[] = [
  { name: 'vsftpd (delfer)', port: 2207, secure: false, renameSupported: true },
  { name: 'pure-ftpd (plain)', port: 2208, secure: false, renameSupported: false },
  { name: 'pure-ftpd (explicit FTPS/TLS)', port: 2208, secure: true, renameSupported: false },
];

function hostFor(s: ServerCase): IHostConfig {
  return {
    id: `127.0.0.1:${s.port}:testuser`,
    name: s.name,
    host: '127.0.0.1',
    port: s.port,
    username: 'testuser',
    source: 'saved',
    connectionType: 'ftp',
    secure: s.secure,
  };
}

describe.each(SERVERS)('FTPConnection vs $name', (s) => {
  let conn: FTPConnection;
  let base: string;

  beforeAll(async () => {
    if (s.secure) {
      // Self-signed cert on the test server: accept it.
      setMockConfig('sshLite.ftpRejectUnauthorized', false);
    }
    conn = new FTPConnection(hostFor(s), CRED);
    // pure-ftpd blocks new connections (plain AND FTPS) while it generates its
    // self-signed cert + 2048-bit DH params on first boot, so a cold container
    // answers with "Server sent FIN packet" / a TLS error. Retry so the suite is
    // robust against a freshly-started container. Warm containers connect first try.
    await connectWithRetry(conn);
    base = (await conn.resolveHomePath()).replace(/\/$/, '');
  }, 120000);

  afterAll(async () => {
    if (conn) await conn.disconnect();
    clearMockConfig();
  });

  const p = (n: string) => `${base}/${n}`;

  it('connects and resolves an absolute home directory', async () => {
    expect(conn.state).toBe(ConnectionState.Connected);
    const home = await conn.resolveHomePath();
    expect(home.startsWith('/')).toBe(true);
  });

  it('writes, stats, reads, and lists a file', async () => {
    const f = p(`m-${Date.now()}.txt`);
    const body = Buffer.from('matrix payload\n');
    await conn.writeFile(f, body);

    const st = await conn.stat(f);
    expect(st.isDirectory).toBe(false);
    expect(st.size).toBe(body.length);

    const read = await conn.readFile(f);
    expect(read.toString()).toBe(body.toString());

    const listed = await conn.listFiles(base || '/');
    expect(listed.some((e) => e.path === f)).toBe(true);

    await conn.deleteFile(f);
    expect(await conn.fileExists(f)).toBe(false);
  });

  it('creates and removes a directory', async () => {
    const d = p(`md-${Date.now()}`);
    await conn.mkdir(d);
    expect((await conn.stat(d)).isDirectory).toBe(true);
    await conn.deleteFile(d);
    expect(await conn.fileExists(d)).toBe(false);
  });

  it(`${'rename'} behaves correctly for this server`, async () => {
    const a = p(`r-${Date.now()}.txt`);
    const b = p(`r-${Date.now()}.moved.txt`);
    await conn.writeFile(a, Buffer.from('x'));
    if (s.renameSupported) {
      await conn.rename(a, b);
      expect(await conn.fileExists(a)).toBe(false);
      expect(await conn.fileExists(b)).toBe(true);
      await conn.deleteFile(b);
    } else {
      // Server denies RNFR/RNTO: must surface as a clean FTPError, never crash.
      await expect(conn.rename(a, b)).rejects.toThrow();
      await conn.deleteFile(a);
    }
  });

  it('serializes concurrent operations (single control socket)', async () => {
    const files = Array.from({ length: 6 }, (_, i) => p(`c-${Date.now()}-${i}.txt`));
    await Promise.all(files.map((f) => conn.writeFile(f, Buffer.from(f))));
    const listed = await conn.listFiles(base || '/');
    for (const f of files) {
      expect(listed.some((e) => e.path === f)).toBe(true);
    }
    await Promise.all(files.map((f) => conn.deleteFile(f)));
  });
});
