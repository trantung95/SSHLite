/**
 * FileTreeProvider filter tests
 *
 * Tests covering:
 * - Multi-filter state management (Bug 2 fix: filter reset on 2nd folder)
 * - Folder name matching (Bug 1 fix: grayed-out matching folders like "rccron")
 * - Filter modes (files, folders, both)
 * - Match count per folder (recursive)
 * - Selective filter clearing
 * - nameMatchesPattern helper
 * - shouldHighlightByFilter with filter modes
 * - isEmptyAfterFilter with folder name check
 * - FileDecorationProvider multi-filter support
 */

import { IRemoteFile } from '../types';
import { createMockConnection, createMockRemoteFile } from '../__mocks__/testHelpers';

// --- Mock service instances ---

const mockGetConnection = jest.fn();
const mockGetAllConnections = jest.fn().mockReturnValue([]);
const mockGetAllConnectionsWithReconnecting = jest.fn().mockReturnValue({ active: [], reconnecting: [] });
const mockConnectionChangeEmitter = new (require('../__mocks__/vscode').EventEmitter)();
const mockReconnectingEmitter = new (require('../__mocks__/vscode').EventEmitter)();
const mockOnOpenFilesChanged = new (require('../__mocks__/vscode').EventEmitter)();
const mockOnFileLoadingChanged = new (require('../__mocks__/vscode').EventEmitter)();
const mockEnqueue = jest.fn().mockResolvedValue(undefined);
const mockStartActivity = jest.fn().mockReturnValue('activity-1');
const mockCompleteActivity = jest.fn();
const mockFailActivity = jest.fn();

// --- jest.mock calls ---

jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: {
    getInstance: jest.fn().mockReturnValue({
      getConnection: mockGetConnection,
      getAllConnections: mockGetAllConnections,
      getAllConnectionsWithReconnecting: mockGetAllConnectionsWithReconnecting,
      onDidChangeConnections: mockConnectionChangeEmitter.event,
      onReconnecting: mockReconnectingEmitter.event,
      getLastConnectionAttempt: jest.fn().mockReturnValue(undefined),
    }),
  },
}));

jest.mock('../services/FileService', () => ({
  FileService: {
    getInstance: jest.fn().mockReturnValue({
      onOpenFilesChanged: mockOnOpenFilesChanged.event,
      onFileLoadingChanged: mockOnFileLoadingChanged.event,
      preloadFrequentFiles: jest.fn().mockResolvedValue(undefined),
    }),
  },
}));

jest.mock('../services/FolderHistoryService', () => ({
  FolderHistoryService: {
    getInstance: jest.fn().mockReturnValue({
      recordVisit: jest.fn(),
      getFrequentFolders: jest.fn().mockReturnValue([]),
      getPreloadTargets: jest.fn().mockReturnValue([]),
    }),
  },
}));

jest.mock('../services/PriorityQueueService', () => ({
  PriorityQueueService: {
    getInstance: jest.fn().mockReturnValue({
      enqueue: mockEnqueue,
      cancelAll: jest.fn(),
      isConnectionCancelled: jest.fn().mockReturnValue(false),
      isPreloadingInProgress: jest.fn().mockReturnValue(false),
      resetConnection: jest.fn(),
      getStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0, byPriority: {} }),
    }),
  },
  PreloadPriority: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, IDLE: 4 },
}));

jest.mock('../services/ActivityService', () => ({
  ActivityService: {
    getInstance: jest.fn().mockReturnValue({
      startActivity: mockStartActivity,
      completeActivity: mockCompleteActivity,
      failActivity: mockFailActivity,
      cancelActivity: jest.fn(),
    }),
  },
}));

jest.mock('../utils/helpers', () => ({
  formatFileSize: jest.fn().mockReturnValue('1 KB'),
  formatRelativeTime: jest.fn().mockReturnValue('just now'),
  formatDateTime: jest.fn().mockReturnValue('2026-01-01 00:00'),
}));

// --- Import after mocks ---

