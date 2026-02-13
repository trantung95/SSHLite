/**
 * SearchPanel UI Tests — Progressive Message Flow
 *
 * Tests the webview message protocol during search with the file-level worker pool:
 * - searchBatch message structure and field accuracy
 * - totalCount grows dynamically as directories are explored
 * - completedCount monotonically increases
 * - done flag is true only on the final batch
 * - searchState messages for loading/idle transitions
 * - hitLimit flag when max results reached
 * - Activity service integration (start/complete/fail/cancel)
 *
 * These tests simulate realistic directory trees and verify the exact message
 * sequence sent to the webview, ensuring a smooth progressive UI experience.
 */

import { SearchPanel } from './SearchPanel';
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

// Mock services — factories are hoisted above const declarations, so define inline
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
  AuditService: { getInstance: jest.fn().mockReturnValue({ logAudit: jest.fn(), log: jest.fn() }) },
}));

// Retrieve the mock activity service for assertions
import { ActivityService } from '../services/ActivityService';
const mockActivityService = (ActivityService.getInstance as jest.Mock)();

// Helper types (matching SearchPanel's internal types)
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
  return { checked: true, connected: true, disabled: false, searchPaths: [], credential: null, ...overrides };
}

interface SearchBatchMessage {
  type: 'searchBatch';
  results: Array<{ path: string; line?: number; match?: string; connectionId: string }>;
  totalResults: number;
  completedCount: number;
  totalCount: number;
  hitLimit: boolean;
  done: boolean;
  limit: number;
}

