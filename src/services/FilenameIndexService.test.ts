import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { setMockConfig, clearMockConfig } from '../__mocks__/vscode';
import { FilenameIndexService } from './FilenameIndexService';

// A minimal in-memory ExtensionContext: real temp dir for the gz blobs + a
// Map-backed globalState (the shared vscode mock's globalState is a no-op).
function makeContext(dir: string): any {
  const store = new Map<string, unknown>();
  return {
    globalStorageUri: { fsPath: dir },
    globalState: {
      get: (k: string, d: unknown) => (store.has(k) ? store.get(k) : d),
      update: async (k: string, v: unknown) => { store.set(k, v); },
    },
  };
}

// A fake SSHConnection: only `host` (for the stable key) and `searchFiles`.
function makeConn(hostName: string, paths: string[]): any {
  return {
    host: { host: hostName, port: 22, username: 'u' },
    searchFiles: jest.fn().mockResolvedValue(paths.map((p) => ({ path: p }))),
  };
}

describe('FilenameIndexService', () => {
  let tmp: string;
  let svc: FilenameIndexService;

  beforeEach(() => {
    (FilenameIndexService as any)._instance = undefined;
    clearMockConfig();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sshlite-idx-'));
    svc = FilenameIndexService.getInstance();
    svc.initialize(makeContext(tmp));
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const FILES = [
    '/home/u/app.ts',
    '/home/u/sub/app.js',
    '/home/u/readme.md',
    '/home/u/sub/util.ts',
  ];

  it('builds a snapshot, persists it gzipped, and reports count + meta', async () => {
    const conn = makeConn('h1', FILES);
    const res = await svc.buildIndex(conn, '/home/u');
    expect('count' in res && res.count).toBe(FILES.length);
    // gz blob written to disk
    const files = fs.readdirSync(path.join(tmp, 'filename-index'));
    expect(files.some((f) => f.endsWith('.gz'))).toBe(true);
    const meta = svc.getSnapshotMeta(conn, '/home/u');
    expect(meta).not.toBeNull();
    expect(meta!.count).toBe(FILES.length);
  });

  it('searches the snapshot LOCALLY by basename (case-insensitive default), no remote call', async () => {
    const conn = makeConn('h1', FILES);
    await svc.buildIndex(conn, '/home/u');
    conn.searchFiles.mockClear();
    const hit = svc.search(conn, '/home/u', 'APP', false, 0);
    expect(hit).not.toBeNull();
    expect(hit!.results.map((r) => r.path).sort()).toEqual(['/home/u/app.ts', '/home/u/sub/app.js']);
    // Purely local — no remote round-trip.
    expect(conn.searchFiles).not.toHaveBeenCalled();
  });

  it('case-sensitive search respects case', async () => {
    const conn = makeConn('h1', ['/home/u/App.ts', '/home/u/app.ts']);
    await svc.buildIndex(conn, '/home/u');
    const hit = svc.search(conn, '/home/u', 'App', true, 0);
    expect(hit!.results.map((r) => r.path)).toEqual(['/home/u/App.ts']);
  });

  it('returns null for a folder that was never indexed (caller falls back to live)', () => {
    const conn = makeConn('h1', FILES);
    expect(svc.search(conn, '/home/u', 'app', false, 0)).toBeNull();
  });

  it('keys snapshots per host, so another host has no snapshot', async () => {
    const a = makeConn('hostA', FILES);
    await svc.buildIndex(a, '/home/u');
    const b = makeConn('hostB', FILES);
    expect(svc.search(b, '/home/u', 'app', false, 0)).toBeNull();
  });

  it('REFUSES to index when the listing reaches the entry cap (never stores a truncated index)', async () => {
    setMockConfig('sshLite.filenameIndexMaxEntries', 4); // cap == result length
    const conn = makeConn('h1', FILES); // returns exactly 4 → treated as possibly truncated
    const res = await svc.buildIndex(conn, '/home/u');
    expect('refused' in res && res.refused).toBe('too-large');
    expect(svc.getSnapshotMeta(conn, '/home/u')).toBeNull();
  });

  it('reports a distinct "aborted" refusal on cancel (so the UI stays silent, not a false "too-large")', async () => {
    const ac = new AbortController();
    ac.abort();
    const conn = makeConn('h1', FILES);
    const res = await svc.buildIndex(conn, '/home/u', ac.signal);
    expect('refused' in res && res.refused).toBe('aborted');
    expect(svc.getSnapshotMeta(conn, '/home/u')).toBeNull();
  });

  it('remove() deletes the snapshot and its blob', async () => {
    const conn = makeConn('h1', FILES);
    await svc.buildIndex(conn, '/home/u');
    await svc.remove(conn, '/home/u');
    expect(svc.getSnapshotMeta(conn, '/home/u')).toBeNull();
    expect(svc.search(conn, '/home/u', 'app', false, 0)).toBeNull();
  });

  it('respects maxResults when searching the snapshot', async () => {
    const conn = makeConn('h1', FILES);
    await svc.buildIndex(conn, '/home/u');
    const hit = svc.search(conn, '/home/u', '', false, 2); // empty matches all basenames
    expect(hit!.results.length).toBe(2);
  });
});
