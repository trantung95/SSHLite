/**
 * Docker integration regression for issue #17.
 *
 * A user on shared hosting reported three FTP failures at once while the file
 * tree rendered fine:
 *   - "FTP delete failed: 550 Delete operation failed."           (DELE a file)
 *   - "FTP read failed: 550 Failed to open file."                 (RETR a file)
 *   - "FTP delete failed: 550 Remove directory operation failed." (RMD a dir)
 *
 * Root cause (reproduced here, not assumed): the FTP account can LIST a directory
 * but lacks write permission on its parent / read permission on the file, so the
 * server refuses every mutation with a 550 while LIST keeps working. Our code
 * passes correct paths (LIST succeeds and an OWNED file deletes fine), so the fix
 * is transparency: a 550 is wrapped with a permission-aware, actionable message
 * (see describeFtpFailure) instead of the opaque raw reply.
 *
 * Fixtures are root-owned, so they must be planted via `docker exec` (the FTP
 * user cannot create a non-writable parent over FTP). The container is recreated
 * for each docker-test run, so seed in beforeAll.
 *
 *   docker compose -f test-docker/docker-compose.yml up -d ftp
 *   npx jest --config jest.docker.config.js -- docker-ftp-permission
 */
import { execSync } from 'child_process';
import { FTPConnection } from '../connection/FTPConnection';
import { FTPError, IHostConfig } from '../types';
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
const HOME = '/ftp/testuser';
const PROT = `${HOME}/protected`;

/** Plant a directory the FTP user can list+enter but not write, with root-owned contents. */
function seedFixtures(): void {
  // A single sh -c keeps it one docker round-trip; chmod 755 on `protected`
  // lets testuser LIST/enter it, but 0 write means DELE/RMD inside is refused.
  const script = [
    'cd /ftp/testuser',
    'rm -rf protected owndir',
    'mkdir -p protected/emptydir protected/sub owndir',
    'echo data > protected/test2222.php',
    'echo secret > protected/noread.php',
    'echo x > protected/sub/inner.txt',
    'echo hi > owndir/own.txt',
    'chown -R root:root protected',
    'chmod 755 protected protected/emptydir protected/sub',
    'chmod 644 protected/test2222.php protected/sub/inner.txt',
    'chmod 600 protected/noread.php',
    'chown -R testuser:testuser owndir',
  ].join(' && ');
  execSync(`docker exec sshlite-test-ftp sh -c "${script}"`, { stdio: 'pipe', timeout: 30000 });
}

function cleanupFixtures(): void {
  try {
    execSync('docker exec sshlite-test-ftp sh -c "rm -rf /ftp/testuser/protected /ftp/testuser/owndir"', {
      stdio: 'pipe',
      timeout: 30000,
    });
  } catch {
    // best-effort; the container is torn down after the suite anyway
  }
}

/** Run an op and return the rejection (or throw if it unexpectedly succeeds). */
async function expectReject(fn: () => Promise<unknown>): Promise<Error> {
  return fn().then(
    () => { throw new Error('expected the FTP op to be refused, but it succeeded'); },
    (e) => e as Error
  );
}

describe('issue #17 — FTP 550 permission errors are transparent and actionable', () => {
  let conn: FTPConnection;

  beforeAll(async () => {
    conn = new FTPConnection(HOST, CRED);
    await connectWithRetry(conn);
    seedFixtures();
  }, 120000);

  afterAll(async () => {
    cleanupFixtures();
    if (conn) await conn.disconnect();
  });

  it('LIST works on a directory whose contents cannot be modified', async () => {
    // The user CAN browse — proving our paths are correct and the failures below
    // are the server refusing mutations, not a path/code bug.
    const names = (await conn.listFiles(PROT)).map((f) => `${f.name}${f.isDirectory ? '/' : ''}`).sort();
    expect(names).toEqual(expect.arrayContaining(['test2222.php', 'noread.php', 'emptydir/', 'sub/']));
  });

  it('DELE of a non-writable file -> 550 wrapped with a permission hint', async () => {
    const err = await expectReject(() => conn.deleteFile(`${PROT}/test2222.php`));
    expect(err).toBeInstanceOf(FTPError);
    expect(err.message).toContain('550 Delete operation failed.'); // raw reply preserved
    expect(err.message).toMatch(/permission/i);
    expect(err.message).toMatch(/shared hosting/i);
  });

  it('RETR of an unreadable file -> 550 wrapped with a permission hint', async () => {
    const err = await expectReject(() => conn.readFile(`${PROT}/noread.php`));
    expect(err).toBeInstanceOf(FTPError);
    expect(err.message).toContain('550 Failed to open file.');
    expect(err.message).toMatch(/permission/i);
  });

  it('RMD of a dir in a non-writable parent -> 550 wrapped with a permission hint', async () => {
    const err = await expectReject(() => conn.deleteFile(`${PROT}/emptydir`));
    expect(err).toBeInstanceOf(FTPError);
    expect(err.message).toContain('550 Remove directory operation failed.');
    expect(err.message).toMatch(/permission/i);
  });

  it('control: a file the FTP user OWNS still deletes cleanly (no false positives)', async () => {
    await expect(conn.deleteFile(`${HOME}/owndir/own.txt`)).resolves.toBeUndefined();
    expect(await conn.fileExists(`${HOME}/owndir/own.txt`)).toBe(false);
  });
});