import { FileTreeProvider, FilterMode } from './FileTreeProvider';
import { SSHFileDecorationProvider } from './FileDecorationProvider';


// ============================================================================
// Test helpers (standalone, mirror FileTreeProvider logic for pure unit tests)
// ============================================================================

type TestFilterMode = 'files' | 'folders' | 'both';

interface TestActiveFilter {
  pattern: string;
  basePath: string;
  connectionId: string;
  highlightedPaths: Set<string>;
  filterMode: TestFilterMode;
}

/** Mirror of FileTreeProvider.nameMatchesPattern */
function nameMatchesPattern(name: string, pattern: string): boolean {
  const hasGlob = pattern.includes('*') || pattern.includes('?');
  if (!hasGlob) return name.includes(pattern);
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    return new RegExp(`^${regexPattern}$`, 'i').test(name);
  } catch {
    return name.includes(pattern);
  }
}

/** Mirror of FileTreeProvider.shouldHighlightByFilter */
function shouldHighlightByFilter(filter: TestActiveFilter, file: IRemoteFile): boolean {
  if (!file.path.startsWith(filter.basePath)) return false;
  if (filter.filterMode === 'folders' && !file.isDirectory) return false;
  return nameMatchesPattern(file.name.toLowerCase(), filter.pattern);
}

/** Mirror of FileTreeProvider.matchesFilenameFilter (multi-filter) */
function matchesFilenameFilterMulti(
  connectionId: string,
  file: IRemoteFile,
  filters: TestActiveFilter[]
): boolean {
  for (const filter of filters) {
    if (filter.connectionId !== connectionId) continue;
    if (!file.path.startsWith(filter.basePath)) continue;
    if (filter.filterMode === 'files' && file.isDirectory) continue;
    if (filter.filterMode === 'folders' && !file.isDirectory) continue;
    if (!filter.highlightedPaths.has(file.path) && !shouldHighlightByFilter(filter, file)) {
      return false;
    }
  }
  return true;
}

/** Mirror of FileTreeProvider.isEmptyAfterFilter (multi-filter, with folder name check) */
function isEmptyAfterFilterMulti(
  folderPath: string,
  connectionId: string,
  filters: TestActiveFilter[]
): boolean {
  for (const filter of filters) {
    if (filter.connectionId !== connectionId) continue;
    if (!folderPath.startsWith(filter.basePath)) continue;
    if (folderPath === filter.basePath) continue;
    if (filter.highlightedPaths.has(folderPath)) continue;
    const folderName = folderPath.split('/').pop()?.toLowerCase() || '';
    if (nameMatchesPattern(folderName, filter.pattern)) continue;
    return true;
  }
  return false;
}

// File factory
function createFileInDir(name: string, dirPath: string, connectionId: string = 'conn1', isDirectory = false): IRemoteFile {
  return {
    name,
    path: `${dirPath}/${name}`,
    isDirectory,
    size: 1024,
    modifiedTime: Date.now(),
    connectionId,
  };
}


// ============================================================================
// Unit tests: nameMatchesPattern
// ============================================================================

describe('nameMatchesPattern', () => {
  it('should match substring (no glob)', () => {
    expect(nameMatchesPattern('rccron', 'cron')).toBe(true);
    expect(nameMatchesPattern('rccron', 'rc')).toBe(true);
    expect(nameMatchesPattern('rccron', 'rccron')).toBe(true);
    expect(nameMatchesPattern('rccron', 'xyz')).toBe(false);
  });

  it('should match glob patterns', () => {
    expect(nameMatchesPattern('config.ts', '*.ts')).toBe(true);
    expect(nameMatchesPattern('config.ts', '*.js')).toBe(false);
    expect(nameMatchesPattern('app.test.ts', '*test*')).toBe(true);
    expect(nameMatchesPattern('readme.md', 'read?e.md')).toBe(true);
  });

  it('should escape regex special characters in pattern', () => {
    expect(nameMatchesPattern('file(1).ts', 'file(1)')).toBe(true);
    expect(nameMatchesPattern('file+1.ts', 'file+1')).toBe(true);
  });

  it('should handle empty inputs', () => {
    expect(nameMatchesPattern('', '')).toBe(true);
    expect(nameMatchesPattern('file.ts', '')).toBe(true);
    expect(nameMatchesPattern('', 'test')).toBe(false);
  });
});


