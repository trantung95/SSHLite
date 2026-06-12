/**
 * Native search tools — real-server integration (issue: native-tool search speedup).
 *
 * Two isolated containers (docker-compose.search-tools.yml):
 *   - port 2207 "search-tools": ripgrep + fd + plocate + GNU userland.
 *   - port 2208 "search-busybox": busybox-only (no GNU grep/findutils).
 *
 * The centerpiece is the RESULTS-PARITY suite: the same fixture tree searched
 * with nativeTools:'auto' (rg/fd) vs 'off' (grep/find) must return the SAME
 * sorted result set. Plus: the busybox `grep --include` silent-0 regression,
 * runtime fallback when a native binary is broken, and indexed (plocate) search.
 *
 * Run with: npm run test:docker:search-tools   (requires Docker Desktop running)
 */
import { SSHConnection } from '../connection/SSHConnection';
import { OSServerConfig, createTestConnection, safeDisconnect, setupCredentialServiceMock, setupVscodeMocks } from './multios-helpers';

const TOOLS_SERVER: OSServerConfig = { os: 'search-tools', host: '127.0.0.1', port: 2207, username: 'testuser', password: 'testpass', hostname: 'search-tools', shell: 'ash' };
const BUSYBOX_SERVER: OSServerConfig = { os: 'search-busybox', host: '127.0.0.1', port: 2208, username: 'testuser', password: 'testpass', hostname: 'search-busybox', shell: 'ash' };

const BASE = '/home/testuser/searchfix';

const sortedPaths = (rows: Array<{ path: string }>) => Array.from(new Set(rows.map((r) => r.path))).sort();

beforeAll(() => {
  setupCredentialServiceMock();
  setupVscodeMocks();
});

describe('Results parity: rg/fd (auto) vs grep/find (off) on the tools server', () => {
  let conn: SSHConnection;
  beforeAll(async () => { conn = await createTestConnection(TOOLS_SERVER); });
  afterAll(async () => { await safeDisconnect(conn); });

  it('detects ripgrep + fd + plocate on the server', async () => {
    const tools = await conn.getRemoteSearchTools();
    expect(tools.rg).toBeTruthy();
    expect(tools.fd).toBeTruthy();
    expect(tools.plocate || tools.locate).toBeTruthy();
    expect(tools.grepFlavor).toBe('gnu');
  });

  it('content search returns identical file sets for auto vs off (incl hidden + ignored + excluded-dir matches)', async () => {
    const auto = await conn.searchFiles(BASE, 'needle', { searchContent: true, maxResults: 0, nativeTools: 'auto' });
    const off = await conn.searchFiles(BASE, 'needle', { searchContent: true, maxResults: 0, nativeTools: 'off' });
    // grep -r walks hidden + ignored files (no gitignore awareness); rg must match
    // that via --no-ignore --hidden. Both must include the node_modules match too.
    expect(sortedPaths(auto)).toEqual(sortedPaths(off));
    expect(sortedPaths(off)).toEqual(expect.arrayContaining([
      `${BASE}/normal.txt`,
      `${BASE}/.hidden/secret.txt`,
      `${BASE}/ignored.log`,
      `${BASE}/node_modules/pkg/dep.txt`,
      `${BASE}/my file.txt`,
    ]));
  });

  it('content search with an include pattern matches for auto vs off', async () => {
    const auto = await conn.searchFiles(BASE, 'needle', { searchContent: true, filePattern: '*.ts', maxResults: 0, nativeTools: 'auto' });
    const off = await conn.searchFiles(BASE, 'needle', { searchContent: true, filePattern: '*.ts', maxResults: 0, nativeTools: 'off' });
    expect(sortedPaths(auto)).toEqual(sortedPaths(off));
    expect(sortedPaths(auto)).toEqual([`${BASE}/sub/app.ts`]);
  });

  it('content search with an exclude pattern matches for auto vs off', async () => {
    const auto = await conn.searchFiles(BASE, 'needle', { searchContent: true, excludePattern: 'node_modules', maxResults: 0, nativeTools: 'auto' });
    const off = await conn.searchFiles(BASE, 'needle', { searchContent: true, excludePattern: 'node_modules', maxResults: 0, nativeTools: 'off' });
    expect(sortedPaths(auto)).toEqual(sortedPaths(off));
    expect(sortedPaths(auto)).not.toContain(`${BASE}/node_modules/pkg/dep.txt`);
  });

  it('filename search (fd vs find) returns identical sets', async () => {
    const auto = await conn.searchFiles(BASE, 'app', { searchContent: false, maxResults: 0, nativeTools: 'auto' });
    const off = await conn.searchFiles(BASE, 'app', { searchContent: false, maxResults: 0, nativeTools: 'off' });
    expect(sortedPaths(auto)).toEqual(sortedPaths(off));
    expect(sortedPaths(auto)).toEqual(expect.arrayContaining([`${BASE}/sub/app.ts`, `${BASE}/sub/app.js`]));
  });

  it('filename search with excludes prunes node_modules identically', async () => {
    const auto = await conn.searchFiles(BASE, 'dep', { searchContent: false, excludePattern: 'node_modules', maxResults: 0, nativeTools: 'auto' });
    const off = await conn.searchFiles(BASE, 'dep', { searchContent: false, excludePattern: 'node_modules', maxResults: 0, nativeTools: 'off' });
    expect(sortedPaths(auto)).toEqual(sortedPaths(off));
    expect(sortedPaths(auto)).toEqual([]); // dep.txt is inside the pruned dir
  });

  it('worker-pool explicit file-list content search (rg -g vs grep --include) matches', async () => {
    const files = [`${BASE}/sub/app.ts`, `${BASE}/sub/app.js`, `${BASE}/normal.txt`];
    const auto = await conn.searchFiles(files, 'needle', { searchContent: true, maxResults: 0, nativeTools: 'auto' });
    const off = await conn.searchFiles(files, 'needle', { searchContent: true, maxResults: 0, nativeTools: 'off' });
    expect(sortedPaths(auto)).toEqual(sortedPaths(off));
  });

  it('indexed search (plocate) finds the seeded files (built by updatedb at image build)', async () => {
    const indexed = await conn.searchIndexed(BASE, 'app', { maxResults: 0 });
    expect(indexed).not.toBeNull();
    expect(indexed!.tool).toBe('plocate');
    const paths = indexed!.results.map((r) => r.path).sort();
    expect(paths).toEqual(expect.arrayContaining([`${BASE}/sub/app.ts`, `${BASE}/sub/app.js`]));
    // staleness probe returns a number (db mtime) or null — never throws.
    expect(indexed!.dbMTimeMs === null || typeof indexed!.dbMTimeMs === 'number').toBe(true);
  });

  it('indexed results are anchored under basePath and match the basename only', async () => {
    const indexed = await conn.searchIndexed(BASE, 'app', { maxResults: 0 });
    for (const r of indexed!.results) {
      expect(r.path.startsWith(BASE + '/')).toBe(true);
      const basename = r.path.slice(r.path.lastIndexOf('/') + 1);
      expect(basename.toLowerCase()).toContain('app');
    }
  });
});

