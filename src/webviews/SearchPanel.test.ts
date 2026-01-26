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

import { SearchPanel, SearchScope } from './SearchPanel';
import { window } from '../__mocks__/vscode';
import { createMockConnection, createMockHostConfig } from '../__mocks__/testHelpers';

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
});
