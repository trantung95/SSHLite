/**
 * Docker integration test for FTP support (issue #9).
 *
 * Exercises the real FTPConnection against the pure-ftpd container on port 2207
 * (see test-docker/docker-compose.yml). Proves browse/read/write/rename/delete/
 * mkdir/stat work end-to-end over a live FTP server with passive-mode transfers
 * through Docker NAT — not just against mocks.
 *
 *   docker compose -f test-docker/docker-compose.yml up -d ftp
 *   npx jest --config jest.docker.config.js -- docker-ftp-fileops
 *
 * CredentialService is mocked so the connection gets the testuser password
 * without touching VS Code SecretStorage; vscode is mapped to the unit mock.
 */
import { FTPConnection } from '../connection/FTPConnection';
import { ConnectionState, IHostConfig } from '../types';
import { SavedCredential } from '../services/CredentialService';
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

const HOST: IHostConfig = {
  id: '127.0.0.1:2207:testuser',
  name: 'docker-ftp',
  host: '127.0.0.1',
  port: 2207,
  username: 'testuser',
  source: 'saved',
  connectionType: 'ftp',
};
const CRED: SavedCredential = { id: 'c1', label: 'pw', type: 'password' };

// pure-ftpd chroots the user, so the FTP login directory ("home") is the chroot
// root. Derive the base from the connection rather than hardcoding a server path.
let BASE = '/';

describe('FTPConnection against docker vsftpd (issue #9)', () => {
  let conn: FTPConnection;

  beforeAll(async () => {
    conn = new FTPConnection(HOST, CRED);
    await connectWithRetry(conn);
    BASE = (await conn.resolveHomePath()).replace(/\/$/, '');
  }, 120000);

  afterAll(async () => {
    if (conn) await conn.disconnect();
  });

  it('connects and reports an absolute login directory', async () => {
    expect(conn.state).toBe(ConnectionState.Connected);
    const home = await conn.resolveHomePath();
    expect(home.startsWith('/')).toBe(true);
  });

  it('round-trips a file: write -> stat -> read -> list -> rename -> delete', async () => {
    const p = `${BASE}/it-${Date.now()}.txt`;
    const body = Buffer.from('hello ftp world\n');

    await conn.writeFile(p, body);

    const st = await conn.stat(p);
    expect(st.isDirectory).toBe(false);
    expect(st.size).toBe(body.length);

    const read = await conn.readFile(p);
    expect(read.toString()).toBe(body.toString());

    const listed = await conn.listFiles(BASE);
    expect(listed.some((f) => f.path === p)).toBe(true);

    const moved = `${p}.moved`;
    await conn.rename(p, moved);
    expect(await conn.fileExists(p)).toBe(false);
    expect(await conn.fileExists(moved)).toBe(true);

    await conn.deleteFile(moved);
    expect(await conn.fileExists(moved)).toBe(false);
  });

  it('creates and removes a directory', async () => {
    const dir = `${BASE}/dir-${Date.now()}`;
    await conn.mkdir(dir);
    const st = await conn.stat(dir);
    expect(st.isDirectory).toBe(true);
    await conn.deleteFile(dir);
    expect(await conn.fileExists(dir)).toBe(false);
  });

  it('serializes concurrent operations without corrupting the control socket', async () => {
    const files = Array.from({ length: 5 }, (_, i) => `${BASE}/c-${Date.now()}-${i}.txt`);
    await Promise.all(files.map((f) => conn.writeFile(f, Buffer.from(f))));
    const listed = await conn.listFiles(BASE);
    for (const f of files) {
      expect(listed.some((e) => e.path === f)).toBe(true);
    }
    await Promise.all(files.map((f) => conn.deleteFile(f)));
  });
});
