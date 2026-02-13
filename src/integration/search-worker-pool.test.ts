/**
 * Search Worker Pool Integration Tests
 *
 * Tests the file-level worker pool search flow across SearchPanel + SSHConnection:
 * - Worker pool correctly discovers files via listEntries() and searches via searchFiles()
 * - Directory traversal at multiple levels with file batching
 * - Correct progressive searchBatch messages (totalCount grows, completedCount increases)
 * - Fallback to recursive grep when listEntries fails
 * - System dir exclusion at root / with worker pool
 * - Multi-server parallel search with worker pools
 * - File pattern filtering at listing stage
 * - Byte-based batching for cross-OS command line safety
 * - Max results hit stops workers early
 */

import { SearchPanel } from '../webviews/SearchPanel';
import {
  createMockHostConfig,
  createMockConnection,
} from '../__mocks__/testHelpers';

// --- Mock config management ---
const mockConfigValues: Record<string, unknown> = {};
function setMockConfig(key: string, value: unknown) {
  const [section, ...rest] = key.split('.');
  mockConfigValues[`${section}.${rest.join('.')}`] = value;
}
function clearMockConfig() {
  for (const k of Object.keys(mockConfigValues)) delete mockConfigValues[k];
}

// vscode is auto-mocked by moduleNameMapper → src/__mocks__/vscode.ts
// Override getConfiguration for per-test config values
const vscode = require('vscode');
const origGetConfig = vscode.workspace.getConfiguration;
vscode.workspace.getConfiguration = (section?: string) => {
  const base = origGetConfig(section);
  return {
    ...base,
    get: <T>(key: string, defaultValue?: T): T => {
      const fullKey = section ? `${section}.${key}` : key;
      if (fullKey in mockConfigValues) return mockConfigValues[fullKey] as T;
      return defaultValue as T;
    },
  };
};

// Mock services
jest.mock('../services/ActivityService', () => ({
  ActivityService: {
    getInstance: jest.fn().mockReturnValue({
      startActivity: jest.fn().mockReturnValue('act-1'),
      completeActivity: jest.fn(),
      failActivity: jest.fn(),
      cancelActivity: jest.fn(),
    }),
  },
}));

jest.mock('../services/AuditService', () => ({
  AuditService: {
    getInstance: jest.fn().mockReturnValue({ logAudit: jest.fn(), log: jest.fn() }),
  },
}));

// Helper types
interface ServerSearchEntry {
  id: string;
  hostConfig: ReturnType<typeof createMockHostConfig>;
  checked: boolean;
  connected: boolean;
  disabled: boolean;
  searchPaths: Array<{ path: string; isFile?: boolean; redundantOf?: string }>;
  status?: 'connecting' | 'failed';
  error?: string;
  credential: null;
}

function createServerEntry(overrides: Partial<ServerSearchEntry> & { id: string; hostConfig: ReturnType<typeof createMockHostConfig> }): ServerSearchEntry {
  return {
    checked: true,
    connected: true,
    disabled: false,
    searchPaths: [],
    credential: null,
    ...overrides,
  };
}