// ============================================================================
// Unit tests: shouldHighlightByFilter
// ============================================================================

describe('shouldHighlightByFilter', () => {
  const connId = 'conn1';
  const basePath = '/usr';

  const makeFilter = (pattern: string, mode: TestFilterMode = 'files'): TestActiveFilter => ({
    pattern: pattern.toLowerCase(),
    basePath,
    connectionId: connId,
    highlightedPaths: new Set([basePath]),
    filterMode: mode,
  });

  it('should highlight directory whose name matches pattern (Bug 1 fix)', () => {
    const dir = createFileInDir('rccron', basePath, connId, true);
    expect(shouldHighlightByFilter(makeFilter('cron'), dir)).toBe(true);
  });

  it('should highlight file whose name matches pattern', () => {
    const file = createFileInDir('cron.log', basePath, connId);
    expect(shouldHighlightByFilter(makeFilter('cron'), file)).toBe(true);
  });

  it('should not highlight items outside base path', () => {
    const file: IRemoteFile = {
      name: 'cron.log', path: '/var/log/cron.log',
      isDirectory: false, size: 100, modifiedTime: Date.now(), connectionId: connId,
    };
    expect(shouldHighlightByFilter(makeFilter('cron'), file)).toBe(false);
  });

  it('folders mode: should not highlight files', () => {
    const file = createFileInDir('cron.log', basePath, connId);
    expect(shouldHighlightByFilter(makeFilter('cron', 'folders'), file)).toBe(false);
  });

  it('folders mode: should highlight matching directories', () => {
    const dir = createFileInDir('rccron', basePath, connId, true);
    expect(shouldHighlightByFilter(makeFilter('cron', 'folders'), dir)).toBe(true);
  });

  it('both mode: should highlight matching files and directories', () => {
    const file = createFileInDir('cron.log', basePath, connId);
    const dir = createFileInDir('rccron', basePath, connId, true);
    const filter = makeFilter('cron', 'both');
    expect(shouldHighlightByFilter(filter, file)).toBe(true);
    expect(shouldHighlightByFilter(filter, dir)).toBe(true);
  });
});


// ============================================================================
// Unit tests: matchesFilenameFilter - filter modes
// ============================================================================

describe('matchesFilenameFilter - filter modes', () => {
  const connId = 'conn1';
  const basePath = '/usr';

  const makeFilter = (pattern: string, mode: TestFilterMode): TestActiveFilter => ({
    pattern: pattern.toLowerCase(),
    basePath,
    connectionId: connId,
    highlightedPaths: new Set([basePath]),
    filterMode: mode,
  });

  it('files mode: should always show directories', () => {
    const dir = createFileInDir('rccron', basePath, connId, true);
    expect(matchesFilenameFilterMulti(connId, dir, [makeFilter('cron', 'files')])).toBe(true);
  });

  it('files mode: should filter files by pattern', () => {
    const matching = createFileInDir('cron.log', basePath, connId);
    const nonMatching = createFileInDir('app.log', basePath, connId);
    const filter = makeFilter('cron', 'files');
    expect(matchesFilenameFilterMulti(connId, matching, [filter])).toBe(true);
    expect(matchesFilenameFilterMulti(connId, nonMatching, [filter])).toBe(false);
  });

  it('folders mode: should always show files', () => {
    const file = createFileInDir('app.log', basePath, connId);
    expect(matchesFilenameFilterMulti(connId, file, [makeFilter('cron', 'folders')])).toBe(true);
  });

  it('folders mode: should filter directories by pattern', () => {
    const matching = createFileInDir('rccron', basePath, connId, true);
    const nonMatching = createFileInDir('lib', basePath, connId, true);
    const filter = makeFilter('cron', 'folders');
    expect(matchesFilenameFilterMulti(connId, matching, [filter])).toBe(true);
    expect(matchesFilenameFilterMulti(connId, nonMatching, [filter])).toBe(false);
  });

  it('both mode: should filter files AND directories', () => {
    const matchingFile = createFileInDir('cron.log', basePath, connId);
    const matchingDir = createFileInDir('rccron', basePath, connId, true);
    const nonMatchingFile = createFileInDir('app.log', basePath, connId);
    const nonMatchingDir = createFileInDir('lib', basePath, connId, true);
    const filter = makeFilter('cron', 'both');

    expect(matchesFilenameFilterMulti(connId, matchingFile, [filter])).toBe(true);
    expect(matchesFilenameFilterMulti(connId, matchingDir, [filter])).toBe(true);
    expect(matchesFilenameFilterMulti(connId, nonMatchingFile, [filter])).toBe(false);
    expect(matchesFilenameFilterMulti(connId, nonMatchingDir, [filter])).toBe(false);
  });
});