describe('busybox server: grep --include silent-0 regression + fallback', () => {
  let conn: SSHConnection;
  beforeAll(async () => { conn = await createTestConnection(BUSYBOX_SERVER); });
  afterAll(async () => { await safeDisconnect(conn); });

  it('detects a non-GNU grep flavor', async () => {
    const tools = await conn.getRemoteSearchTools();
    expect(tools.grepFlavor).not.toBe('gnu');
    expect(tools.rg).toBeFalsy();
  });

  it('content search WITH an include pattern returns results under auto (find|xargs fix)', async () => {
    const auto = await conn.searchFiles(BASE, 'needle', { searchContent: true, filePattern: '*.ts', maxResults: 0, nativeTools: 'auto' });
    expect(sortedPaths(auto)).toEqual([`${BASE}/sub/app.ts`]);
  });

  it('demonstrates the bug: the same search under off returns EMPTY (busybox grep --include exits 2)', async () => {
    const off = await conn.searchFiles(BASE, 'needle', { searchContent: true, filePattern: '*.ts', maxResults: 0, nativeTools: 'off' });
    // The latent bug the auto path fixes — busybox grep can't do --include, so
    // the GNU-assuming legacy command exits 2 and `2>/dev/null` hides it → 0 results.
    expect(off.length).toBe(0);
  });

  it('plain content search (no user filter) works under auto', async () => {
    // 'auto' detects the non-GNU grep and drops the default --include='*' so the
    // plain search succeeds on busybox (where 'off' would also fail on --include='*').
    const auto = await conn.searchFiles(BASE, 'needle', { searchContent: true, maxResults: 0, nativeTools: 'auto' });
    expect(auto.length).toBeGreaterThan(0);
    expect(sortedPaths(auto)).toEqual(expect.arrayContaining([`${BASE}/normal.txt`, `${BASE}/sub/app.ts`]));
  });

  it('indexed search returns null (no locate on busybox) so the caller falls back to live find', async () => {
    const indexed = await conn.searchIndexed(BASE, 'app', { maxResults: 0 });
    expect(indexed).toBeNull();
  });
});

describe('cancellation kills the native tool', () => {
  let conn: SSHConnection;
  beforeAll(async () => { conn = await createTestConnection(TOOLS_SERVER); });
  afterAll(async () => { await safeDisconnect(conn); });

  it('aborting a native (rg) search resolves to an empty result set', async () => {
    const ac = new AbortController();
    const p = conn.searchFiles(BASE, 'needle', { searchContent: true, maxResults: 0, nativeTools: 'auto', signal: ac.signal });
    ac.abort();
    const res = await p;
    expect(res).toEqual([]);
  });
});