describe('Integration: Search Worker Pool', () => {
  let panel: SearchPanel;

  beforeEach(() => {
    (SearchPanel as any).instance = undefined;
    panel = SearchPanel.getInstance();
    clearMockConfig();
  });

  afterEach(() => {
    clearMockConfig();
  });

  function setupMockPanel(): jest.Mock {
    const postMessageSpy = jest.fn();
    (panel as any).panel = { webview: { postMessage: postMessageSpy } };
    return postMessageSpy;
  }

  async function performSearch(query: string, include = '', exclude = '', caseSensitive = false, regex = false, findFiles = false) {
    return (panel as any).performSearch(query, include, exclude, caseSensitive, regex, findFiles);
  }

  describe('directory traversal with file batching', () => {
    it('should discover and search files across 3 directory levels', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      // Level 0: /opt has 2 files and 1 subdir
      // Level 1: /opt/lib has 3 files and 1 subdir
      // Level 2: /opt/lib/deep has 1 file, no subdirs
      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: ['/opt/readme.md', '/opt/config.ts'], dirs: ['/opt/lib'] })
        .mockResolvedValueOnce({ files: ['/opt/lib/a.ts', '/opt/lib/b.ts', '/opt/lib/c.ts'], dirs: ['/opt/lib/deep'] })
        .mockResolvedValueOnce({ files: ['/opt/lib/deep/d.ts'], dirs: [] });

      // searchFiles returns results for each batch
      (conn.searchFiles as jest.Mock)
        .mockResolvedValueOnce([{ path: '/opt/config.ts', line: 5, match: 'hello' }])
        .mockResolvedValueOnce([{ path: '/opt/lib/a.ts', line: 1, match: 'hello' }])
        .mockResolvedValueOnce([{ path: '/opt/lib/deep/d.ts', line: 10, match: 'hello' }]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const postMessageSpy = setupMockPanel();
      await performSearch('hello');

      // Verify listEntries was called for all 3 levels
      expect(conn.listEntries).toHaveBeenCalledTimes(3);
      expect(conn.listEntries).toHaveBeenCalledWith('/opt', undefined);
      expect(conn.listEntries).toHaveBeenCalledWith('/opt/lib', undefined);
      expect(conn.listEntries).toHaveBeenCalledWith('/opt/lib/deep', undefined);

      // Verify searchFiles was called with file arrays (not directory paths)
      expect(conn.searchFiles).toHaveBeenCalledTimes(3);
      expect(conn.searchFiles).toHaveBeenCalledWith(
        expect.arrayContaining(['/opt/config.ts', '/opt/readme.md']),
        'hello',
        expect.any(Object)
      );

      // Verify progressive results
      const batches = postMessageSpy.mock.calls.filter((c: any[]) => c[0].type === 'searchBatch');
      expect(batches.length).toBeGreaterThanOrEqual(6); // 3 dir listings + 3 file searches

      // Final batch should be done
      const lastBatch = batches[batches.length - 1][0];
      expect(lastBatch.done).toBe(true);
      expect(lastBatch.totalResults).toBe(3);
    });

    it('should handle directories with only subdirs (no files)', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      // /root has only subdirs, no files
      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: [], dirs: ['/root/sub1', '/root/sub2'] })
        .mockResolvedValueOnce({ files: ['/root/sub1/a.ts'], dirs: [] })
        .mockResolvedValueOnce({ files: ['/root/sub2/b.ts'], dirs: [] });

      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/root' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      setupMockPanel();
      await performSearch('test');

      // Should traverse all levels
      expect(conn.listEntries).toHaveBeenCalledTimes(3);
      // searchFiles called for files in sub1 and sub2
      expect(conn.searchFiles).toHaveBeenCalledTimes(2);
    });

    it('should handle empty directories gracefully', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/empty' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const postMessageSpy = setupMockPanel();
      await performSearch('test');

      // Should not crash, searchFiles should not be called
      expect(conn.searchFiles).not.toHaveBeenCalled();

      // Should still send a searchBatch (dir listing completed)
      const batches = postMessageSpy.mock.calls.filter((c: any[]) => c[0].type === 'searchBatch');
      expect(batches.length).toBeGreaterThanOrEqual(1);
      expect(batches[batches.length - 1][0].done).toBe(true);
    });
  });

  describe('fallback behavior', () => {
    it('should fall back to recursive grep when listEntries fails', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      (conn.listEntries as jest.Mock).mockRejectedValue(new Error('Permission denied'));
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/opt/found.ts', line: 1, match: 'test' },
      ]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      setupMockPanel();
      await performSearch('test');

      // Should fall back to recursive grep on the directory
      expect(conn.searchFiles).toHaveBeenCalledTimes(1);
      expect(conn.searchFiles).toHaveBeenCalledWith('/opt', 'test', expect.any(Object));
    });

    it('should use single search when parallelProcesses = 1', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 1);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      setupMockPanel();
      await performSearch('test');

      // Should NOT use worker pool
      expect(conn.listEntries).not.toHaveBeenCalled();
      expect(conn.searchFiles).toHaveBeenCalledWith('/opt', 'test', expect.any(Object));
    });
  });

  describe('multi-server parallel worker pools', () => {
    it('should run independent worker pools per server', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host1 = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const host2 = createMockHostConfig({ id: 'svr2', name: 'Server2' });
      const conn1 = createMockConnection({ id: 'svr1', host: host1 });
      const conn2 = createMockConnection({ id: 'svr2', host: host2 });

      // Server 1: /opt → 2 files
      (conn1.listEntries as jest.Mock).mockResolvedValue({
        files: ['/opt/s1-a.ts', '/opt/s1-b.ts'], dirs: [],
      });
      (conn1.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/opt/s1-a.ts', line: 1, match: 'found' },
      ]);

      // Server 2: /home → 3 files
      (conn2.listEntries as jest.Mock).mockResolvedValue({
        files: ['/home/s2-x.ts', '/home/s2-y.ts', '/home/s2-z.ts'], dirs: [],
      });
      (conn2.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/home/s2-x.ts', line: 5, match: 'found' },
      ]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host1, connected: true, searchPaths: [{ path: '/opt' }] }),
        createServerEntry({ id: 'svr2', hostConfig: host2, connected: true, searchPaths: [{ path: '/home' }] }),
      ]);
      panel.setConnectionResolver((id) => {
        if (id === 'svr1') return conn1 as any;
        if (id === 'svr2') return conn2 as any;
        return undefined;
      });

      const postMessageSpy = setupMockPanel();
      await performSearch('found');

      // Both servers should have used worker pools
      expect(conn1.listEntries).toHaveBeenCalled();
      expect(conn2.listEntries).toHaveBeenCalled();

      // Both servers should have searched files
      expect(conn1.searchFiles).toHaveBeenCalled();
      expect(conn2.searchFiles).toHaveBeenCalled();

      // Final batch should show results from both servers
      const batches = postMessageSpy.mock.calls.filter((c: any[]) => c[0].type === 'searchBatch');
      const lastBatch = batches[batches.length - 1][0];
      expect(lastBatch.done).toBe(true);
      expect(lastBatch.totalResults).toBe(2);
    });
  });

  describe('progressive message accuracy', () => {
    it('should track totalCount correctly as directory tree is explored', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 1); // Single worker for predictable ordering

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      // /opt: 2 files, 2 subdirs
      // /opt/a: 1 file, 0 subdirs
      // /opt/b: 1 file, 0 subdirs
      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: ['/opt/f1.ts', '/opt/f2.ts'], dirs: ['/opt/a', '/opt/b'] })
        .mockResolvedValueOnce({ files: ['/opt/a/f3.ts'], dirs: [] })
        .mockResolvedValueOnce({ files: ['/opt/b/f4.ts'], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const postMessageSpy = setupMockPanel();
      await performSearch('test');

      const batches = postMessageSpy.mock.calls
        .filter((c: any[]) => c[0].type === 'searchBatch')
        .map((c: any[]) => ({
          completedCount: c[0].completedCount,
          totalCount: c[0].totalCount,
          done: c[0].done,
          results: c[0].results.length,
        }));

      // Final batch must be done
      expect(batches[batches.length - 1].done).toBe(true);
      expect(batches[batches.length - 1].completedCount).toBe(batches[batches.length - 1].totalCount);

      // completedCount should always be ≤ totalCount
      for (const batch of batches) {
        expect(batch.completedCount).toBeLessThanOrEqual(batch.totalCount);
      }
    });

    it('should deduplicate results across file batches', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      (conn.listEntries as jest.Mock).mockResolvedValue({
        files: ['/opt/a.ts', '/opt/b.ts'], dirs: [],
      });

      // Return same result from both batches (duplicate)
      const sameResult = { path: '/opt/a.ts', line: 1, match: 'dup' };
      (conn.searchFiles as jest.Mock).mockResolvedValue([sameResult]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const postMessageSpy = setupMockPanel();
      await performSearch('dup');

      const batches = postMessageSpy.mock.calls.filter((c: any[]) => c[0].type === 'searchBatch');
      const lastBatch = batches[batches.length - 1][0];

      // totalResults should deduplicate (same path:line from same connection)
      expect(lastBatch.totalResults).toBe(1); // not 2
    });
  });

  describe('file pattern filtering', () => {
    it('should pass simple include pattern to listEntries', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      setupMockPanel();
      await performSearch('test', '*.ts');

      // Simple pattern should be passed to listEntries
      expect(conn.listEntries).toHaveBeenCalledWith('/opt', '*.ts');
    });

    it('should NOT pass brace patterns to listEntries (find doesnt support them)', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      setupMockPanel();
      await performSearch('test', '*.{ts,tsx}');

      // Brace pattern should NOT be passed to listEntries
      expect(conn.listEntries).toHaveBeenCalledWith('/opt', undefined);
    });
  });
});
