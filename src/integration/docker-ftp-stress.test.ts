/**
 * Docker integration: FTPConnection STRESS / edge-case matrix (issue #9).
 *
 * The docker-ftp-servers / -fileops / -fileservice suites prove the happy path
 * across server implementations. This suite hammers the harder corners that a
 * real user can hit and that mocks cannot reproduce:
 *
 *   - 0-byte files, large (8 MB) binary streams, full 0..255 byte coverage, UTF-8
 *   - filenames with spaces / unicode / dots
 *   - deep nested mkdir + traversal
 *   - HIGH concurrency through the single-control-socket serialization queue,
 *     verifying byte-for-byte integrity (LITE: never lose / corrupt data)
 *   - overwrite-in-place
 *   - every error branch: read/stat/list/delete of a missing path, bad password,
 *     unreachable port, operating after disconnect
 *   - disconnect -> reconnect -> operate
 *
 * Requires the FTP containers up:
 *   docker compose -f test-docker/docker-compose.yml up -d ftp ftp-pure
 *   npx jest --config jest.docker.config.js -- docker-ftp-stress
 */
import { FTPConnection } from '../connection/FTPConnection';
import {
  ConnectionState,
  IHostConfig,
  AuthenticationError,
  FTPError,
  ConnectionError,
} from '../types';
import { SavedCredential } from '../services/CredentialService';
import { setMockConfig, clearMockConfig } from '../__mocks__/vscode';
import { connectWithRetry } from './ftpTestHelpers';

