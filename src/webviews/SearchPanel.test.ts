/**
 * SearchPanel tests
 *
 * Tests the search panel logic including:
 * - Scope management (add, deduplicate, remove, clear)
 * - Search execution (parallel, deduplication, hit limit)
 * - Cancellation via AbortController
 * - Activity tracking per scope
 * - Error handling (failed scopes continue)
 *
 * Since SearchPanel is a singleton tightly coupled to VS Code webview,
 * we test via the public API methods and behavioral verification.
 */

import { SearchPanel, SearchScope, ServerSearchEntry, SearchPath } from './SearchPanel';
import { window, setMockConfig, clearMockConfig, createMockExtensionContext } from '../__mocks__/vscode';
import { createMockConnection, createMockHostConfig, createMockCredential } from '../__mocks__/testHelpers';

// Mock ActivityService
jest.mock('../services/ActivityService', () => ({
  ActivityService: {
    getInstance: jest.fn().mockReturnValue({
      startActivity: jest.fn().mockReturnValue('activity-1'),
      completeActivity: jest.fn(),
      failActivity: jest.fn(),
      cancelActivity: jest.fn(),
    }),
  },
}));

function resetSearchPanel(): SearchPanel {
  (SearchPanel as any).instance = undefined;
  return SearchPanel.getInstance();
}