// ============================================================================
// Unit tests: matchesFilenameFilter - multi-filter support
// ============================================================================

describe('matchesFilenameFilter - multi-filter support', () => {
  const connId = 'conn1';

  it('should apply multiple filters independently on different folders', () => {
    const filter1: TestActiveFilter = {
      pattern: 'cron', basePath: '/usr', connectionId: connId,
      highlightedPaths: new Set(['/usr']), filterMode: 'files',
    };
    const filter2: TestActiveFilter = {
      pattern: 'conf', basePath: '/etc', connectionId: connId,
      highlightedPaths: new Set(['/etc']), filterMode: 'files',
    };
    const filters = [filter1, filter2];

    expect(matchesFilenameFilterMulti(connId, createFileInDir('cron.log', '/usr', connId), filters)).toBe(true);
    expect(matchesFilenameFilterMulti(connId, createFileInDir('nginx.conf', '/etc', connId), filters)).toBe(true);
    expect(matchesFilenameFilterMulti(connId, createFileInDir('app.log', '/usr', connId), filters)).toBe(false);
    expect(matchesFilenameFilterMulti(connId, createFileInDir('hosts', '/etc', connId), filters)).toBe(false);
  });

  it('should not affect files outside all filter base paths', () => {
    const filter: TestActiveFilter = {
      pattern: 'cron', basePath: '/usr', connectionId: connId,
      highlightedPaths: new Set(['/usr']), filterMode: 'files',
    };
    expect(matchesFilenameFilterMulti(connId, createFileInDir('anything.log', '/var/log', connId), [filter])).toBe(true);
  });

  it('should not affect files from a different connection', () => {
    const filter: TestActiveFilter = {
      pattern: 'cron', basePath: '/usr', connectionId: 'conn1',
      highlightedPaths: new Set(['/usr']), filterMode: 'files',
    };
    expect(matchesFilenameFilterMulti('conn2', createFileInDir('app.log', '/usr', 'conn2'), [filter])).toBe(true);
  });

  it('should pass files when no filters exist', () => {
    expect(matchesFilenameFilterMulti(connId, createFileInDir('anything.log', '/usr', connId), [])).toBe(true);
  });
});


// ============================================================================
// Unit tests: isEmptyAfterFilter - folder name matching fix (Bug 1)
// ============================================================================