// CredentialService returns the right password for the "good" cases; a per-test
// override drives the bad-password case.
var mockSecret = 'testpass';
jest.mock('../services/CredentialService', () => ({
  CredentialService: {
    getInstance: jest.fn().mockReturnValue({
      getCredentialSecret: jest.fn(() => Promise.resolve(mockSecret)),
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

describe.each(SERVERS)('FTP stress vs $name', (s) => {
  let conn: FTPConnection;
  let base: string;
  const made: string[] = [];

  beforeAll(async () => {
    mockSecret = 'testpass';
    conn = new FTPConnection(hostFor(s), CRED);
    await connectWithRetry(conn); // pure-ftpd (2208) cold-start warmup tolerance
    base = (await conn.resolveHomePath()).replace(/\/$/, '');
  }, 120000);

  afterAll(async () => {
    // best-effort cleanup of anything left behind
    for (const f of made.reverse()) {
      try {
        if (await conn.fileExists(f)) await conn.deleteFile(f);
      } catch {
        /* ignore */
      }
    }
    if (conn) await conn.disconnect();
    clearMockConfig();
  });

  const p = (n: string) => `${base}/${n}`;
  const track = (f: string) => {
    made.push(f);
    return f;
  };

  // ---- payload shapes -------------------------------------------------------

  it('round-trips a 0-byte file', async () => {
    const f = track(p(`empty-${Date.now()}.bin`));
    await conn.writeFile(f, Buffer.alloc(0));
    expect((await conn.stat(f)).size).toBe(0);
    const read = await conn.readFile(f);
    expect(read.length).toBe(0);
    await conn.deleteFile(f);
  });

  it('round-trips an 8 MB binary stream byte-for-byte', async () => {
    const f = track(p(`big-${Date.now()}.bin`));
    const size = 8 * 1024 * 1024;
    const body = Buffer.allocUnsafe(size);
    for (let i = 0; i < size; i++) body[i] = (i * 31 + 7) & 0xff;
    await conn.writeFile(f, body);
    expect((await conn.stat(f)).size).toBe(size);
    const read = await conn.readFile(f);
    expect(read.length).toBe(size);
    expect(Buffer.compare(read, body)).toBe(0);
    await conn.deleteFile(f);
  }, 60000);

  it('preserves all 256 byte values (no encoding mangling)', async () => {
    const f = track(p(`allbytes-${Date.now()}.bin`));
    const body = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await conn.writeFile(f, body);
    const read = await conn.readFile(f);
    expect(Buffer.compare(read, body)).toBe(0);
    await conn.deleteFile(f);
  });

  it('preserves UTF-8 multibyte content', async () => {
    const f = track(p(`utf8-${Date.now()}.txt`));
    const body = Buffer.from('Xin chào — café — 日本語 — 🚀\n', 'utf8');
    await conn.writeFile(f, body);
    const read = await conn.readFile(f);
    expect(read.toString('utf8')).toBe(body.toString('utf8'));
    await conn.deleteFile(f);
  });

  // ---- tricky filenames -----------------------------------------------------

  it('handles filenames with spaces and dots', async () => {
    const f = track(p(`a file.with.dots ${Date.now()}.txt`));
    await conn.writeFile(f, Buffer.from('spaced'));
    expect(await conn.fileExists(f)).toBe(true);
    expect((await conn.readFile(f)).toString()).toBe('spaced');
    const listed = await conn.listFiles(base);
    expect(listed.some((e) => e.path === f)).toBe(true);
    await conn.deleteFile(f);
  });

  it('handles a unicode filename', async () => {
    const f = track(p(`tài-liệu-${Date.now()}.txt`));
    await conn.writeFile(f, Buffer.from('unicode name'));
    expect(await conn.fileExists(f)).toBe(true);
    await conn.deleteFile(f);
    expect(await conn.fileExists(f)).toBe(false);
  });

  // ---- directory nesting ----------------------------------------------------

  it('creates and traverses a deep nested tree', async () => {
    const root = track(p(`deep-${Date.now()}`));
    const deep = `${root}/a/b/c/d`;
    await conn.mkdir(deep);
    expect((await conn.stat(deep)).isDirectory).toBe(true);

    const leaf = `${deep}/leaf.txt`;
    await conn.writeFile(leaf, Buffer.from('deep'));
    expect((await conn.readFile(leaf)).toString()).toBe('deep');

    // listing an intermediate dir shows the next level
    const midList = await conn.listFiles(`${root}/a/b`);
    expect(midList.some((e) => e.name === 'c' && e.isDirectory)).toBe(true);

    // tear down depth-first
    await conn.deleteFile(leaf);
    for (const d of [deep, `${root}/a/b/c`, `${root}/a/b`, `${root}/a`, root]) {
      await conn.deleteFile(d);
    }
    expect(await conn.fileExists(root)).toBe(false);
  });

  // ---- overwrite ------------------------------------------------------------

  it('overwrites an existing file in place', async () => {
    const f = track(p(`ow-${Date.now()}.txt`));
    await conn.writeFile(f, Buffer.from('first version, longer'));
    await conn.writeFile(f, Buffer.from('second'));
    expect((await conn.readFile(f)).toString()).toBe('second');
    expect((await conn.stat(f)).size).toBe('second'.length);
    await conn.deleteFile(f);
  });

  // ---- concurrency through the serialization queue --------------------------

  it('keeps 25 concurrent write+read pairs byte-correct', async () => {
    const N = 25;
    const files = Array.from({ length: N }, (_, i) => track(p(`q-${Date.now()}-${i}.txt`)));
    // unique, length-varying payload per file
    const bodies = files.map((f, i) => Buffer.from(`${f}::${'x'.repeat(i * 37)}`));

    await Promise.all(files.map((f, i) => conn.writeFile(f, bodies[i])));
    const reads = await Promise.all(files.map((f) => conn.readFile(f)));
    reads.forEach((r, i) => {
      expect(Buffer.compare(r, bodies[i])).toBe(0);
    });

    const listed = await conn.listFiles(base);
    for (const f of files) expect(listed.some((e) => e.path === f)).toBe(true);

    await Promise.all(files.map((f) => conn.deleteFile(f)));
    const after = await conn.listFiles(base);
    for (const f of files) expect(after.some((e) => e.path === f)).toBe(false);
  }, 60000);

  it('interleaves mixed operation types concurrently without crashing', async () => {
    const f = track(p(`mix-${Date.now()}.txt`));
    await conn.writeFile(f, Buffer.from('seed'));
    const ops: Promise<unknown>[] = [
      conn.listFiles(base),
      conn.stat(f),
      conn.fileExists(f),
      conn.readFile(f),
      conn.listFiles(base),
      conn.fileExists(p('definitely-not-here.xyz')),
    ];
    const results = await Promise.allSettled(ops);
    // none should reject for the valid ops; the missing-file existence check resolves false
    expect(results[0].status).toBe('fulfilled');
    expect(results[5].status).toBe('fulfilled');
    await conn.deleteFile(f);
  });

  // ---- stat / fileExists semantics -----------------------------------------

  it('reports home and root as directories', async () => {
    expect((await conn.stat(base || '/')).isDirectory).toBe(true);
    expect(await conn.fileExists(base || '/')).toBe(true);
  });

  it('formats a 9-char rwx permission string when the server reports perms', async () => {
    const f = track(p(`perm-${Date.now()}.txt`));
    await conn.writeFile(f, Buffer.from('p'));
    const st = await conn.stat(f);
    if (st.permissions !== undefined) {
      expect(st.permissions).toMatch(/^[r-][w-][x-][r-][w-][x-][r-][w-][x-]$/);
    }
    await conn.deleteFile(f);
  });

  it('lists directories before files, alphabetically', async () => {
    const dir = track(p(`sort-${Date.now()}`));
    await conn.mkdir(dir);
    await conn.mkdir(`${dir}/zeta`);
    await conn.mkdir(`${dir}/alpha`);
    await conn.writeFile(`${dir}/b.txt`, Buffer.from('b'));
    await conn.writeFile(`${dir}/a.txt`, Buffer.from('a'));
    const listed = await conn.listFiles(dir);
    const names = listed.map((e) => e.name);
    expect(names).toEqual(['alpha', 'zeta', 'a.txt', 'b.txt']);
    await conn.deleteFile(`${dir}/a.txt`);
    await conn.deleteFile(`${dir}/b.txt`);
    await conn.deleteFile(`${dir}/zeta`);
    await conn.deleteFile(`${dir}/alpha`);
    await conn.deleteFile(dir);
  });

  // ---- error branches -------------------------------------------------------

  it('rejects reading a missing file', async () => {
    await expect(conn.readFile(p(`nope-${Date.now()}.txt`))).rejects.toBeInstanceOf(FTPError);
  });

  it('rejects stat of a missing file', async () => {
    await expect(conn.stat(p(`nope-${Date.now()}.txt`))).rejects.toBeInstanceOf(FTPError);
  });

  it('reports fileExists=false for a missing path (no throw)', async () => {
    expect(await conn.fileExists(p(`nope-${Date.now()}.txt`))).toBe(false);
  });

  it('rejects listing a missing directory (parity with SSH readdir)', async () => {
    await expect(conn.listFiles(p(`nodir-${Date.now()}`))).rejects.toBeInstanceOf(FTPError);
  });

  it('returns [] for a real but EMPTY directory (no false missing error)', async () => {
    const dir = track(p(`emptydir-${Date.now()}`));
    await conn.mkdir(dir);
    const listed = await conn.listFiles(dir);
    expect(Array.isArray(listed)).toBe(true);
    expect(listed.length).toBe(0);
    await conn.deleteFile(dir);
  });

  it('rejects deleting a missing file', async () => {
    await expect(conn.deleteFile(p(`nope-${Date.now()}.txt`))).rejects.toBeTruthy();
  });

  // ---- reconnect ------------------------------------------------------------

  it('survives disconnect -> reconnect -> operate', async () => {
    await conn.disconnect();
    expect(conn.state).toBe(ConnectionState.Disconnected);
    await conn.connect();
    expect(conn.state).toBe(ConnectionState.Connected);
    const f = track(p(`recon-${Date.now()}.txt`));
    await conn.writeFile(f, Buffer.from('after reconnect'));
    expect((await conn.readFile(f)).toString()).toBe('after reconnect');
    await conn.deleteFile(f);
  });

  it('rejects operations after disconnect with a ConnectionError', async () => {
    const tmp = new FTPConnection(hostFor(s), CRED);
    await tmp.connect();
    await tmp.disconnect();
    await expect(tmp.listFiles(base)).rejects.toBeInstanceOf(ConnectionError);
  });
});

// ---- connection-level failures (server-agnostic) ---------------------------

describe('FTP connection failures', () => {
  afterEach(() => clearMockConfig());

  it('maps a wrong password to AuthenticationError', async () => {
    mockSecret = 'wrong-password';
    const conn = new FTPConnection(hostFor(SERVERS[0]), CRED);
    await expect(conn.connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(conn.state).toBe(ConnectionState.Error);
    mockSecret = 'testpass';
  }, 30000);

  it('maps an unreachable port to an FTP/Connection error', async () => {
    const dead: IHostConfig = {
      id: '127.0.0.1:2299:testuser',
      name: 'dead',
      host: '127.0.0.1',
      port: 2299, // nothing listening
      username: 'testuser',
      source: 'saved',
      connectionType: 'ftp',
    };
    const conn = new FTPConnection(dead, CRED);
    await expect(conn.connect()).rejects.toBeTruthy();
    expect(conn.state).toBe(ConnectionState.Error);
  }, 30000);

  it('rejects an empty hostname before dialing', async () => {
    const bad: IHostConfig = {
      id: ':2207:testuser',
      name: 'bad',
      host: '',
      port: 2207,
      username: 'testuser',
      source: 'saved',
      connectionType: 'ftp',
    };
    const conn = new FTPConnection(bad, CRED);
    await expect(conn.connect()).rejects.toBeInstanceOf(ConnectionError);
  });
});