describe('SearchPanel', () => {
  let panel: SearchPanel;

  beforeEach(() => {
    jest.clearAllMocks();
    panel = resetSearchPanel();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const a = SearchPanel.getInstance();
      const b = SearchPanel.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('scope management', () => {
    it('should add a scope', () => {
      const conn = createMockConnection();
      panel.addScope('/home/user', conn as any);

      const scopes = (panel as any).searchScopes as SearchScope[];
      expect(scopes).toHaveLength(1);
      expect(scopes[0].path).toBe('/home/user');
      expect(scopes[0].connection).toBe(conn);
    });

    it('should generate correct scope ID', () => {
      const conn = createMockConnection();
      panel.addScope('/var/log', conn as any);

      const scopes = (panel as any).searchScopes as SearchScope[];
      expect(scopes[0].id).toBe(`${conn.id}:/var/log`);
    });

    it('should generate correct displayName', () => {
      const conn = createMockConnection();
      panel.addScope('/var/log', conn as any);

      const scopes = (panel as any).searchScopes as SearchScope[];
      expect(scopes[0].displayName).toBe(`${conn.host.name}: /var/log`);
    });

    it('should deduplicate scopes with same connection and path', () => {
      const conn = createMockConnection();
      panel.addScope('/home/user', conn as any);
      panel.addScope('/home/user', conn as any); // Duplicate

      const scopes = (panel as any).searchScopes as SearchScope[];
      expect(scopes).toHaveLength(1);
    });

    it('should allow same path from different connections', () => {
      const conn1 = createMockConnection({ id: 'conn1' });
      const conn2 = createMockConnection({ id: 'conn2' });
      panel.addScope('/home/user', conn1 as any);
      panel.addScope('/home/user', conn2 as any);

      const scopes = (panel as any).searchScopes as SearchScope[];
      expect(scopes).toHaveLength(2);
    });

    it('should allow different paths from same connection', () => {
      const conn = createMockConnection();
      panel.addScope('/home/user', conn as any);
      panel.addScope('/var/log', conn as any);

      const scopes = (panel as any).searchScopes as SearchScope[];
      expect(scopes).toHaveLength(2);
    });

    it('should support file scope', () => {
      const conn = createMockConnection();
      panel.addScope('/etc/nginx/nginx.conf', conn as any, true);

      const scopes = (panel as any).searchScopes as SearchScope[];
      expect(scopes[0].isFile).toBe(true);
    });

    it('should remove scope by index', () => {
      const conn = createMockConnection();
      panel.addScope('/path1', conn as any);
      panel.addScope('/path2', conn as any);
      panel.addScope('/path3', conn as any);

      panel.removeScope(1); // Remove /path2

      const scopes = (panel as any).searchScopes as SearchScope[];
      expect(scopes).toHaveLength(2);
      expect(scopes[0].path).toBe('/path1');
      expect(scopes[1].path).toBe('/path3');
    });

    it('should not remove for out-of-bounds index', () => {
      const conn = createMockConnection();
      panel.addScope('/path1', conn as any);

      panel.removeScope(5);
      panel.removeScope(-1);

      const scopes = (panel as any).searchScopes as SearchScope[];
      expect(scopes).toHaveLength(1);
    });

    it('should clear all scopes', () => {
      const conn = createMockConnection();
      panel.addScope('/path1', conn as any);
      panel.addScope('/path2', conn as any);

      panel.clearScopes();

      const scopes = (panel as any).searchScopes as SearchScope[];
      expect(scopes).toHaveLength(0);
    });
  });

  describe('cancelSearch', () => {
    it('should abort active search', () => {
      // Set up an active abort controller
      const controller = new AbortController();
      (panel as any).searchAbortController = controller;
      (panel as any).isSearching = true;

      const abortSpy = jest.spyOn(controller, 'abort');

      panel.cancelSearch();

      expect(abortSpy).toHaveBeenCalled();
      expect((panel as any).isSearching).toBe(false);
    });

    it('should null the abort controller', () => {
      (panel as any).searchAbortController = new AbortController();
      (panel as any).isSearching = true;

      panel.cancelSearch();

      expect((panel as any).searchAbortController).toBeNull();
    });

    it('should show cancel status bar message', () => {
      (panel as any).isSearching = true;
      (panel as any).searchAbortController = new AbortController();

      panel.cancelSearch();

      expect(window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('cancelled'),
        expect.any(Number)
      );
    });

    it('should do nothing if no search is active', () => {
      (panel as any).searchAbortController = null;
      (panel as any).isSearching = false;

      // Should not throw
      panel.cancelSearch();
    });
  });

  describe('performSearch (via private method)', () => {
    const performSearch = async (
      panelInst: SearchPanel,
      query: string,
      include = '',
      exclude = '',
      caseSensitive = false,
      regex = false
    ) => {
      return (panelInst as any).performSearch(query, include, exclude, caseSensitive, regex);
    };

    it('should return empty for empty query', async () => {
      const conn = createMockConnection();
      panel.addScope('/home', conn as any);

      await performSearch(panel, '');

      // No searchFiles call since query was empty
      expect(conn.searchFiles).not.toHaveBeenCalled();
    });

    it('should return empty for no scopes', async () => {
      // No scopes added
      await performSearch(panel, 'test');
      // Nothing to search
    });

    it('should search each scope in parallel', async () => {
      const conn1 = createMockConnection({ id: 'conn1' });
      const conn2 = createMockConnection({ id: 'conn2' });
      (conn1.searchFiles as jest.Mock).mockResolvedValue([]);
      (conn2.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.addScope('/path1', conn1 as any);
      panel.addScope('/path2', conn2 as any);

      await performSearch(panel, 'hello');

      expect(conn1.searchFiles).toHaveBeenCalled();
      expect(conn2.searchFiles).toHaveBeenCalled();
    });

    it('should pass search options to searchFiles', async () => {
      const conn = createMockConnection();
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.addScope('/home', conn as any);

      await performSearch(panel, 'pattern', '*.ts', '*.test.ts', true, true);

      expect(conn.searchFiles).toHaveBeenCalledWith(
        '/home',
        'pattern',
        expect.objectContaining({
          searchContent: true,
          caseSensitive: true,
          regex: true,
          filePattern: '*.ts',
          excludePattern: '*.test.ts',
        })
      );
    });

    it('should cancel previous search when starting new one', async () => {
      const conn = createMockConnection();
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.addScope('/home', conn as any);

      // Start first search (creates an abort controller)
      const search1 = performSearch(panel, 'first');
      const controller1 = (panel as any).searchAbortController;

      // Start second search (should abort the first)
      const search2 = performSearch(panel, 'second');

      await search1;
      await search2;

      // First controller should have been aborted
      expect(controller1.signal.aborted).toBe(true);
    });

    it('should track activity per scope', async () => {
      const { ActivityService } = require('../services/ActivityService');
      const activityService = ActivityService.getInstance();

      const conn = createMockConnection();
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.addScope('/path1', conn as any);
      panel.addScope('/path2', conn as any);

      await performSearch(panel, 'test');

      // Two scopes = two activity starts
      // (Due to deduplication: same conn, but different paths → 2 scopes)
      expect(activityService.startActivity).toHaveBeenCalledTimes(2);
    });

    it('should complete activity on success', async () => {
      const { ActivityService } = require('../services/ActivityService');
      const activityService = ActivityService.getInstance();

      const conn = createMockConnection();
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/file.ts', line: 1, preview: 'test' },
      ]);

      panel.addScope('/home', conn as any);

      await performSearch(panel, 'test');

      expect(activityService.completeActivity).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('1 results')
      );
    });

    it('should fail activity on error', async () => {
      const { ActivityService } = require('../services/ActivityService');
      const activityService = ActivityService.getInstance();

      const conn = createMockConnection();
      (conn.searchFiles as jest.Mock).mockRejectedValue(new Error('Connection lost'));

      panel.addScope('/home', conn as any);

      await performSearch(panel, 'test');

      expect(activityService.failActivity).toHaveBeenCalledWith(
        expect.any(String),
        'Connection lost'
      );
    });

    it('should continue searching other scopes when one fails', async () => {
      const conn1 = createMockConnection({ id: 'conn1' });
      const conn2 = createMockConnection({ id: 'conn2' });
      (conn1.searchFiles as jest.Mock).mockRejectedValue(new Error('Timeout'));
      (conn2.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/found.ts', line: 1 },
      ]);

      panel.addScope('/path1', conn1 as any);
      panel.addScope('/path2', conn2 as any);

      await performSearch(panel, 'test');

      // conn2 should still have been called even though conn1 failed
      expect(conn2.searchFiles).toHaveBeenCalled();
    });

    it('should use connection resolver if set', async () => {
      const conn = createMockConnection({ id: 'conn1' });
      const freshConn = createMockConnection({ id: 'conn1' });
      (freshConn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setConnectionResolver((id) => {
        if (id === 'conn1') return freshConn as any;
        return undefined;
      });

      panel.addScope('/home', conn as any);

      await performSearch(panel, 'test');

      // Should use fresh connection, not the original
      expect(freshConn.searchFiles).toHaveBeenCalled();
      expect(conn.searchFiles).not.toHaveBeenCalled();
    });

    it('should pass signal to searchFiles', async () => {
      const conn = createMockConnection();
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.addScope('/home', conn as any);

      await performSearch(panel, 'test');

      expect(conn.searchFiles).toHaveBeenCalledWith(
        '/home',
        'test',
        expect.objectContaining({
          signal: expect.any(AbortSignal),
        })
      );
    });
  });

  describe('setOpenFileCallback', () => {
    it('should store callback', () => {
      const callback = jest.fn();
      panel.setOpenFileCallback(callback);
      expect((panel as any).openFileCallback).toBe(callback);
    });
  });

  describe('setConnectionResolver', () => {
    it('should store resolver', () => {
      const resolver = jest.fn();
      panel.setConnectionResolver(resolver);
      expect((panel as any).connectionResolver).toBe(resolver);
    });
  });

  // ===== New cross-server search tests =====

  function createServerEntry(overrides: Partial<ServerSearchEntry> = {}): ServerSearchEntry {
    const hostConfig = createMockHostConfig(overrides.hostConfig);
    return {
      id: hostConfig.id,
      hostConfig,
      credential: createMockCredential(),
      connected: true,
      checked: false,
      disabled: false,
      searchPaths: [],
      ...overrides,
    };
  }

  describe('setServerList', () => {
    it('should populate server list', () => {
      const entries = [
        createServerEntry({ id: 'svr1', hostConfig: createMockHostConfig({ id: 'svr1', name: 'Server1' }) }),
        createServerEntry({ id: 'svr2', hostConfig: createMockHostConfig({ id: 'svr2', name: 'Server2' }) }),
      ];

      panel.setServerList(entries);

      expect((panel as any).serverList).toHaveLength(2);
    });

    it('should start with no paths', () => {
      const entries = [
        createServerEntry({ id: 'svr1' }),
      ];

      panel.setServerList(entries);

      expect((panel as any).serverList[0].searchPaths).toHaveLength(0);
    });
  });

  describe('addScope with serverList', () => {
    it('should add path to correct server via addScope', () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host }),
      ]);

      panel.addScope('/var/log', conn as any);

      const server = (panel as any).serverList[0] as ServerSearchEntry;
      expect(server.searchPaths).toHaveLength(1);
      expect(server.searchPaths[0].path).toBe('/var/log');
    });

    it('should auto-check server when addScope called', () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, checked: false }),
      ]);

      panel.addScope('/var/log', conn as any);

      expect((panel as any).serverList[0].checked).toBe(true);
    });

    it('should deduplicate paths on same server', () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host }),
      ]);

      panel.addScope('/var/log', conn as any);
      panel.addScope('/var/log', conn as any); // duplicate

      expect((panel as any).serverList[0].searchPaths).toHaveLength(1);
    });

    it('should not uncheck other servers (additive)', () => {
      const host1 = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const host2 = createMockHostConfig({ id: 'svr2', name: 'Server2' });
      const conn1 = createMockConnection({ id: 'svr1', host: host1 });
      const conn2 = createMockConnection({ id: 'svr2', host: host2 });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host1 }),
        createServerEntry({ id: 'svr2', hostConfig: host2 }),
      ]);

      panel.addScope('/opt', conn1 as any);
      panel.addScope('/home', conn2 as any);

      // Both should be checked
      expect((panel as any).serverList[0].checked).toBe(true);
      expect((panel as any).serverList[1].checked).toBe(true);
    });
  });

  describe('removeServerPath', () => {
    it('should remove specific path from server', () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host }),
      ]);
      panel.addScope('/path1', conn as any);
      panel.addScope('/path2', conn as any);

      panel.removeServerPath('svr1', 0);

      const paths = (panel as any).serverList[0].searchPaths as SearchPath[];
      expect(paths).toHaveLength(1);
      expect(paths[0].path).toBe('/path2');
    });

    it('should uncheck server when last path removed', () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host }),
      ]);
      panel.addScope('/only-path', conn as any);
      expect((panel as any).serverList[0].checked).toBe(true);

      panel.removeServerPath('svr1', 0);

      expect((panel as any).serverList[0].checked).toBe(false);
      expect((panel as any).serverList[0].searchPaths).toHaveLength(0);
    });
  });

  describe('clearScopes with serverList', () => {
    it('should clear all paths and uncheck all servers', () => {
      const host1 = createMockHostConfig({ id: 'svr1' });
      const host2 = createMockHostConfig({ id: 'svr2' });
      const conn1 = createMockConnection({ id: 'svr1', host: host1 });
      const conn2 = createMockConnection({ id: 'svr2', host: host2 });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host1 }),
        createServerEntry({ id: 'svr2', hostConfig: host2 }),
      ]);
      panel.addScope('/opt', conn1 as any);
      panel.addScope('/home', conn2 as any);

      panel.clearScopes();

      const sl = (panel as any).serverList as ServerSearchEntry[];
      expect(sl[0].checked).toBe(false);
      expect(sl[0].searchPaths).toHaveLength(0);
      expect(sl[1].checked).toBe(false);
      expect(sl[1].searchPaths).toHaveLength(0);
    });
  });

  describe('toggleServer', () => {
    it('should toggle server checked state', () => {
      panel.setServerList([
        createServerEntry({ id: 'svr1' }),
      ]);

      panel.toggleServer('svr1', true);
      expect((panel as any).serverList[0].checked).toBe(true);

      panel.toggleServer('svr1', false);
      expect((panel as any).serverList[0].checked).toBe(false);
    });

    it('should not toggle disabled server', () => {
      panel.setServerList([
        createServerEntry({ id: 'svr1', disabled: true }),
      ]);

      panel.toggleServer('svr1', true);
      expect((panel as any).serverList[0].checked).toBe(false);
    });
  });

  describe('redundancy detection', () => {
    it('should mark child path as redundant on same server', () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host }),
      ]);
      panel.addScope('/opt', conn as any);
      panel.addScope('/opt/inet/DB', conn as any);

      const paths = (panel as any).serverList[0].searchPaths as SearchPath[];
      expect(paths[0].redundantOf).toBeUndefined(); // /opt is parent
      expect(paths[1].redundantOf).toBe('/opt'); // /opt/inet/DB is child
    });

    it('should detect cross-user overlap (exact match)', () => {
      const host1 = createMockHostConfig({ id: 'svr:22:root', host: 'svr', username: 'root', name: 'svr' });
      const host2 = createMockHostConfig({ id: 'svr:22:tung', host: 'svr', username: 'tung', name: 'svr' });
      const conn1 = createMockConnection({ id: 'svr:22:root', host: host1 });
      const conn2 = createMockConnection({ id: 'svr:22:tung', host: host2 });

      panel.setServerList([
        createServerEntry({ id: 'svr:22:root', hostConfig: host1 }),
        createServerEntry({ id: 'svr:22:tung', hostConfig: host2 }),
      ]);
      panel.addScope('/opt', conn1 as any);
      panel.addScope('/opt', conn2 as any);

      const paths2 = (panel as any).serverList[1].searchPaths as SearchPath[];
      expect(paths2[0].overlapWarning).toContain('root');
    });

    it('should detect cross-user overlap (parent/child)', () => {
      const host1 = createMockHostConfig({ id: 'svr:22:root', host: 'svr', username: 'root', name: 'svr' });
      const host2 = createMockHostConfig({ id: 'svr:22:tung', host: 'svr', username: 'tung', name: 'svr' });
      const conn1 = createMockConnection({ id: 'svr:22:root', host: host1 });
      const conn2 = createMockConnection({ id: 'svr:22:tung', host: host2 });

      panel.setServerList([
        createServerEntry({ id: 'svr:22:root', hostConfig: host1 }),
        createServerEntry({ id: 'svr:22:tung', hostConfig: host2 }),
      ]);
      panel.addScope('/opt', conn1 as any);
      panel.addScope('/opt/docker', conn2 as any);

      const paths2 = (panel as any).serverList[1].searchPaths as SearchPath[];
      expect(paths2[0].overlapWarning).toContain('root');
    });

    it('should not warn for non-overlapping paths on different users', () => {
      const host1 = createMockHostConfig({ id: 'svr:22:root', host: 'svr', username: 'root', name: 'svr' });
      const host2 = createMockHostConfig({ id: 'svr:22:tung', host: 'svr', username: 'tung', name: 'svr' });
      const conn1 = createMockConnection({ id: 'svr:22:root', host: host1 });
      const conn2 = createMockConnection({ id: 'svr:22:tung', host: host2 });

      panel.setServerList([
        createServerEntry({ id: 'svr:22:root', hostConfig: host1 }),
        createServerEntry({ id: 'svr:22:tung', hostConfig: host2 }),
      ]);
      panel.addScope('/opt', conn1 as any);
      panel.addScope('/var/log', conn2 as any);

      const paths2 = (panel as any).serverList[1].searchPaths as SearchPath[];
      expect(paths2[0].overlapWarning).toBeUndefined();
    });

    it('should mark child of root / as redundant', () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host }),
      ]);
      panel.addScope('/', conn as any);
      panel.addScope('/home/user', conn as any);

      const paths = (panel as any).serverList[0].searchPaths as SearchPath[];
      expect(paths[0].path).toBe('/');
      expect(paths[0].redundantOf).toBeUndefined(); // / is the parent
      expect(paths[1].path).toBe('/home/user');
      expect(paths[1].redundantOf).toBe('/'); // child of root
    });

    it('should mark deep child of root / as redundant', () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host }),
      ]);
      panel.addScope('/', conn as any);
      panel.addScope('/var/log/syslog/archive', conn as any);

      const paths = (panel as any).serverList[0].searchPaths as SearchPath[];
      expect(paths[1].redundantOf).toBe('/');
    });

    it('should detect cross-user overlap when one user has root /', () => {
      const host1 = createMockHostConfig({ id: 'svr:22:root', host: 'svr', username: 'root', name: 'svr' });
      const host2 = createMockHostConfig({ id: 'svr:22:tung', host: 'svr', username: 'tung', name: 'svr' });
      const conn1 = createMockConnection({ id: 'svr:22:root', host: host1 });
      const conn2 = createMockConnection({ id: 'svr:22:tung', host: host2 });

      panel.setServerList([
        createServerEntry({ id: 'svr:22:root', hostConfig: host1 }),
        createServerEntry({ id: 'svr:22:tung', hostConfig: host2 }),
      ]);
      panel.addScope('/', conn1 as any);
      panel.addScope('/var/log', conn2 as any);

      const paths2 = (panel as any).serverList[1].searchPaths as SearchPath[];
      expect(paths2[0].overlapWarning).toContain('root');
    });

    it('should auto-insert / when adding path to checked server with empty paths', () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host }),
      ]);
      // First check the server (no paths)
      panel.toggleServer('svr1', true);
      expect((panel as any).serverList[0].searchPaths).toHaveLength(0);

      // Now add a child path — should auto-insert /
      panel.addScope('/home/user', conn as any);

      const paths = (panel as any).serverList[0].searchPaths as SearchPath[];
      expect(paths).toHaveLength(2);
      expect(paths[0].path).toBe('/');
      expect(paths[1].path).toBe('/home/user');
      expect(paths[1].redundantOf).toBe('/');
    });

    it('should NOT auto-insert / when adding / explicitly to checked server', () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host }),
      ]);
      panel.toggleServer('svr1', true);
      panel.addScope('/', conn as any);

      const paths = (panel as any).serverList[0].searchPaths as SearchPath[];
      expect(paths).toHaveLength(1);
      expect(paths[0].path).toBe('/');
    });
  });

  describe('sort order', () => {
    it('should default to checked sort order', () => {
      expect((panel as any).sortOrder).toBe('checked');
    });

    it('should sort checked servers first in checked mode', () => {
      const host1 = createMockHostConfig({ id: 'svr1', name: 'Bravo' });
      const host2 = createMockHostConfig({ id: 'svr2', name: 'Alpha' });
      const conn2 = createMockConnection({ id: 'svr2', host: host2 });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host1 }),
        createServerEntry({ id: 'svr2', hostConfig: host2 }),
      ]);
      panel.addScope('/opt', conn2 as any); // Only svr2 has paths

      const sorted = (panel as any).getSortedServerList() as ServerSearchEntry[];
      expect(sorted[0].id).toBe('svr2'); // Alpha (checked with paths) first
      expect(sorted[1].id).toBe('svr1'); // Bravo (unchecked) second
    });

    it('should sort alphabetically in name mode', () => {
      const host1 = createMockHostConfig({ id: 'svr1', name: 'Bravo' });
      const host2 = createMockHostConfig({ id: 'svr2', name: 'Alpha' });
      const conn2 = createMockConnection({ id: 'svr2', host: host2 });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host1 }),
        createServerEntry({ id: 'svr2', hostConfig: host2 }),
      ]);
      panel.addScope('/opt', conn2 as any);

      (panel as any).sortOrder = 'name';
      const sorted = (panel as any).getSortedServerList() as ServerSearchEntry[];
      expect(sorted[0].id).toBe('svr2'); // Alpha first
      expect(sorted[1].id).toBe('svr1'); // Bravo second
    });
  });

  describe('serverList-based performSearch', () => {
    const performSearchWithServerList = async (
      panelInst: SearchPanel,
      query: string,
      include = '',
      exclude = '',
      caseSensitive = false,
      regex = false,
      findFiles = false
    ) => {
      return (panelInst as any).performSearch(query, include, exclude, caseSensitive, regex, findFiles);
    };

    // Disable parallel search for basic server-list tests (tested separately in 'parallel search')
    beforeEach(() => {
      setMockConfig('sshLite.searchParallelProcesses', 1);
    });

    afterEach(() => {
      clearMockConfig();
    });

    it('should search checked servers with paths', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver((id) => id === 'svr1' ? conn as any : undefined);
      panel.addScope('/opt', conn as any);

      await performSearchWithServerList(panel, 'hello');

      expect(conn.searchFiles).toHaveBeenCalledWith('/opt', 'hello', expect.any(Object));
    });

    it('should skip redundant child paths', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver((id) => id === 'svr1' ? conn as any : undefined);
      panel.addScope('/opt', conn as any);
      panel.addScope('/opt/inet/DB', conn as any);

      await performSearchWithServerList(panel, 'test');

      // Only /opt should be searched (not /opt/inet/DB which is redundant)
      expect(conn.searchFiles).toHaveBeenCalledTimes(1);
      expect(conn.searchFiles).toHaveBeenCalledWith('/opt', 'test', expect.any(Object));
    });

    it('should pass findFiles mode to searchFiles', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver((id) => id === 'svr1' ? conn as any : undefined);
      panel.addScope('/opt', conn as any);

      await performSearchWithServerList(panel, 'test.ts', '', '', false, false, true);

      expect(conn.searchFiles).toHaveBeenCalledWith(
        '/opt',
        'test.ts',
        expect.objectContaining({ searchContent: false })
      );
    });

    it('should auto-connect and search disconnected servers', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const cred = createMockCredential();
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/found.ts', line: 1, match: 'hello' },
      ]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: false, credential: cred }),
      ]);

      // Add path and check server
      panel.addScope('/opt', conn as any);

      // Set auto-connect callback
      panel.setAutoConnectCallback(async () => conn as any);

      // Set connection resolver to return connection after auto-connect
      panel.setConnectionResolver((id) => id === 'svr1' ? conn as any : undefined);

      await performSearchWithServerList(panel, 'hello');

      expect(conn.searchFiles).toHaveBeenCalled();
    });

    it('should auto-disconnect servers with no results', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const cred = createMockCredential();
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]); // zero results

      const disconnectCallback = jest.fn().mockResolvedValue(undefined);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: false, credential: cred }),
      ]);
      panel.addScope('/opt', conn as any);
      panel.setAutoConnectCallback(async () => conn as any);
      panel.setAutoDisconnectCallback(disconnectCallback);
      // Connection resolver returns undefined (server not connected yet)
      // This forces the auto-connect path
      panel.setConnectionResolver(() => undefined);

      await performSearchWithServerList(panel, 'noresults');

      // Should have auto-disconnected since zero results
      expect(disconnectCallback).toHaveBeenCalledWith('svr1');
    });

    it('should NOT auto-disconnect servers with results', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const cred = createMockCredential();
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/found.ts', line: 1, match: 'test' },
      ]);

      const disconnectCallback = jest.fn().mockResolvedValue(undefined);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: false, credential: cred }),
      ]);
      panel.addScope('/opt', conn as any);
      panel.setAutoConnectCallback(async () => conn as any);
      panel.setAutoDisconnectCallback(disconnectCallback);
      // Connection resolver returns undefined (forces auto-connect path)
      panel.setConnectionResolver(() => undefined);

      await performSearchWithServerList(panel, 'test');

      // Should NOT disconnect because server had results
      expect(disconnectCallback).not.toHaveBeenCalled();
    });
  });

  describe('hasScopes with serverList', () => {
    it('should return true when server is checked with paths', () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host }),
      ]);
      panel.addScope('/opt', conn as any);

      expect(panel.hasScopes()).toBe(true);
    });

    it('should return true when server is checked without explicit paths (defaults to /)', () => {
      panel.setServerList([
        createServerEntry({ id: 'svr1', checked: true }),
      ]);

      // Checked servers count as having scopes (default to / search)
      expect(panel.hasScopes()).toBe(true);
    });

    it('should return false when no servers are checked', () => {
      panel.setServerList([
        createServerEntry({ id: 'svr1', checked: false }),
      ]);

      expect(panel.hasScopes()).toBe(false);
    });
  });

  describe('updateServerConnection', () => {
    it('should update connection state', () => {
      panel.setServerList([
        createServerEntry({ id: 'svr1', connected: false }),
      ]);

      panel.updateServerConnection('svr1', true);

      expect((panel as any).serverList[0].connected).toBe(true);
    });

    it('should clear error state when connected', () => {
      panel.setServerList([
        createServerEntry({ id: 'svr1', connected: false, status: 'failed', error: 'Auth failed' }),
      ]);

      panel.updateServerConnection('svr1', true);

      expect((panel as any).serverList[0].status).toBeUndefined();
      expect((panel as any).serverList[0].error).toBeUndefined();
    });
  });

  describe('callback setters', () => {
    it('should store autoConnectCallback', () => {
      const cb = jest.fn();
      panel.setAutoConnectCallback(cb);
      expect((panel as any).autoConnectCallback).toBe(cb);
    });

    it('should store autoDisconnectCallback', () => {
      const cb = jest.fn();
      panel.setAutoDisconnectCallback(cb);
      expect((panel as any).autoDisconnectCallback).toBe(cb);
    });
  });

  describe('progressive search results (searchBatch)', () => {
    const performSearchWithServerList = async (
      panelInst: SearchPanel,
      query: string,
      include = '',
      exclude = '',
      caseSensitive = false,
      regex = false,
      findFiles = false
    ) => {
      return (panelInst as any).performSearch(query, include, exclude, caseSensitive, regex, findFiles);
    };

    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    beforeEach(() => {
      // Disable parallel search for progressive results tests (test separately)
      setMockConfig('sshLite.searchParallelProcesses', 1);
    });

    afterEach(() => {
      clearMockConfig();
    });

    it('should send searchBatch messages per server', async () => {
      const host1 = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const host2 = createMockHostConfig({ id: 'svr2', name: 'Server2' });
      const conn1 = createMockConnection({ id: 'svr1', host: host1 });
      const conn2 = createMockConnection({ id: 'svr2', host: host2 });
      (conn1.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/a.ts', line: 1, match: 'hello' },
      ]);
      (conn2.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/b.ts', line: 2, match: 'hello' },
      ]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host1, connected: true }),
        createServerEntry({ id: 'svr2', hostConfig: host2, connected: true }),
      ]);
      panel.setConnectionResolver((id) => {
        if (id === 'svr1') return conn1 as any;
        if (id === 'svr2') return conn2 as any;
        return undefined;
      });
      panel.addScope('/opt', conn1 as any);
      panel.addScope('/var', conn2 as any);

      const postMessageSpy = setupMockPanel(panel);

      await performSearchWithServerList(panel, 'hello');

      const batchMessages = postMessageSpy.mock.calls
        .filter((call: any[]) => call[0].type === 'searchBatch');
      expect(batchMessages.length).toBe(2);
    });

    it('should set done: true only on the last batch', async () => {
      const host1 = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const host2 = createMockHostConfig({ id: 'svr2', name: 'Server2' });
      const conn1 = createMockConnection({ id: 'svr1', host: host1 });
      const conn2 = createMockConnection({ id: 'svr2', host: host2 });
      (conn1.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/a.ts', line: 1, match: 'test' },
      ]);
      (conn2.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/b.ts', line: 2, match: 'test' },
      ]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host1, connected: true }),
        createServerEntry({ id: 'svr2', hostConfig: host2, connected: true }),
      ]);
      panel.setConnectionResolver((id) => {
        if (id === 'svr1') return conn1 as any;
        if (id === 'svr2') return conn2 as any;
        return undefined;
      });
      panel.addScope('/opt', conn1 as any);
      panel.addScope('/var', conn2 as any);

      const postMessageSpy = setupMockPanel(panel);

      await performSearchWithServerList(panel, 'test');

      const batchMessages = postMessageSpy.mock.calls
        .filter((call: any[]) => call[0].type === 'searchBatch');

      // At least one batch should have done: false, and the last should have done: true
      const doneMessages = batchMessages.filter((call: any[]) => call[0].done === true);
      const notDoneMessages = batchMessages.filter((call: any[]) => call[0].done === false);
      expect(doneMessages.length).toBe(1);
      expect(notDoneMessages.length).toBe(1);
    });

    it('should deduplicate results across batches via globalSeen', async () => {
      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      // Same result returned by search — both paths produce duplicate
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/same.ts', line: 10, match: 'dup' },
      ]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);
      panel.addScope('/var', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      await performSearchWithServerList(panel, 'dup');

      const batchMessages = postMessageSpy.mock.calls
        .filter((call: any[]) => call[0].type === 'searchBatch');

      // Both paths are on same server — should get 2 batch messages
      expect(batchMessages.length).toBe(2);

      // But total unique results should be 1 (deduplicated)
      const lastBatch = batchMessages[batchMessages.length - 1][0];
      expect(lastBatch.totalResults).toBe(1);
    });

    it('should send searching message with scopeServers', async () => {
      const host = createMockHostConfig({ id: 'svr1', name: 'Server1', username: 'root' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      await performSearchWithServerList(panel, 'test');

      const searchingMsg = postMessageSpy.mock.calls
        .find((call: any[]) => call[0].type === 'searching');
      expect(searchingMsg).toBeDefined();
      expect(searchingMsg![0].scopeServers).toBeDefined();
      expect(searchingMsg![0].scopeServers[0].id).toBe('svr1');
    });

    it('should include completedCount and totalCount in each batch', async () => {
      const host1 = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const host2 = createMockHostConfig({ id: 'svr2', name: 'Server2' });
      const conn1 = createMockConnection({ id: 'svr1', host: host1 });
      const conn2 = createMockConnection({ id: 'svr2', host: host2 });
      (conn1.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/a.ts', line: 1, match: 'x' },
      ]);
      (conn2.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/b.ts', line: 2, match: 'x' },
      ]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host1, connected: true }),
        createServerEntry({ id: 'svr2', hostConfig: host2, connected: true }),
      ]);
      panel.setConnectionResolver((id) => {
        if (id === 'svr1') return conn1 as any;
        if (id === 'svr2') return conn2 as any;
        return undefined;
      });
      panel.addScope('/opt', conn1 as any);
      panel.addScope('/var', conn2 as any);

      const postMessageSpy = setupMockPanel(panel);

      await performSearchWithServerList(panel, 'x');

      const batchMessages = postMessageSpy.mock.calls
        .filter((call: any[]) => call[0].type === 'searchBatch');

      // All batches should have totalCount = 2
      for (const msg of batchMessages) {
        expect(msg[0].totalCount).toBe(2);
      }

      // Last batch: completedCount should equal totalCount
      const lastBatch = batchMessages[batchMessages.length - 1][0];
      expect(lastBatch.completedCount).toBe(lastBatch.totalCount);
    });

    it('should send searchBatch with empty results on failed search', async () => {
      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockRejectedValue(new Error('Connection lost'));

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      await performSearchWithServerList(panel, 'test');

      const batchMessages = postMessageSpy.mock.calls
        .filter((call: any[]) => call[0].type === 'searchBatch');
      expect(batchMessages.length).toBe(1);
      expect(batchMessages[0][0].results).toEqual([]);
      expect(batchMessages[0][0].done).toBe(true);
    });
  });

  describe('parallel search', () => {
    const performSearchWithServerList = async (
      panelInst: SearchPanel,
      query: string,
      include = '',
      exclude = '',
      caseSensitive = false,
      regex = false,
      findFiles = false
    ) => {
      return (panelInst as any).performSearch(query, include, exclude, caseSensitive, regex, findFiles);
    };

    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    afterEach(() => {
      clearMockConfig();
    });

    it('should use listEntries worker pool when parallelProcesses > 1', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listEntries as jest.Mock).mockResolvedValue({
        files: ['/opt/a.ts', '/opt/b.ts'],
        dirs: ['/opt/sub1'],
      });
      // First call for /opt files, second for /opt/sub1 (empty)
      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: ['/opt/a.ts', '/opt/b.ts'], dirs: ['/opt/sub1'] })
        .mockResolvedValueOnce({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      setupMockPanel(panel);

      await performSearchWithServerList(panel, 'test');

      expect(conn.listEntries).toHaveBeenCalledWith('/opt', undefined);
    });

    it('should NOT use worker pool when parallelProcesses = 1', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 1);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      setupMockPanel(panel);

      await performSearchWithServerList(panel, 'test');

      expect(conn.listEntries).not.toHaveBeenCalled();
    });

    it('should call searchFiles with file path arrays from listEntries', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listEntries as jest.Mock).mockResolvedValue({
        files: ['/opt/f1.ts', '/opt/f2.ts', '/opt/f3.ts'],
        dirs: [],
      });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      setupMockPanel(panel);

      await performSearchWithServerList(panel, 'test');

      // searchFiles should be called with array of file paths (not directory paths)
      expect(conn.searchFiles).toHaveBeenCalledWith(
        ['/opt/f1.ts', '/opt/f2.ts', '/opt/f3.ts'],
        'test',
        expect.any(Object)
      );
    });

    it('should traverse subdirectories discovered by listEntries', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: ['/opt/root.ts'], dirs: ['/opt/sub'] })
        .mockResolvedValueOnce({ files: ['/opt/sub/deep.ts'], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      setupMockPanel(panel);

      await performSearchWithServerList(panel, 'test');

      // Should have listed both /opt and /opt/sub
      expect(conn.listEntries).toHaveBeenCalledWith('/opt', undefined);
      expect(conn.listEntries).toHaveBeenCalledWith('/opt/sub', undefined);

      // Should have searched files from both levels
      expect(conn.searchFiles).toHaveBeenCalledTimes(2);
    });

    it('should fall through to single search when listEntries fails', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listEntries as jest.Mock).mockRejectedValue(new Error('Permission denied'));
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      setupMockPanel(panel);

      await performSearchWithServerList(panel, 'test');

      // Should fall through to recursive grep on the dir (fallback)
      expect(conn.searchFiles).toHaveBeenCalledTimes(1);
      expect(conn.searchFiles).toHaveBeenCalledWith('/opt', 'test', expect.any(Object));
    });

    it('should exclude system dirs when searching from root /', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);
      setMockConfig('sshLite.searchExcludeSystemDirs', true);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      // Root path uses listDirectories for system dir filtering, then listEntries for each subdir
      (conn.listDirectories as jest.Mock).mockResolvedValue([
        '/home', '/var', '/etc', '/proc', '/sys', '/dev', '/run',
      ]);
      // listEntries for each non-system subdir
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      await performSearchWithServerList(panel, 'test');

      // listEntries should NOT be called for system dirs
      const listEntriesPaths = (conn.listEntries as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(listEntriesPaths).not.toContain('/proc');
      expect(listEntriesPaths).not.toContain('/sys');
      expect(listEntriesPaths).not.toContain('/dev');
      expect(listEntriesPaths).not.toContain('/run');

      // Should have sent systemDirsExcluded message
      const systemDirsMsg = postMessageSpy.mock.calls
        .find((call: any[]) => call[0].type === 'systemDirsExcluded');
      expect(systemDirsMsg).toBeDefined();
      expect(systemDirsMsg![0].dirs).toEqual(expect.arrayContaining(['/proc', '/sys', '/dev', '/run']));
    });

    it('should NOT exclude system dirs when searchExcludeSystemDirs is false', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);
      setMockConfig('sshLite.searchExcludeSystemDirs', false);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      // Non-root path, so listEntries is used directly
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      await performSearchWithServerList(panel, 'test');

      // listEntries should be called for root (no system dir filtering)
      expect(conn.listEntries).toHaveBeenCalledWith('/', undefined);

      // Should NOT send systemDirsExcluded message
      const systemDirsMsg = postMessageSpy.mock.calls
        .find((call: any[]) => call[0].type === 'systemDirsExcluded');
      expect(systemDirsMsg).toBeUndefined();
    });

    it('should NOT exclude system dirs when path is not root /', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);
      setMockConfig('sshLite.searchExcludeSystemDirs', true);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: [], dirs: ['/opt/proc', '/opt/sys'] })
        .mockResolvedValueOnce({ files: ['/opt/proc/f.ts'], dirs: [] })
        .mockResolvedValueOnce({ files: ['/opt/sys/f.ts'], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      setupMockPanel(panel);

      await performSearchWithServerList(panel, 'test');

      // Both subdirs should be listed (exclusion only applies to root /)
      const listEntriesPaths = (conn.listEntries as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(listEntriesPaths).toContain('/opt/proc');
      expect(listEntriesPaths).toContain('/opt/sys');
    });

    it('should send progressive searchBatch messages', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 2);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listEntries as jest.Mock).mockResolvedValue({
        files: ['/opt/a.ts', '/opt/b.ts'],
        dirs: [],
      });
      (conn.searchFiles as jest.Mock)
        .mockResolvedValueOnce([{ path: '/opt/a.ts', line: 1, match: 'x' }, { path: '/opt/b.ts', line: 2, match: 'x' }]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      await performSearchWithServerList(panel, 'x');

      const batchMessages = postMessageSpy.mock.calls
        .filter((call: any[]) => call[0].type === 'searchBatch');

      // Should have at least 2 batches: 1 for dir listing (progress), 1 for file search
      expect(batchMessages.length).toBeGreaterThanOrEqual(2);
      // Last one should be done
      expect(batchMessages[batchMessages.length - 1][0].done).toBe(true);
      // Total results should include search results
      expect(batchMessages[batchMessages.length - 1][0].totalResults).toBe(2);
    });
  });

  describe('backward compatibility (legacy searchScopes path)', () => {
    const performSearch = async (
      panelInst: SearchPanel,
      query: string,
      include = '',
      exclude = '',
      caseSensitive = false,
      regex = false,
      findFiles = false
    ) => {
      return (panelInst as any).performSearch(query, include, exclude, caseSensitive, regex, findFiles);
    };

    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    it('should use legacy path when no serverList is set', async () => {
      const conn = createMockConnection();
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/found.ts', line: 5, match: 'hello' },
      ]);

      // Only add scope, no setServerList — forces legacy path
      panel.addScope('/home', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      await performSearch(panel, 'hello');

      // Legacy path sends 'results' message (not searchBatch)
      const resultsMsg = postMessageSpy.mock.calls
        .find((call: any[]) => call[0].type === 'results');
      expect(resultsMsg).toBeDefined();
      expect(resultsMsg![0].results).toHaveLength(1);

      // Should NOT send searchBatch (that's the new serverList path)
      const batchMsg = postMessageSpy.mock.calls
        .find((call: any[]) => call[0].type === 'searchBatch');
      expect(batchMsg).toBeUndefined();
    });

    it('should use serverList path when servers are checked', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/found.ts', line: 5, match: 'hello' },
      ]);

      setMockConfig('sshLite.searchParallelProcesses', 1);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/home', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      await performSearch(panel, 'hello');

      // ServerList path sends searchBatch messages (not legacy 'results')
      const batchMsg = postMessageSpy.mock.calls
        .find((call: any[]) => call[0].type === 'searchBatch');
      expect(batchMsg).toBeDefined();

      clearMockConfig();
    });

    it('should still call searchFiles with single string path in legacy mode', async () => {
      const conn = createMockConnection();
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.addScope('/var/log', conn as any);

      setupMockPanel(panel);

      await performSearch(panel, 'test');

      // Legacy path passes single string path (not array)
      expect(conn.searchFiles).toHaveBeenCalledWith(
        '/var/log',
        'test',
        expect.any(Object)
      );
    });
  });

  describe('handleMessage: searchIncludeSystemDirs', () => {
    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    afterEach(() => {
      clearMockConfig();
    });

    it('should search only excluded system dirs on include-all (not re-run entire search)', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);
      setMockConfig('sshLite.searchExcludeSystemDirs', true);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      // Root path uses listDirectories for system dir filtering
      (conn.listDirectories as jest.Mock).mockResolvedValue(['/home', '/var', '/proc', '/sys']);
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      // First search — system dirs should be excluded
      await (panel as any).performSearch('test', '', '', false, false, false);

      // listEntries should NOT be called for system dirs
      const firstListPaths = (conn.listEntries as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(firstListPaths).not.toContain('/proc');
      expect(firstListPaths).not.toContain('/sys');

      // Clear mocks to track the include-all search
      (conn.searchFiles as jest.Mock).mockClear();
      (conn.listEntries as jest.Mock).mockClear();
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      // Simulate webview sending searchIncludeSystemDirs message
      await (panel as any).handleMessage({ type: 'searchIncludeSystemDirs' });

      // Include-all should search ONLY the excluded system dirs (/proc, /sys), NOT re-run entire search
      const secondListPaths = (conn.listEntries as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(secondListPaths).toContain('/proc');
      expect(secondListPaths).toContain('/sys');
      // Should NOT re-search non-system dirs
      expect(secondListPaths).not.toContain('/home');
      expect(secondListPaths).not.toContain('/var');
    });

    it('should set includeSystemDirsOverride to true after include-all', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);
      setMockConfig('sshLite.searchExcludeSystemDirs', true);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listDirectories as jest.Mock).mockResolvedValue(['/home', '/var', '/proc', '/sys']);
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      setupMockPanel(panel);

      // Trigger initial search to set lastSearchQuery (system dirs get excluded)
      await (panel as any).performSearch('test', '', '', false, false, false);

      // Trigger include-all system dirs
      await (panel as any).handleMessage({ type: 'searchIncludeSystemDirs' });

      // Override stays true (system dirs now permanently included for this search)
      expect((panel as any).includeSystemDirsOverride).toBe(true);
    });

    it('should do nothing if no previous search query', async () => {
      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      setupMockPanel(panel);

      // No previous search — handleMessage should be a no-op
      await (panel as any).handleMessage({ type: 'searchIncludeSystemDirs' });

      expect(conn.searchFiles).not.toHaveBeenCalled();
    });
  });

  describe('isChildPath', () => {
    it('should return true for child of root /', () => {
      expect((SearchPanel as any).isChildPath('/home', '/')).toBe(true);
    });

    it('should return false for root compared to root', () => {
      expect((SearchPanel as any).isChildPath('/', '/')).toBe(false);
    });

    it('should return true for child of non-root path', () => {
      expect((SearchPanel as any).isChildPath('/opt/inet/DB', '/opt')).toBe(true);
    });

    it('should return false for non-child path', () => {
      expect((SearchPanel as any).isChildPath('/var/log', '/opt')).toBe(false);
    });

    it('should return false for partial name match', () => {
      // /opt-backup is NOT a child of /opt
      expect((SearchPanel as any).isChildPath('/opt-backup', '/opt')).toBe(false);
    });
  });

  // ===== Change 1: Per-Server Max Search Processes =====

  describe('setServerMaxProcesses', () => {
    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    it('should set per-server override clamped to min 5', async () => {
      const mockCtx = createMockExtensionContext();
      (mockCtx.globalState.get as jest.Mock).mockReturnValue({});
      panel.loadSortOrder(mockCtx as any);

      panel.setServerList([
        createServerEntry({ id: 'svr1' }),
      ]);

      setupMockPanel(panel);

      await (panel as any).handleMessage({ type: 'setServerMaxProcesses', serverId: 'svr1', value: 2 });

      expect((panel as any).serverList[0].maxSearchProcesses).toBe(5);
    });

    it('should set per-server override clamped to max 50', async () => {
      const mockCtx = createMockExtensionContext();
      (mockCtx.globalState.get as jest.Mock).mockReturnValue({});
      panel.loadSortOrder(mockCtx as any);

      panel.setServerList([
        createServerEntry({ id: 'svr1' }),
      ]);

      setupMockPanel(panel);

      await (panel as any).handleMessage({ type: 'setServerMaxProcesses', serverId: 'svr1', value: 100 });

      expect((panel as any).serverList[0].maxSearchProcesses).toBe(50);
    });

    it('should set per-server override within valid range', async () => {
      const mockCtx = createMockExtensionContext();
      (mockCtx.globalState.get as jest.Mock).mockReturnValue({});
      panel.loadSortOrder(mockCtx as any);

      panel.setServerList([
        createServerEntry({ id: 'svr1' }),
      ]);

      setupMockPanel(panel);

      await (panel as any).handleMessage({ type: 'setServerMaxProcesses', serverId: 'svr1', value: 15 });

      expect((panel as any).serverList[0].maxSearchProcesses).toBe(15);
    });

    it('should clear per-server override when value is null', async () => {
      const mockCtx = createMockExtensionContext();
      (mockCtx.globalState.get as jest.Mock).mockReturnValue({});
      panel.loadSortOrder(mockCtx as any);

      panel.setServerList([
        createServerEntry({ id: 'svr1' }),
      ]);

      setupMockPanel(panel);

      // First set it
      await (panel as any).handleMessage({ type: 'setServerMaxProcesses', serverId: 'svr1', value: 25 });
      expect((panel as any).serverList[0].maxSearchProcesses).toBe(25);

      // Then clear it
      await (panel as any).handleMessage({ type: 'setServerMaxProcesses', serverId: 'svr1', value: null });
      expect((panel as any).serverList[0].maxSearchProcesses).toBeUndefined();
    });

    it('should persist override to globalState', async () => {
      const mockCtx = createMockExtensionContext();
      (mockCtx.globalState.get as jest.Mock).mockReturnValue({});
      panel.loadSortOrder(mockCtx as any);

      panel.setServerList([
        createServerEntry({ id: 'svr1' }),
      ]);

      setupMockPanel(panel);

      await (panel as any).handleMessage({ type: 'setServerMaxProcesses', serverId: 'svr1', value: 30 });

      expect(mockCtx.globalState.update).toHaveBeenCalledWith(
        'sshLite.serverSearchSettings',
        expect.objectContaining({ svr1: { maxSearchProcesses: 30 } })
      );
    });

    it('should delete persisted override when value is null', async () => {
      const mockCtx = createMockExtensionContext();
      (mockCtx.globalState.get as jest.Mock).mockReturnValue({ svr1: { maxSearchProcesses: 30 } });
      panel.loadSortOrder(mockCtx as any);

      panel.setServerList([
        createServerEntry({ id: 'svr1' }),
      ]);

      setupMockPanel(panel);

      await (panel as any).handleMessage({ type: 'setServerMaxProcesses', serverId: 'svr1', value: null });

      // Settings object should not contain svr1 anymore
      const updateCall = (mockCtx.globalState.update as jest.Mock).mock.calls.find(
        (c: any[]) => c[0] === 'sshLite.serverSearchSettings'
      );
      expect(updateCall).toBeDefined();
      expect(updateCall![1]).not.toHaveProperty('svr1');
    });

    it('should call sendState() after setting override', async () => {
      const mockCtx = createMockExtensionContext();
      (mockCtx.globalState.get as jest.Mock).mockReturnValue({});
      panel.loadSortOrder(mockCtx as any);

      panel.setServerList([
        createServerEntry({ id: 'svr1' }),
      ]);

      const postMessageSpy = setupMockPanel(panel);

      await (panel as any).handleMessage({ type: 'setServerMaxProcesses', serverId: 'svr1', value: 10 });

      // sendState() posts a 'state' message to the webview
      const stateMsg = postMessageSpy.mock.calls.find((call: any[]) => call[0].type === 'state');
      expect(stateMsg).toBeDefined();
    });
  });

  describe('sendState includes maxSearchProcesses', () => {
    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    afterEach(() => {
      clearMockConfig();
    });

    it('should include maxSearchProcesses per server in state', () => {
      panel.setServerList([
        createServerEntry({ id: 'svr1' }),
      ]);

      // Set override directly
      (panel as any).serverList[0].maxSearchProcesses = 25;

      const postMessageSpy = setupMockPanel(panel);

      (panel as any).sendState();

      const stateMsg = postMessageSpy.mock.calls.find((call: any[]) => call[0].type === 'state');
      expect(stateMsg).toBeDefined();
      expect(stateMsg![0].serverList[0].maxSearchProcesses).toBe(25);
    });

    it('should include globalMaxSearchProcesses in state', () => {
      setMockConfig('sshLite.searchParallelProcesses', 12);

      panel.setServerList([
        createServerEntry({ id: 'svr1' }),
      ]);

      const postMessageSpy = setupMockPanel(panel);

      (panel as any).sendState();

      const stateMsg = postMessageSpy.mock.calls.find((call: any[]) => call[0].type === 'state');
      expect(stateMsg).toBeDefined();
      expect(stateMsg![0].globalMaxSearchProcesses).toBe(12);
    });

    it('should default globalMaxSearchProcesses to 20 when not configured', () => {
      // No config set — should default to 20
      const postMessageSpy = setupMockPanel(panel);

      (panel as any).sendState();

      const stateMsg = postMessageSpy.mock.calls.find((call: any[]) => call[0].type === 'state');
      expect(stateMsg).toBeDefined();
      expect(stateMsg![0].globalMaxSearchProcesses).toBe(20);
    });
  });

  describe('worker pool uses per-server override', () => {
    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    afterEach(() => {
      clearMockConfig();
    });

    it('should use per-server maxSearchProcesses instead of global setting', async () => {
      // Global setting is 4, but server override is 10
      setMockConfig('sshLite.searchParallelProcesses', 4);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      // Worker pool uses listEntries when parallelProcesses > 1
      (conn.listEntries as jest.Mock)
        .mockResolvedValueOnce({ files: ['/opt/a.ts'], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      // Set per-server override to 10
      (panel as any).serverList[0].maxSearchProcesses = 10;

      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      setupMockPanel(panel);

      await (panel as any).performSearch('test', '', '', false, false, false);

      // The search should succeed (verifies the per-server override path is used).
      // We verify that listEntries was called (worker pool was activated because parallelProcesses > 1),
      // and the search completed.
      expect(conn.listEntries).toHaveBeenCalled();
      expect(conn.searchFiles).toHaveBeenCalled();
    });
  });

  // ===== Change 2: Cancel/Re-Search Bug Fix (searchId) =====

  describe('currentSearchId', () => {
    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    beforeEach(() => {
      setMockConfig('sshLite.searchParallelProcesses', 1);
    });

    afterEach(() => {
      clearMockConfig();
    });

    it('should increment currentSearchId on each performSearch', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      setupMockPanel(panel);

      const id0 = (panel as any).currentSearchId;

      await (panel as any).performSearch('first', '', '', false, false, false);
      const id1 = (panel as any).currentSearchId;

      await (panel as any).performSearch('second', '', '', false, false, false);
      const id2 = (panel as any).currentSearchId;

      expect(id1).toBe(id0 + 1);
      expect(id2).toBe(id0 + 2);
    });

    it('should reset currentSearchActivityIds on each performSearch', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      setupMockPanel(panel);

      // Manually set some activity IDs to simulate leftover from previous search
      (panel as any).currentSearchActivityIds = ['old-activity-1', 'old-activity-2'];

      await (panel as any).performSearch('test', '', '', false, false, false);

      // After performSearch starts, old IDs should be cleared and new ones should be present
      // (the search completed, so there should be activity IDs from the new search)
      const ids = (panel as any).currentSearchActivityIds as string[];
      expect(ids).not.toContain('old-activity-1');
      expect(ids).not.toContain('old-activity-2');
    });

    it('should include searchId in searching message', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      await (panel as any).performSearch('test', '', '', false, false, false);

      const searchingMsg = postMessageSpy.mock.calls.find(
        (call: any[]) => call[0].type === 'searching'
      );
      expect(searchingMsg).toBeDefined();
      expect(searchingMsg![0].searchId).toBeDefined();
      expect(typeof searchingMsg![0].searchId).toBe('number');
    });

    it('should include searchId in searchBatch messages', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/a.ts', line: 1, match: 'x' },
      ]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      await (panel as any).performSearch('x', '', '', false, false, false);

      const batchMessages = postMessageSpy.mock.calls
        .filter((call: any[]) => call[0].type === 'searchBatch');
      expect(batchMessages.length).toBeGreaterThan(0);

      for (const msg of batchMessages) {
        expect(msg[0].searchId).toBeDefined();
        expect(msg[0].searchId).toBe((panel as any).currentSearchId);
      }
    });
  });

  describe('stale searchBatch discarding (webview side)', () => {
    // This tests the pattern: stale messages are discarded when searchId doesn't match.
    // We verify that the backend sends searchId in every batch, so the webview can filter.
    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    beforeEach(() => {
      setMockConfig('sshLite.searchParallelProcesses', 1);
    });

    afterEach(() => {
      clearMockConfig();
    });

    it('should not post searchBatch when searchId is stale (search was superseded)', async () => {
      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });

      let resolveSearch: (value: any[]) => void;
      const searchPromise = new Promise<any[]>((resolve) => {
        resolveSearch = resolve;
      });
      (conn.searchFiles as jest.Mock).mockReturnValue(searchPromise);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      // Start first search (it will block on searchPromise)
      const search1 = (panel as any).performSearch('first', '', '', false, false, false);
      const firstSearchId = (panel as any).currentSearchId;

      // Start second search (this supersedes the first, incrementing currentSearchId)
      const freshConn = createMockConnection({ id: 'svr1', host });
      (freshConn.searchFiles as jest.Mock).mockResolvedValue([]);
      panel.setConnectionResolver(() => freshConn as any);

      const search2 = (panel as any).performSearch('second', '', '', false, false, false);

      // Resolve the first search's pending promise after second search started
      resolveSearch!([{ path: '/stale.ts', line: 1, match: 'first' }]);

      await search1;
      await search2;

      // The first search's results should NOT produce a searchBatch with the stale searchId
      // because currentSearchId has been incremented
      const batchMessages = postMessageSpy.mock.calls
        .filter((call: any[]) => call[0].type === 'searchBatch');

      const staleMessages = batchMessages.filter(
        (call: any[]) => call[0].searchId === firstSearchId
      );
      // The stale search should not have posted any batches because
      // the searchId check (searchId !== this.currentSearchId) prevents it
      expect(staleMessages.length).toBe(0);
    });
  });

  describe('cancel then re-search integration', () => {
    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    beforeEach(() => {
      setMockConfig('sshLite.searchParallelProcesses', 1);
    });

    afterEach(() => {
      clearMockConfig();
    });

    it('should cancel old search activities and new search works independently', async () => {
      const { ActivityService } = require('../services/ActivityService');
      const activityService = ActivityService.getInstance();
      activityService.cancelActivity.mockClear();
      activityService.startActivity.mockClear();

      const host = createMockHostConfig({ id: 'svr1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/result.ts', line: 1, match: 'test' },
      ]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/opt', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      // First search
      await (panel as any).performSearch('first', '', '', false, false, false);
      const firstActivityIds = [...(panel as any).currentSearchActivityIds];
      expect(firstActivityIds.length).toBeGreaterThan(0);

      // Cancel
      panel.cancelSearch();

      // Verify cancel was called for the first search's activity IDs
      for (const id of firstActivityIds) {
        expect(activityService.cancelActivity).toHaveBeenCalledWith(id);
      }

      // Second search — should work independently
      activityService.startActivity.mockClear();
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/new-result.ts', line: 5, match: 'second' },
      ]);

      await (panel as any).performSearch('second', '', '', false, false, false);

      // New search produced results
      const batchMessages = postMessageSpy.mock.calls
        .filter((call: any[]) => call[0].type === 'searchBatch');
      const lastBatch = batchMessages[batchMessages.length - 1];
      expect(lastBatch).toBeDefined();
      expect(lastBatch[0].done).toBe(true);
      expect(lastBatch[0].totalResults).toBeGreaterThan(0);
    });
  });

  // ===== Change 6: Include-All System Dirs In-Progress =====

  describe('searchExcludedSystemDirs', () => {
    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    afterEach(() => {
      clearMockConfig();
    });

    it('should only search previously excluded dirs (not all dirs)', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);
      setMockConfig('sshLite.searchExcludeSystemDirs', true);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listDirectories as jest.Mock).mockResolvedValue([
        '/home', '/var', '/proc', '/sys', '/dev',
      ]);
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      setupMockPanel(panel);

      // Initial search — system dirs excluded
      await (panel as any).performSearch('test', '', '', false, false, false);

      // Verify system dirs were excluded and stored
      const excludedDirs = (panel as any).lastExcludedSystemDirs as string[];
      // After the initial search, the excluded dirs should be stored
      // (they include /proc, /sys, /dev)
      // Note: the search sets lastExcludedSystemDirs during execution

      // Clear mocks for the include-all phase
      (conn.listEntries as jest.Mock).mockClear();
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockClear();
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      // Trigger include-all
      await (panel as any).searchExcludedSystemDirs();

      // Should only search previously excluded dirs — NOT /home or /var
      const listEntriesPaths = (conn.listEntries as jest.Mock).mock.calls.map((c: any[]) => c[0]);
      expect(listEntriesPaths).not.toContain('/home');
      expect(listEntriesPaths).not.toContain('/var');
    });

    it('should do nothing if no system dirs were excluded', async () => {
      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);

      setupMockPanel(panel);

      // No previous search — lastExcludedSystemDirs is empty
      await (panel as any).searchExcludedSystemDirs();

      // Should not call any search methods
      expect(conn.searchFiles).not.toHaveBeenCalled();
      expect(conn.listEntries).not.toHaveBeenCalled();
    });

    it('should clear lastExcludedSystemDirs after include-all', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);
      setMockConfig('sshLite.searchExcludeSystemDirs', true);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listDirectories as jest.Mock).mockResolvedValue(['/home', '/proc', '/sys']);
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      setupMockPanel(panel);

      // Initial search
      await (panel as any).performSearch('test', '', '', false, false, false);

      // Trigger include-all
      await (panel as any).searchExcludedSystemDirs();

      // lastExcludedSystemDirs should be cleared
      expect((panel as any).lastExcludedSystemDirs).toEqual([]);
    });

    it('should set includeSystemDirsOverride to true after include-all', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);
      setMockConfig('sshLite.searchExcludeSystemDirs', true);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listDirectories as jest.Mock).mockResolvedValue(['/home', '/proc']);
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      setupMockPanel(panel);

      // Initial search
      await (panel as any).performSearch('test', '', '', false, false, false);
      expect((panel as any).includeSystemDirsOverride).toBe(false);

      // Include-all
      await (panel as any).searchExcludedSystemDirs();

      expect((panel as any).includeSystemDirsOverride).toBe(true);
    });
  });

  describe('include-all merges into ongoing search (shared counters)', () => {
    function setupMockPanel(panelInst: SearchPanel): jest.Mock {
      const postMessageSpy = jest.fn();
      (panelInst as any).panel = {
        webview: { postMessage: postMessageSpy },
      };
      return postMessageSpy;
    }

    afterEach(() => {
      clearMockConfig();
    });

    it('should share currentGlobalSeen across search and include-all', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);
      setMockConfig('sshLite.searchExcludeSystemDirs', true);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listDirectories as jest.Mock).mockResolvedValue(['/home', '/proc']);
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: ['/home/a.ts'], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/home/a.ts', line: 1, match: 'test' },
      ]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      setupMockPanel(panel);

      // Initial search — finds results in /home
      await (panel as any).performSearch('test', '', '', false, false, false);

      const globalSeenAfterSearch = (panel as any).currentGlobalSeen as Set<string>;
      const sizeAfterSearch = globalSeenAfterSearch.size;
      expect(sizeAfterSearch).toBeGreaterThan(0);

      // Now include-all — new results from /proc should merge into same globalSeen
      (conn.listEntries as jest.Mock).mockClear();
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: ['/proc/info.ts'], dirs: [] });
      (conn.searchFiles as jest.Mock).mockClear();
      (conn.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/proc/info.ts', line: 5, match: 'test' },
      ]);

      await (panel as any).searchExcludedSystemDirs();

      // globalSeen should have grown (contains results from both initial and include-all)
      expect((panel as any).currentGlobalSeen.size).toBeGreaterThan(sizeAfterSearch);
    });

    it('should use same searchId for include-all as the original search', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);
      setMockConfig('sshLite.searchExcludeSystemDirs', true);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listDirectories as jest.Mock).mockResolvedValue(['/home', '/proc']);
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      const postMessageSpy = setupMockPanel(panel);

      // Initial search
      await (panel as any).performSearch('test', '', '', false, false, false);
      const originalSearchId = (panel as any).currentSearchId;

      // Clear mocks for include-all
      postMessageSpy.mockClear();
      (conn.listEntries as jest.Mock).mockClear();
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });

      // Include-all
      await (panel as any).searchExcludedSystemDirs();

      // Batch messages from include-all should use the SAME searchId
      const batchMessages = postMessageSpy.mock.calls
        .filter((call: any[]) => call[0].type === 'searchBatch');
      for (const msg of batchMessages) {
        expect(msg[0].searchId).toBe(originalSearchId);
      }
    });

    it('should increment shared counters during include-all', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);
      setMockConfig('sshLite.searchExcludeSystemDirs', true);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listDirectories as jest.Mock).mockResolvedValue(['/home', '/proc', '/sys']);
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      setupMockPanel(panel);

      // Initial search
      await (panel as any).performSearch('test', '', '', false, false, false);

      const countAfterSearch = (panel as any).currentCompletedCount;
      const totalAfterSearch = (panel as any).currentTotalCount;

      // Include-all — adds work items for /proc and /sys
      (conn.listEntries as jest.Mock).mockClear();
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });

      await (panel as any).searchExcludedSystemDirs();

      // totalCount should have increased (more work items added)
      expect((panel as any).currentTotalCount).toBeGreaterThanOrEqual(totalAfterSearch);
      // completedCount should match totalCount (all done)
      expect((panel as any).currentCompletedCount).toBe((panel as any).currentTotalCount);
    });

    it('should use lastSearchConnectionMap for include-all', async () => {
      setMockConfig('sshLite.searchParallelProcesses', 4);
      setMockConfig('sshLite.searchExcludeSystemDirs', true);

      const host = createMockHostConfig({ id: 'svr1', name: 'Server1' });
      const conn = createMockConnection({ id: 'svr1', host });
      (conn.listDirectories as jest.Mock).mockResolvedValue(['/home', '/proc']);
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });
      (conn.searchFiles as jest.Mock).mockResolvedValue([]);

      panel.setServerList([
        createServerEntry({ id: 'svr1', hostConfig: host, connected: true }),
      ]);
      panel.setConnectionResolver(() => conn as any);
      panel.addScope('/', conn as any);

      setupMockPanel(panel);

      // Initial search populates lastSearchConnectionMap
      await (panel as any).performSearch('test', '', '', false, false, false);

      const connectionMap = (panel as any).lastSearchConnectionMap as Map<string, any>;
      expect(connectionMap.size).toBeGreaterThan(0);
      expect(connectionMap.has('svr1')).toBe(true);

      // Include-all uses the same connection map
      (conn.listEntries as jest.Mock).mockClear();
      (conn.listEntries as jest.Mock).mockResolvedValue({ files: [], dirs: [] });

      await (panel as any).searchExcludedSystemDirs();

      // searchExcludedSystemDirs should have used the connection from the map
      // Verify by checking that listEntries was called (it uses the connection)
      expect(conn.listEntries).toHaveBeenCalled();
    });
  });
});