describe('isEmptyAfterFilter - folder name matching (Bug 1 fix)', () => {
  const connId = 'conn1';
  const basePath = '/usr';

  it('should NOT gray out folder "rccron" when filtering "cron"', () => {
    const filters: TestActiveFilter[] = [{
      pattern: 'cron', basePath, connectionId: connId,
      highlightedPaths: new Set([basePath]), filterMode: 'files',
    }];
    expect(isEmptyAfterFilterMulti('/usr/rccron', connId, filters)).toBe(false);
  });

  it('should still gray out folder "lib" when filtering "cron"', () => {
    const filters: TestActiveFilter[] = [{
      pattern: 'cron', basePath, connectionId: connId,
      highlightedPaths: new Set([basePath]), filterMode: 'files',
    }];
    expect(isEmptyAfterFilterMulti('/usr/lib', connId, filters)).toBe(true);
  });

  it('should NOT gray out folder in highlightedPaths even if name does not match', () => {
    const filters: TestActiveFilter[] = [{
      pattern: 'cron', basePath, connectionId: connId,
      highlightedPaths: new Set([basePath, '/usr/lib']), filterMode: 'files',
    }];
    expect(isEmptyAfterFilterMulti('/usr/lib', connId, filters)).toBe(false);
  });

  it('should NOT gray out the base path itself', () => {
    const filters: TestActiveFilter[] = [{
      pattern: 'cron', basePath, connectionId: connId,
      highlightedPaths: new Set([basePath]), filterMode: 'files',
    }];
    expect(isEmptyAfterFilterMulti(basePath, connId, filters)).toBe(false);
  });

  it('should match folder names with glob patterns', () => {
    const filters: TestActiveFilter[] = [{
      pattern: 'rc*', basePath, connectionId: connId,
      highlightedPaths: new Set([basePath]), filterMode: 'files',
    }];
    expect(isEmptyAfterFilterMulti('/usr/rccron', connId, filters)).toBe(false);
    expect(isEmptyAfterFilterMulti('/usr/lib', connId, filters)).toBe(true);
  });
});

describe('isEmptyAfterFilter - multi-filter', () => {
  const connId = 'conn1';

  it('should check all applicable filters', () => {
    const filters: TestActiveFilter[] = [
      {
        pattern: 'cron', basePath: '/usr', connectionId: connId,
        highlightedPaths: new Set(['/usr', '/usr/share']), filterMode: 'files',
      },
      {
        pattern: 'conf', basePath: '/etc', connectionId: connId,
        highlightedPaths: new Set(['/etc', '/etc/nginx']), filterMode: 'files',
      },
    ];

    expect(isEmptyAfterFilterMulti('/usr/share', connId, filters)).toBe(false); // highlighted
    expect(isEmptyAfterFilterMulti('/usr/lib', connId, filters)).toBe(true);    // not highlighted, name doesn't match
    expect(isEmptyAfterFilterMulti('/etc/nginx', connId, filters)).toBe(false);  // highlighted
    expect(isEmptyAfterFilterMulti('/etc/systemd', connId, filters)).toBe(true); // not highlighted, name doesn't match
  });

  it('should not affect folders outside any filter base path', () => {
    const filters: TestActiveFilter[] = [{
      pattern: 'cron', basePath: '/usr', connectionId: connId,
      highlightedPaths: new Set(['/usr']), filterMode: 'files',
    }];
    expect(isEmptyAfterFilterMulti('/var/log/subdir', connId, filters)).toBe(false);
  });
});


// ============================================================================
// Integration tests: FileTreeProvider instance-level filter API
// ============================================================================

