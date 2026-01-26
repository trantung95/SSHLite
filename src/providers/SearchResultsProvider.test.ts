/**
 * SearchResultsProvider tests
 *
 * Tests search results tree:
 * - Setting/clearing results
 * - File grouping
 * - Sort options (name, path, matches)
 * - Tree item generation (file, match, sort header)
 * - Searching state
 */

import {
  SearchResultsProvider,
  SearchResult,
  SearchResultFileItem,
  SearchResultMatchItem,
  SortOptionItem,
} from './SearchResultsProvider';
import { createMockConnection } from '../__mocks__/testHelpers';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  const conn = createMockConnection();
  return {
    path: '/home/user/app.ts',
    line: 10,
    match: 'const test = true;',
    connection: conn as any,
    ...overrides,
  };
}

describe('SearchResultsProvider', () => {
  let provider: SearchResultsProvider;

  beforeEach(() => {
    provider = new SearchResultsProvider();
  });

  describe('initial state', () => {
    it('should have no results', () => {
      expect(provider.getResultCount()).toBe(0);
      expect(provider.getSearchQuery()).toBe('');
      expect(provider.getIsSearching()).toBe(false);
    });

    it('should return empty children at root', () => {
      const children = provider.getChildren();
      expect(children).toEqual([]);
    });
  });

  describe('setResults', () => {
    it('should store results and query', () => {
      const results = [makeResult()];
      provider.setResults(results, 'test', '/home');

      expect(provider.getResultCount()).toBe(1);
      expect(provider.getSearchQuery()).toBe('test');
      expect(provider.getIsSearching()).toBe(false);
    });

    it('should group results by file path', () => {
      const conn = createMockConnection();
      const results = [
        makeResult({ path: '/file1.ts', line: 1, connection: conn as any }),
        makeResult({ path: '/file1.ts', line: 5, connection: conn as any }),
        makeResult({ path: '/file2.ts', line: 10, connection: conn as any }),
      ];
      provider.setResults(results, 'test', '/');

      const children = provider.getChildren();
      // 1 sort header + 2 file items
      expect(children).toHaveLength(3);
      expect(children[0]).toBeInstanceOf(SortOptionItem);
      expect(children[1]).toBeInstanceOf(SearchResultFileItem);
      expect(children[2]).toBeInstanceOf(SearchResultFileItem);
    });
  });

  describe('clear', () => {
    it('should clear all results', () => {
      provider.setResults([makeResult()], 'test', '/');
      provider.clear();

      expect(provider.getResultCount()).toBe(0);
      expect(provider.getSearchQuery()).toBe('');
      expect(provider.getChildren()).toEqual([]);
    });
  });

  describe('setSearching', () => {
    it('should set searching state', () => {
      provider.setSearching('query', '/path');

      expect(provider.getIsSearching()).toBe(true);
      expect(provider.getSearchQuery()).toBe('query');
      expect(provider.getResultCount()).toBe(0);
    });
  });

  describe('sort options', () => {
    it('should default to name sort', () => {
      expect(provider.getSortOption()).toBe('name');
    });

    it('should set sort option', () => {
      provider.setSortOption('matches');
      expect(provider.getSortOption()).toBe('matches');
    });

    it('should cycle through sort options', () => {
      expect(provider.getSortOption()).toBe('name');
      provider.cycleSort();
      expect(provider.getSortOption()).toBe('path');
      provider.cycleSort();
      expect(provider.getSortOption()).toBe('matches');
      provider.cycleSort();
      expect(provider.getSortOption()).toBe('name'); // wraps around
    });

    it('should sort by name alphabetically', () => {
      const conn = createMockConnection();
      const results = [
        makeResult({ path: '/zebra.ts', connection: conn as any }),
        makeResult({ path: '/alpha.ts', connection: conn as any }),
        makeResult({ path: '/mango.ts', connection: conn as any }),
      ];
      provider.setSortOption('name');
      provider.setResults(results, 'test', '/');

      const children = provider.getChildren();
      const fileItems = children.filter(c => c instanceof SearchResultFileItem) as SearchResultFileItem[];
      expect(fileItems.map(f => f.filePath)).toEqual(['/alpha.ts', '/mango.ts', '/zebra.ts']);
    });

    it('should sort by match count descending', () => {
      const conn = createMockConnection();
      const results = [
        makeResult({ path: '/few.ts', line: 1, connection: conn as any }),
        makeResult({ path: '/many.ts', line: 1, connection: conn as any }),
        makeResult({ path: '/many.ts', line: 2, connection: conn as any }),
        makeResult({ path: '/many.ts', line: 3, connection: conn as any }),
      ];
      provider.setSortOption('matches');
      provider.setResults(results, 'test', '/');

      const children = provider.getChildren();
      const fileItems = children.filter(c => c instanceof SearchResultFileItem) as SearchResultFileItem[];
      expect(fileItems[0].filePath).toBe('/many.ts'); // 3 matches
      expect(fileItems[1].filePath).toBe('/few.ts');  // 1 match
    });
  });

  describe('SearchResultFileItem', () => {
    it('should display filename as label', () => {
      const conn = createMockConnection();
      const results = [makeResult({ path: '/home/user/app.ts', connection: conn as any })];
      const item = new SearchResultFileItem('/home/user/app.ts', conn as any, results, false);

      expect(item.label).toBe('app.ts');
    });

    it('should display directory as description', () => {
      const conn = createMockConnection();
      const results = [makeResult({ path: '/home/user/app.ts', connection: conn as any })];
      const item = new SearchResultFileItem('/home/user/app.ts', conn as any, results, false);

      expect(item.description).toBe('/home/user');
    });

    it('should generate unique ID', () => {
      const conn = createMockConnection({ id: 'conn1' });
      const results = [makeResult({ path: '/app.ts', connection: conn as any })];
      const item = new SearchResultFileItem('/app.ts', conn as any, results, false);

      expect(item.id).toBe('search-file:conn1:/app.ts');
    });

    it('should be collapsible when has matches', () => {
      const conn = createMockConnection();
      const results = [makeResult({ path: '/app.ts', line: 10, connection: conn as any })];
      const item = new SearchResultFileItem('/app.ts', conn as any, results, true);

      // Collapsed = 1
      expect(item.collapsibleState).toBe(1);
    });

    it('should not be collapsible when no matches', () => {
      const conn = createMockConnection();
      const results = [makeResult({ path: '/app.ts', connection: conn as any })];
      const item = new SearchResultFileItem('/app.ts', conn as any, results, false);

      // None = 0
      expect(item.collapsibleState).toBe(0);
    });

    it('should have open command', () => {
      const conn = createMockConnection();
      const results = [makeResult({ connection: conn as any })];
      const item = new SearchResultFileItem('/app.ts', conn as any, results, false);

      expect(item.command?.command).toBe('sshLite.openSearchResult');
    });
  });

  describe('SearchResultMatchItem', () => {
    it('should display match text', () => {
      const result = makeResult({ match: 'const x = 1;' });
      const item = new SearchResultMatchItem(result);

      expect(item.label).toBe('const x = 1;');
    });

    it('should truncate long match text', () => {
      const longMatch = 'a'.repeat(100);
      const result = makeResult({ match: longMatch });
      const item = new SearchResultMatchItem(result);

      expect((item.label as string).length).toBeLessThan(100);
      expect((item.label as string).endsWith('...')).toBe(true);
    });

    it('should show line number in description', () => {
      const result = makeResult({ line: 42 });
      const item = new SearchResultMatchItem(result);

      expect(item.description).toBe('Line 42');
    });

    it('should generate unique ID with line number', () => {
      const conn = createMockConnection({ id: 'conn1' });
      const result = makeResult({ path: '/app.ts', line: 42, connection: conn as any });
      const item = new SearchResultMatchItem(result);

      expect(item.id).toBe('search-match:conn1:/app.ts:42');
    });

    it('should have open command', () => {
      const result = makeResult();
      const item = new SearchResultMatchItem(result);

      expect(item.command?.command).toBe('sshLite.openSearchResult');
    });
  });

  describe('SortOptionItem', () => {
    it('should display current sort label', () => {
      const item = new SortOptionItem('name', 10);
      expect(item.label).toBe('Sort: Name (A-Z)');
    });

    it('should show result count in description', () => {
      const item = new SortOptionItem('name', 10);
      expect(item.description).toBe('10 file(s) found');
    });

    it('should have cycle sort command', () => {
      const item = new SortOptionItem('name', 5);
      expect(item.command?.command).toBe('sshLite.cycleSearchSort');
    });
  });

  describe('getChildren for file item', () => {
    it('should return match items for file children', () => {
      const conn = createMockConnection();
      const results = [
        makeResult({ path: '/app.ts', line: 1, match: 'first', connection: conn as any }),
        makeResult({ path: '/app.ts', line: 5, match: 'second', connection: conn as any }),
      ];
      const fileItem = new SearchResultFileItem('/app.ts', conn as any, results, true);

      const children = provider.getChildren(fileItem);
      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(SearchResultMatchItem);
      expect(children[1]).toBeInstanceOf(SearchResultMatchItem);
    });
  });

  describe('getTreeItem', () => {
    it('should return element itself', () => {
      const item = new SortOptionItem('name', 1);
      expect(provider.getTreeItem(item)).toBe(item);
    });
  });

  describe('getParent', () => {
    it('should return undefined for file items', () => {
      const conn = createMockConnection();
      const results = [makeResult({ connection: conn as any })];
      const item = new SearchResultFileItem('/app.ts', conn as any, results, false);
      expect(provider.getParent(item)).toBeUndefined();
    });

    it('should return undefined for match items', () => {
      const result = makeResult();
      const item = new SearchResultMatchItem(result);
      expect(provider.getParent(item)).toBeUndefined();
    });
  });
});
