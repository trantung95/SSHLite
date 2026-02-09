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
import { window } from '../__mocks__/vscode';
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
});