describe('FileTreeProvider - multi-filter state management', () => {
  let provider: FileTreeProvider;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockGetAllConnections.mockReturnValue([]);
    mockGetAllConnectionsWithReconnecting.mockReturnValue({ active: [], reconnecting: [] });
    provider = new FileTreeProvider();
  });

  afterEach(() => {
    provider.dispose();
    jest.useRealTimers();
  });

  describe('hasFilenameFilter / isFilteredFolder', () => {
    it('should report no filter when empty', () => {
      expect(provider.hasFilenameFilter()).toBe(false);
    });

    it('should report filter after setFilenameFilter', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([
        { path: '/usr/cron.log', lineNumber: 0, lineContent: '', isDirectory: false },
      ]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      expect(provider.hasFilenameFilter()).toBe(true);
      expect(provider.isFilteredFolder('conn-1', '/usr')).toBe(true);
      expect(provider.isFilteredFolder('conn-1', '/etc')).toBe(false);
    });

    it('should support multiple simultaneous filters (Bug 2 fix)', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      await provider.setFilenameFilter('conf', '/etc', mockConn as any);

      expect(provider.hasFilenameFilter()).toBe(true);
      expect(provider.isFilteredFolder('conn-1', '/usr')).toBe(true);
      expect(provider.isFilteredFolder('conn-1', '/etc')).toBe(true);
    });
  });

  describe('clearFilenameFilter', () => {
    it('should clear all filters when no key provided', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      await provider.setFilenameFilter('conf', '/etc', mockConn as any);
      provider.clearFilenameFilter();

      expect(provider.hasFilenameFilter()).toBe(false);
      expect(provider.isFilteredFolder('conn-1', '/usr')).toBe(false);
      expect(provider.isFilteredFolder('conn-1', '/etc')).toBe(false);
    });

    it('should clear specific filter when key provided', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      await provider.setFilenameFilter('conf', '/etc', mockConn as any);
      provider.clearFilenameFilter('conn-1:/usr');

      expect(provider.hasFilenameFilter()).toBe(true);
      expect(provider.isFilteredFolder('conn-1', '/usr')).toBe(false);
      expect(provider.isFilteredFolder('conn-1', '/etc')).toBe(true);
    });

    it('should invoke onFilterCleared callback when last filter is cleared', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      const callback = jest.fn();
      provider.setOnFilterCleared(callback);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      provider.clearFilenameFilter('conn-1:/usr');

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it('should NOT invoke callback when filters still remain', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      const callback = jest.fn();
      provider.setOnFilterCleared(callback);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      await provider.setFilenameFilter('conf', '/etc', mockConn as any);
      provider.clearFilenameFilter('conn-1:/usr');

      expect(callback).not.toHaveBeenCalled();
    });
  });

  describe('setFilenameFilter with empty pattern', () => {
    it('should clear the filter for that folder', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      expect(provider.isFilteredFolder('conn-1', '/usr')).toBe(true);

      await provider.setFilenameFilter('', '/usr', mockConn as any);
      expect(provider.isFilteredFolder('conn-1', '/usr')).toBe(false);
    });
  });

  describe('getFilenameFilterState', () => {
    it('should return empty array when no filters', () => {
      expect(provider.getFilenameFilterState()).toEqual([]);
    });

    it('should return all active filter states', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([
        { path: '/usr/cron.log', lineNumber: 0, lineContent: '', isDirectory: false },
      ]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);

      const states = provider.getFilenameFilterState();
      expect(states).toHaveLength(1);
      expect(states[0].basePath).toBe('/usr');
      expect(states[0].connectionId).toBe('conn-1');
      expect(states[0].highlightedPaths).toBeInstanceOf(Set);
    });

    it('should return multiple states for multiple filters', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      await provider.setFilenameFilter('conf', '/etc', mockConn as any);

      const states = provider.getFilenameFilterState();
      expect(states).toHaveLength(2);
      const basePaths = states.map(s => s.basePath).sort();
      expect(basePaths).toEqual(['/etc', '/usr']);
    });
  });

  describe('getFilenameFilterPattern', () => {
    it('should return empty string when no filters', () => {
      expect(provider.getFilenameFilterPattern()).toBe('');
    });

    it('should return specific filter pattern when key provided', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      expect(provider.getFilenameFilterPattern('conn-1', '/usr')).toBe('cron');
    });

    it('should return first filter pattern when no key provided', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      expect(provider.getFilenameFilterPattern()).toBe('cron');
    });
  });

  describe('getMatchCount', () => {
    it('should return 0 when no filters', () => {
      expect(provider.getMatchCount('conn-1', '/usr')).toBe(0);
    });

    it('should return correct match counts for folders', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([
        { path: '/usr/share/cron.log', lineNumber: 0, lineContent: '', isDirectory: false },
        { path: '/usr/share/crontab', lineNumber: 0, lineContent: '', isDirectory: false },
        { path: '/usr/lib/cron.d', lineNumber: 0, lineContent: '', isDirectory: false },
      ]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);

      expect(provider.getMatchCount('conn-1', '/usr/share')).toBe(2);
      expect(provider.getMatchCount('conn-1', '/usr/lib')).toBe(1);
      expect(provider.getMatchCount('conn-1', '/usr')).toBe(3);
    });

    it('should sum counts across multiple filters for same connection', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles
        .mockResolvedValueOnce([
          { path: '/usr/share/cron.log', lineNumber: 0, lineContent: '', isDirectory: false },
        ])
        .mockResolvedValueOnce([
          { path: '/usr/share/test.log', lineNumber: 0, lineContent: '', isDirectory: false },
        ]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      await provider.setFilenameFilter('test', '/usr/share', mockConn as any);

      // /usr/share: 1 from cron filter + 1 from test filter
      expect(provider.getMatchCount('conn-1', '/usr/share')).toBe(2);
    });
  });

  describe('isHighlighted', () => {
    it('should return false when no filters', () => {
      expect(provider.isHighlighted('/usr/cron.log')).toBe(false);
    });

    it('should return true for highlighted paths', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([
        { path: '/usr/cron.log', lineNumber: 0, lineContent: '', isDirectory: false },
      ]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      expect(provider.isHighlighted('/usr/cron.log')).toBe(true);
      expect(provider.isHighlighted('/usr/app.log')).toBe(false);
    });
  });

  describe('isEmptyAfterFilter (Bug 1: folder name matching)', () => {
    it('should return false when no filters', () => {
      expect(provider.isEmptyAfterFilter('conn-1', '/usr/lib')).toBe(false);
    });

    it('should return true for non-highlighted, non-matching folders', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([
        { path: '/usr/share/cron.log', lineNumber: 0, lineContent: '', isDirectory: false },
      ]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      expect(provider.isEmptyAfterFilter('conn-1', '/usr/lib')).toBe(true);
      expect(provider.isEmptyAfterFilter('conn-1', '/usr/share')).toBe(false);
    });

    it('should NOT gray out folder whose name matches pattern (Bug 1)', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      // find only returns files, NOT the directory "rccron" itself
      mockConn.searchFiles.mockResolvedValue([
        { path: '/usr/rccron/crontab', lineNumber: 0, lineContent: '', isDirectory: false },
      ]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      // rccron folder name contains "cron" → should NOT be grayed out
      expect(provider.isEmptyAfterFilter('conn-1', '/usr/rccron')).toBe(false);
      // lib folder name doesn't match "cron" → should be grayed out
      expect(provider.isEmptyAfterFilter('conn-1', '/usr/lib')).toBe(true);
    });

    it('should NOT gray out the base path itself', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      expect(provider.isEmptyAfterFilter('conn-1', '/usr')).toBe(false);
    });
  });

  describe('filter mode passed to searchFiles', () => {
    it('should pass findType "f" for files mode', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any, 'files');
      expect(mockConn.searchFiles).toHaveBeenCalledWith('/usr', 'cron', expect.objectContaining({ findType: 'f' }));
    });

    it('should pass findType "d" for folders mode', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any, 'folders');
      expect(mockConn.searchFiles).toHaveBeenCalledWith('/usr', 'cron', expect.objectContaining({ findType: 'd' }));
    });

    it('should pass findType "both" for both mode', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any, 'both');
      expect(mockConn.searchFiles).toHaveBeenCalledWith('/usr', 'cron', expect.objectContaining({ findType: 'both' }));
    });

    it('should default to files mode', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.searchFiles.mockResolvedValue([]);

      await provider.setFilenameFilter('cron', '/usr', mockConn as any);
      expect(mockConn.searchFiles).toHaveBeenCalledWith('/usr', 'cron', expect.objectContaining({ findType: 'f' }));
    });
  });
});