describe('SearchPanel UI: Progressive Message Flow', () => {
  let panel: SearchPanel;

  beforeEach(() => {
    (SearchPanel as any).instance = undefined;
    panel = SearchPanel.getInstance();
    jest.clearAllMocks();
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

  function getBatchMessages(spy: jest.Mock): SearchBatchMessage[] {
    return spy.mock.calls
      .filter((c: any[]) => c[0].type === 'searchBatch')
      .map((c: any[]) => c[0]);
  }

  describe('searchBatch message invariants', () => {
    it('completedCount should monotonically increase', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      // Tree: /opt → 2 files + 1 subdir, /opt/sub → 1 file
      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: ['/opt/a.ts', '/opt/b.ts'], dirs: ['/opt/sub'] })
        .mockResolvedValueOnce({ files: ['/opt/sub/c.ts'], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const spy = setupMockPanel();
      await performSearch('test');

      const batches = getBatchMessages(spy);
      expect(batches.length).toBeGreaterThanOrEqual(2);

      // completedCount should never decrease
      for (let i = 1; i < batches.length; i++) {
        expect(batches[i].completedCount).toBeGreaterThanOrEqual(batches[i - 1].completedCount);
      }
    });

    it('totalResults should never decrease', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 1);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: ['/opt/a.ts'], dirs: ['/opt/sub'] })
        .mockResolvedValueOnce({ files: ['/opt/sub/b.ts'], dirs: [] });
      (conn.searchFiles as jest.Mock)
        .mockResolvedValueOnce([{ path: '/opt/a.ts', line: 1, match: 'hit' }])
        .mockResolvedValueOnce([{ path: '/opt/sub/b.ts', line: 2, match: 'hit' }]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const spy = setupMockPanel();
      await performSearch('hit');

      const batches = getBatchMessages(spy);
      for (let i = 1; i < batches.length; i++) {
        expect(batches[i].totalResults).toBeGreaterThanOrEqual(batches[i - 1].totalResults);
      }
    });

    it('done should only be true on the final batch', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: ['/opt/a.ts'], dirs: ['/opt/sub'] })
        .mockResolvedValueOnce({ files: ['/opt/sub/b.ts'], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const spy = setupMockPanel();
      await performSearch('test');

      const batches = getBatchMessages(spy);
      expect(batches.length).toBeGreaterThanOrEqual(2);

      // Only the last batch should have done=true
      for (let i = 0; i < batches.length - 1; i++) {
        expect(batches[i].done).toBe(false);
      }
      expect(batches[batches.length - 1].done).toBe(true);
    });

    it('completedCount should equal totalCount on the final batch', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 1);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      // Deep tree: 3 levels
      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: ['/a/f1.ts'], dirs: ['/a/b'] })
        .mockResolvedValueOnce({ files: ['/a/b/f2.ts'], dirs: ['/a/b/c'] })
        .mockResolvedValueOnce({ files: ['/a/b/c/f3.ts'], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/a' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const spy = setupMockPanel();
      await performSearch('test');

      const batches = getBatchMessages(spy);
      const lastBatch = batches[batches.length - 1];
      expect(lastBatch.completedCount).toBe(lastBatch.totalCount);
      expect(lastBatch.done).toBe(true);
    });
  });

  describe('totalCount accuracy with dynamic growth', () => {
    it('totalCount should grow as directories are explored', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      // /root: 1 file, 3 subdirs → initial totalCount=1, after listing: 1 + (1 file batch + 3 subdirs) = 5
      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: ['/root/f.ts'], dirs: ['/root/a', '/root/b', '/root/c'] })
        .mockResolvedValueOnce({ files: [], dirs: [] }) // /root/a empty
        .mockResolvedValueOnce({ files: [], dirs: [] }) // /root/b empty
        .mockResolvedValueOnce({ files: [], dirs: [] }); // /root/c empty
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/root' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const spy = setupMockPanel();
      await performSearch('test');

      const batches = getBatchMessages(spy);

      // totalCount should grow over time
      const totalCounts = batches.map(b => b.totalCount);
      // The first batch (dir listing of /root) should have totalCount > 1 (added children)
      expect(totalCounts[0]).toBeGreaterThan(1);

      // Final totalCount should match final completedCount
      expect(totalCounts[totalCounts.length - 1]).toBe(batches[batches.length - 1].completedCount);
    });
  });

  describe('activity service integration', () => {
    it('should start and complete activities for file batch searches', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      (conn.listEntries as jest.Mock).mockResolvedValue({
        files: ['/opt/a.ts', '/opt/b.ts'], dirs: [],
      });
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/opt/a.ts', line: 1, match: 'found' },
      ]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      setupMockPanel();
      await performSearch('found');

      // Should have started at least one activity for the file batch search
      expect(mockActivityService.startActivity).toHaveBeenCalled();
      // Should have completed at least one activity
      expect(mockActivityService.completeActivity).toHaveBeenCalled();
    });

    it('should fail activity when searchFiles throws', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      // listEntries fails → fallback grep also fails
      (conn.listEntries as jest.Mock).mockRejectedValue(new Error('no perms'));
      (conn.searchFiles as jest.Mock).mockRejectedValue(new Error('grep failed'));

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      setupMockPanel();
      await performSearch('test');

      // Should have failed the activity
      expect(mockActivityService.failActivity).toHaveBeenCalled();
    });
  });

  describe('hitLimit behavior', () => {
    it('should set hitLimit when results reach maxResults', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 1);
      setMockConfig('sshLite.searchMaxResults', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      (conn.listEntries as jest.Mock).mockResolvedValue({
        files: ['/opt/a.ts', '/opt/b.ts', '/opt/c.ts'], dirs: [],
      });
      // Return 3 results — should be limited by maxResults=2
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/opt/a.ts', line: 1, match: 'hit' },
        { path: '/opt/b.ts', line: 2, match: 'hit' },
        { path: '/opt/c.ts', line: 3, match: 'hit' },
      ]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const spy = setupMockPanel();
      await performSearch('hit');

      const batches = getBatchMessages(spy);
      // At least one batch should indicate hitLimit
      const hitLimitBatches = batches.filter(b => b.hitLimit);
      expect(hitLimitBatches.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('search lifecycle messages', () => {
    it('should send searching message at start and results/done at end', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: ['/opt/a.ts'], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/opt' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const spy = setupMockPanel();
      await performSearch('test');

      const messageTypes = spy.mock.calls.map((c: any[]) => c[0].type);

      // Should start with 'searching' message
      expect(messageTypes).toContain('searching');
      expect(messageTypes.indexOf('searching')).toBeLessThan(messageTypes.indexOf('searchBatch'));

      // Should end with a done batch
      const batches = getBatchMessages(spy);
      expect(batches[batches.length - 1].done).toBe(true);
    });
  });

  describe('realistic directory tree scenario', () => {
    it('should handle a 3-level tree with mixed files and dirs', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 3);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      // Simulate a project structure:
      // /project/
      //   src/ (dir)
      //   docs/ (dir)
      //   package.json (file)
      //   README.md (file)
      //
      // /project/src/
      //   index.ts (file)
      //   utils.ts (file)
      //   components/ (dir)
      //
      // /project/src/components/
      //   Button.tsx (file)
      //   Modal.tsx (file)
      //
      // /project/docs/
      //   guide.md (file)
      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({
          files: ['/project/README.md', '/project/package.json'],
          dirs: ['/project/docs', '/project/src'],
        })
        .mockResolvedValueOnce({
          files: ['/project/docs/guide.md'],
          dirs: [],
        })
        .mockResolvedValueOnce({
          files: ['/project/src/index.ts', '/project/src/utils.ts'],
          dirs: ['/project/src/components'],
        })
        .mockResolvedValueOnce({
          files: ['/project/src/components/Button.tsx', '/project/src/components/Modal.tsx'],
          dirs: [],
        });

      (conn.searchFiles as jest.Mock)
        .mockResolvedValueOnce([{ path: '/project/package.json', line: 3, match: 'import' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { path: '/project/src/index.ts', line: 1, match: 'import' },
          { path: '/project/src/utils.ts', line: 5, match: 'import' },
        ])
        .mockResolvedValueOnce([{ path: '/project/src/components/Button.tsx', line: 2, match: 'import' }]);

      panel.setServerList([createServerEntry({
        id: 'svr1', hostConfig: host, connected: true,
        searchPaths: [{ path: '/project' }],
      })]);
      panel.setConnectionResolver(() => conn as any);

      const spy = setupMockPanel();
      await performSearch('import');

      const batches = getBatchMessages(spy);

      // Verify final state
      const lastBatch = batches[batches.length - 1];
      expect(lastBatch.done).toBe(true);
      expect(lastBatch.totalResults).toBe(4); // 1 + 0 + 2 + 1 = 4 results
      expect(lastBatch.completedCount).toBe(lastBatch.totalCount);

      // Verify listEntries called for all 4 directories
      expect(conn.listEntries).toHaveBeenCalledTimes(4);

      // Verify searchFiles called for all 4 file batches
      expect(conn.searchFiles).toHaveBeenCalledTimes(4);

      // All invariants should hold
      for (let i = 1; i < batches.length; i++) {
        expect(batches[i].completedCount).toBeGreaterThanOrEqual(batches[i - 1].completedCount);
        expect(batches[i].totalResults).toBeGreaterThanOrEqual(batches[i - 1].totalResults);
      }
    });
  });
});