// ============================================================================
// FileDecorationProvider multi-filter tests
// ============================================================================

function createMockFileServiceForDeco() {
  return {
    getTempDir: jest.fn().mockReturnValue('/tmp/ssh-lite'),
    getFileMapping: jest.fn().mockReturnValue(undefined),
    isFileUploading: jest.fn().mockReturnValue(false),
    isFileUploadFailed: jest.fn().mockReturnValue(false),
    onFileMappingsChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    onUploadStateChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  };
}

function createMockConnManagerForDeco() {
  return {
    getConnection: jest.fn().mockReturnValue(undefined),
    onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    onConnectionStateChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  };
}

describe('SSHFileDecorationProvider - multi-filter support', () => {
  let decoProvider: SSHFileDecorationProvider;

  function sshUri(authority: string, uriPath: string) {
    return { scheme: 'ssh', authority, path: uriPath, toString: () => `ssh://${authority}${uriPath}` } as any;
  }

  beforeEach(() => {
    const fs = createMockFileServiceForDeco();
    const cm = createMockConnManagerForDeco();
    decoProvider = new SSHFileDecorationProvider(fs as any, cm as any);
  });

  afterEach(() => {
    decoProvider.dispose();
  });

  it('should highlight multiple filtered folders simultaneously', () => {
    decoProvider.setFilteredFolder('host:22:user', '/var/log');
    decoProvider.setFilteredFolder('host:22:user', '/etc');

    const uri1 = sshUri('host:22:user', '/var/log');
    const uri2 = sshUri('host:22:user', '/etc');

    expect(decoProvider.provideFileDecoration(uri1)?.badge).toBe('F');
    expect(decoProvider.provideFileDecoration(uri2)?.badge).toBe('F');
  });

  it('should clear specific filtered folder', () => {
    decoProvider.setFilteredFolder('host:22:user', '/var/log');
    decoProvider.setFilteredFolder('host:22:user', '/etc');

    decoProvider.clearFilteredFolder('host:22:user', '/var/log');

    const uri1 = sshUri('host:22:user', '/var/log');
    const uri2 = sshUri('host:22:user', '/etc');

    expect(decoProvider.provideFileDecoration(uri1)).toBeUndefined();
    expect(decoProvider.provideFileDecoration(uri2)?.badge).toBe('F');
  });

  it('should clear all filters', () => {
    decoProvider.setFilteredFolder('host:22:user', '/var/log');
    decoProvider.setFilteredFolder('host:22:user', '/etc');

    decoProvider.clearFilteredFolder();

    expect(decoProvider.provideFileDecoration(sshUri('host:22:user', '/var/log'))).toBeUndefined();
    expect(decoProvider.provideFileDecoration(sshUri('host:22:user', '/etc'))).toBeUndefined();
  });

  it('should support additive setFilenameFilterPaths', () => {
    const highlighted1 = new Set(['/var/log', '/var/log/app']);
    const highlighted2 = new Set(['/etc', '/etc/nginx']);

    decoProvider.setFilenameFilterPaths(highlighted1, '/var/log', 'host:22:user');
    decoProvider.setFilenameFilterPaths(highlighted2, '/etc', 'host:22:user');

    // Empty folder under /var/log filter
    const emptyUri = sshUri('host:22:user', '/var/log/empty');
    const deco = decoProvider.provideFileDecoration(emptyUri);
    expect(deco).toBeDefined();
    expect(deco!.tooltip).toBe('Not matching filter');

    // Highlighted folder under /etc filter
    const nginxUri = sshUri('host:22:user', '/etc/nginx');
    expect(decoProvider.provideFileDecoration(nginxUri)).toBeUndefined(); // highlighted = no gray
  });

  it('rebuildFilterState should reset and rebuild', () => {
    // Set initial state
    decoProvider.setFilteredFolder('host:22:user', '/var/log');
    decoProvider.setFilenameFilterPaths(new Set(['/var/log']), '/var/log', 'host:22:user');

    // Rebuild with different state
    decoProvider.rebuildFilterState([
      {
        highlightedPaths: new Set(['/etc', '/etc/nginx']),
        basePath: '/etc',
        connectionId: 'host:22:user',
      },
    ]);

    // Old state should be gone
    expect(decoProvider.provideFileDecoration(sshUri('host:22:user', '/var/log'))).toBeUndefined();
    // New state should be active
    expect(decoProvider.provideFileDecoration(sshUri('host:22:user', '/etc'))?.badge).toBe('F');
  });
});
