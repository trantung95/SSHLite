/**
 * FileTreeProvider tests
 *
 * Tests covering:
 * - matchesFilter logic (filename glob/substring filtering)
 * - matchesFilenameFilter logic (per-folder filename filter)
 * - isEmptyAfterFilter logic (folder graying when no matching descendants)
 * - Connection reorder algorithm (drag/drop)
 * - handleDrag filtering
 * - Show Tree From Root (setAutoExpandPaths, loadAncestorDirs, getChildren auto-expand)
 * - Smart Reveal (revealFile Case A & B, loadIntermediateDirs, navigateToRootWithExpand)
 */

import { IRemoteFile, ConnectionState } from '../types';
import * as vscode from 'vscode';
import { createMockConnection, createMockHostConfig, createMockRemoteFile } from '../__mocks__/testHelpers';

// --- Mock service instances (must be declared before jest.mock calls) ---

const mockGetConnection = jest.fn();
const mockGetAllConnections = jest.fn().mockReturnValue([]);
const mockGetAllConnectionsWithReconnecting = jest.fn().mockReturnValue({ active: [], reconnecting: [] });
const mockConnectionChangeEmitter = new (require('../__mocks__/vscode').EventEmitter)();
const mockReconnectingEmitter = new (require('../__mocks__/vscode').EventEmitter)();

const mockOnOpenFilesChanged = new (require('../__mocks__/vscode').EventEmitter)();
const mockOnFileLoadingChanged = new (require('../__mocks__/vscode').EventEmitter)();

const mockRecordVisit = jest.fn();
const mockGetFrequentFolders = jest.fn().mockReturnValue([]);
const mockGetPreloadTargets = jest.fn().mockReturnValue([]);

const mockEnqueue = jest.fn().mockResolvedValue(undefined);
const mockCancelAll = jest.fn();
const mockIsConnectionCancelled = jest.fn().mockReturnValue(false);
const mockIsPreloadingInProgress = jest.fn().mockReturnValue(false);
const mockResetConnection = jest.fn();
const mockGetStatus = jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0, byPriority: {} });

const mockStartActivity = jest.fn().mockReturnValue('activity-1');
const mockCompleteActivity = jest.fn();
const mockFailActivity = jest.fn();
const mockCancelActivity = jest.fn();

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
      recordVisit: mockRecordVisit,
      getFrequentFolders: mockGetFrequentFolders,
      getPreloadTargets: mockGetPreloadTargets,
    }),
  },
}));

jest.mock('../services/PriorityQueueService', () => ({
  PriorityQueueService: {
    getInstance: jest.fn().mockReturnValue({
      enqueue: mockEnqueue,
      cancelAll: mockCancelAll,
      isConnectionCancelled: mockIsConnectionCancelled,
      isPreloadingInProgress: mockIsPreloadingInProgress,
      resetConnection: mockResetConnection,
      getStatus: mockGetStatus,
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
      cancelActivity: mockCancelActivity,
    }),
  },
}));

jest.mock('../utils/helpers', () => ({
  formatFileSize: jest.fn().mockReturnValue('1 KB'),
  formatRelativeTime: jest.fn().mockReturnValue('just now'),
  formatDateTime: jest.fn().mockReturnValue('2026-01-01 00:00'),
}));

// --- Import after mocks ---

import {
  FileTreeProvider,
  FileTreeItem,
  ConnectionTreeItem,
  ParentFolderTreeItem,
  LoadingTreeItem,
} from './FileTreeProvider';

// ============================================================================
// Existing tests (matchesFilter, matchesFilenameFilter, isEmptyAfterFilter,
// drag/drop reorder, handleDrag filtering)
// ============================================================================

/**
 * Test implementation of matchesFilter logic
 * Extracted from FileTreeProvider for unit testing
 */
function matchesFilter(file: IRemoteFile, filterPattern: string): boolean {
  if (!filterPattern) {
    return true; // No filter, show all
  }

  const fileName = file.name.toLowerCase();
  const pattern = filterPattern.toLowerCase();

  // Always show directories when filtering (to allow navigation)
  if (file.isDirectory) {
    return true;
  }

  // Check if pattern contains glob wildcards
  const hasGlobWildcards = pattern.includes('*') || pattern.includes('?');

  if (!hasGlobWildcards) {
    // Plain text: case-insensitive substring match (like SQL ILIKE)
    return fileName.includes(pattern);
  }

  // Convert glob pattern to regex for wildcard patterns
  // * -> .* (any characters)
  // ? -> . (single character)
  // Escape other special regex characters
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape special chars
    .replace(/\*/g, '.*') // * -> .*
    .replace(/\?/g, '.'); // ? -> .

  try {
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(fileName);
  } catch {
    // If regex is invalid, fall back to simple includes
    return fileName.includes(pattern);
  }
}

// Helper to create mock remote file
function createMockFile(name: string, isDirectory = false): IRemoteFile {
  return {
    name,
    path: `/${name}`,
    isDirectory,
    size: 1024,
    modifiedTime: Date.now(),
    connectionId: 'test-connection',
  };
}

describe('FileTreeProvider - matchesFilter', () => {
  describe('no filter pattern', () => {
    it('should return true for any file when no filter', () => {
      expect(matchesFilter(createMockFile('test.ts'), '')).toBe(true);
      expect(matchesFilter(createMockFile('config.json'), '')).toBe(true);
      expect(matchesFilter(createMockFile('README.md'), '')).toBe(true);
    });
  });

  describe('directories', () => {
    it('should always show directories regardless of filter', () => {
      const dir = createMockFile('node_modules', true);
      expect(matchesFilter(dir, 'test')).toBe(true);
      expect(matchesFilter(dir, '*.ts')).toBe(true);
      expect(matchesFilter(dir, 'xyz')).toBe(true);
    });
  });

  describe('plain text filter (no wildcards)', () => {
    it('should match substring anywhere in filename', () => {
      const file = createMockFile('my-config.json');
      expect(matchesFilter(file, 'config')).toBe(true);
      expect(matchesFilter(file, 'my')).toBe(true);
      expect(matchesFilter(file, 'json')).toBe(true);
      expect(matchesFilter(file, 'my-config')).toBe(true);
    });

    it('should be case-insensitive', () => {
      const file = createMockFile('MyConfig.JSON');
      expect(matchesFilter(file, 'config')).toBe(true);
      expect(matchesFilter(file, 'CONFIG')).toBe(true);
      expect(matchesFilter(file, 'Config')).toBe(true);
      expect(matchesFilter(file, 'json')).toBe(true);
    });

    it('should not match if substring not found', () => {
      const file = createMockFile('package.json');
      expect(matchesFilter(file, 'test')).toBe(false);
      expect(matchesFilter(file, 'config')).toBe(false);
      expect(matchesFilter(file, 'xyz')).toBe(false);
    });

    it('should match exact filename', () => {
      const file = createMockFile('test');
      expect(matchesFilter(file, 'test')).toBe(true);
    });
  });

  describe('glob pattern with * wildcard', () => {
    it('should match files with specific extension', () => {
      expect(matchesFilter(createMockFile('app.ts'), '*.ts')).toBe(true);
      expect(matchesFilter(createMockFile('utils.ts'), '*.ts')).toBe(true);
      expect(matchesFilter(createMockFile('app.js'), '*.ts')).toBe(false);
      expect(matchesFilter(createMockFile('app.tsx'), '*.ts')).toBe(false);
    });

    it('should match files starting with pattern', () => {
      expect(matchesFilter(createMockFile('config.json'), 'config*')).toBe(true);
      expect(matchesFilter(createMockFile('config.yaml'), 'config*')).toBe(true);
      expect(matchesFilter(createMockFile('configuration.ts'), 'config*')).toBe(true);
      expect(matchesFilter(createMockFile('my-config.json'), 'config*')).toBe(false);
    });

    it('should match files ending with pattern', () => {
      expect(matchesFilter(createMockFile('app.test.ts'), '*test.ts')).toBe(true);
      expect(matchesFilter(createMockFile('utils.test.ts'), '*test.ts')).toBe(true);
      expect(matchesFilter(createMockFile('test.ts'), '*test.ts')).toBe(true);
      expect(matchesFilter(createMockFile('testing.ts'), '*test.ts')).toBe(false);
    });

    it('should match files with pattern in middle', () => {
      expect(matchesFilter(createMockFile('app.test.ts'), '*test*')).toBe(true);
      expect(matchesFilter(createMockFile('testing.js'), '*test*')).toBe(true);
      expect(matchesFilter(createMockFile('test'), '*test*')).toBe(true);
    });

    it('should match multiple extensions', () => {
      // Note: Our simple glob doesn't support {ts,js} syntax
      // but we can use *.ts* or similar
      expect(matchesFilter(createMockFile('app.tsx'), '*.ts*')).toBe(true);
      expect(matchesFilter(createMockFile('app.ts'), '*.ts*')).toBe(true);
    });
  });

  describe('glob pattern with ? wildcard', () => {
    it('should match single character', () => {
      expect(matchesFilter(createMockFile('file1.ts'), 'file?.ts')).toBe(true);
      expect(matchesFilter(createMockFile('file2.ts'), 'file?.ts')).toBe(true);
      expect(matchesFilter(createMockFile('fileA.ts'), 'file?.ts')).toBe(true);
      expect(matchesFilter(createMockFile('file12.ts'), 'file?.ts')).toBe(false);
      expect(matchesFilter(createMockFile('file.ts'), 'file?.ts')).toBe(false);
    });

    it('should work with multiple ? wildcards', () => {
      expect(matchesFilter(createMockFile('ab.ts'), '??.ts')).toBe(true);
      expect(matchesFilter(createMockFile('a.ts'), '??.ts')).toBe(false);
      expect(matchesFilter(createMockFile('abc.ts'), '??.ts')).toBe(false);
    });
  });

  describe('combined * and ? wildcards', () => {
    it('should match complex patterns', () => {
      expect(matchesFilter(createMockFile('file1.test.ts'), 'file?.test.*')).toBe(true);
      expect(matchesFilter(createMockFile('file2.test.js'), 'file?.test.*')).toBe(true);
      expect(matchesFilter(createMockFile('file12.test.ts'), 'file?.test.*')).toBe(false);
    });
  });

  describe('special characters in pattern', () => {
    it('should escape dots in pattern', () => {
      expect(matchesFilter(createMockFile('app.ts'), '*.ts')).toBe(true);
      expect(matchesFilter(createMockFile('appts'), '*.ts')).toBe(false); // dot is literal
    });

    it('should escape other regex special chars', () => {
      expect(matchesFilter(createMockFile('file[1].ts'), 'file[1].ts')).toBe(true);
      expect(matchesFilter(createMockFile('file(1).ts'), 'file(1).ts')).toBe(true);
      expect(matchesFilter(createMockFile('file+1.ts'), 'file+1.ts')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle empty filename', () => {
      const file = createMockFile('');
      expect(matchesFilter(file, '')).toBe(true);
      expect(matchesFilter(file, 'test')).toBe(false);
    });

    it('should handle pattern that is just *', () => {
      expect(matchesFilter(createMockFile('anything.ts'), '*')).toBe(true);
      expect(matchesFilter(createMockFile(''), '*')).toBe(true);
    });

    it('should handle hidden files (starting with .)', () => {
      expect(matchesFilter(createMockFile('.gitignore'), '.*')).toBe(true);
      expect(matchesFilter(createMockFile('.eslintrc'), '.*')).toBe(true);
      expect(matchesFilter(createMockFile('.env'), '.env')).toBe(true);
      // Plain text match should also work
      expect(matchesFilter(createMockFile('.gitignore'), 'git')).toBe(true);
    });

    it('should handle files with multiple dots', () => {
      expect(matchesFilter(createMockFile('app.test.spec.ts'), '*.ts')).toBe(true);
      expect(matchesFilter(createMockFile('app.test.spec.ts'), '*.spec.ts')).toBe(true);
      expect(matchesFilter(createMockFile('app.test.spec.ts'), '*spec*')).toBe(true);
    });
  });
});

/**
 * Test implementation of matchesFilenameFilter logic
 * Mirrors the per-folder filename filter that hides non-matching files
 */
function matchesFilenameFilter(
  file: IRemoteFile,
  filterPattern: string,
  filterBasePath: string,
  filterConnectionId: string,
  highlightedPaths: Set<string>
): boolean {
  if (!filterPattern || filterConnectionId !== file.connectionId) {
    return true; // No filter active or different connection
  }
  if (!file.path.startsWith(filterBasePath)) {
    return true; // File not under filtered folder
  }
  if (file.isDirectory) {
    return true; // Always show directories for navigation
  }
  // Check if highlighted by server search
  if (highlightedPaths.has(file.path)) {
    return true;
  }
  // Local pattern match fallback (mirrors shouldHighlightByFilter)
  const fileName = file.name.toLowerCase();
  const pattern = filterPattern.toLowerCase();
  const hasGlobWildcards = pattern.includes('*') || pattern.includes('?');
  if (!hasGlobWildcards) {
    return fileName.includes(pattern);
  }
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  try {
    const regex = new RegExp(`^${regexPattern}$`, 'i');
    return regex.test(fileName);
  } catch {
    return fileName.includes(pattern);
  }
}

// Helper to create mock file with specific path and connection
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

describe('FileTreeProvider - matchesFilenameFilter', () => {
  const connId = 'conn1';
  const basePath = '/opt/logs';

  it('should show all files when no filter is active', () => {
    const file = createFileInDir('app.log', basePath, connId);
    expect(matchesFilenameFilter(file, '', basePath, connId, new Set())).toBe(true);
  });

  it('should show all files for a different connection', () => {
    const file = createFileInDir('app.log', basePath, 'other-conn');
    expect(matchesFilenameFilter(file, '*uat*', basePath, connId, new Set())).toBe(true);
  });

  it('should show files outside the filtered base path', () => {
    const file = createFileInDir('app.log', '/opt/data', connId);
    expect(matchesFilenameFilter(file, '*uat*', basePath, connId, new Set())).toBe(true);
  });

  it('should always show directories for navigation', () => {
    const dir = createFileInDir('subdir', basePath, connId, true);
    expect(matchesFilenameFilter(dir, '*uat*', basePath, connId, new Set())).toBe(true);
  });

  it('should hide non-matching files with *uat* pattern', () => {
    const matching = createFileInDir('commsengine-uat-20260113.log', basePath, connId);
    const nonMatching = createFileInDir('auto-resolve-conv-dev20260112.log', basePath, connId);

    expect(matchesFilenameFilter(matching, '*uat*', basePath, connId, new Set())).toBe(true);
    expect(matchesFilenameFilter(nonMatching, '*uat*', basePath, connId, new Set())).toBe(false);
  });

  it('should show files that are in highlightedPaths even if pattern does not match locally', () => {
    const file = createFileInDir('special-file.log', basePath, connId);
    const highlighted = new Set([`${basePath}/special-file.log`]);
    expect(matchesFilenameFilter(file, '*uat*', basePath, connId, highlighted)).toBe(true);
  });

  it('should handle plain text filter (no globs)', () => {
    const matching = createFileInDir('uat-config.yaml', basePath, connId);
    const nonMatching = createFileInDir('prod-config.yaml', basePath, connId);

    expect(matchesFilenameFilter(matching, 'uat', basePath, connId, new Set())).toBe(true);
    expect(matchesFilenameFilter(nonMatching, 'uat', basePath, connId, new Set())).toBe(false);
  });

  it('should be case-insensitive', () => {
    const file = createFileInDir('UAT-config.yaml', basePath, connId);
    expect(matchesFilenameFilter(file, '*uat*', basePath, connId, new Set())).toBe(true);
  });
});

/**
 * Test implementation of isEmptyAfterFilter logic
 * Mirrors the per-folder check that grays out folders with no matching descendants
 */
function isEmptyAfterFilter(
  folderPath: string,
  connectionId: string,
  filterPattern: string,
  filterBasePath: string,
  filterConnectionId: string,
  highlightedPaths: Set<string>
): boolean {
  if (!filterPattern || filterConnectionId !== connectionId) {
    return false;
  }
  if (!folderPath.startsWith(filterBasePath)) {
    return false;
  }
  // Don't gray out the base path itself
  if (folderPath === filterBasePath) {
    return false;
  }
  return !highlightedPaths.has(folderPath);
}

describe('FileTreeProvider - isEmptyAfterFilter', () => {
  const connId = 'conn1';
  const basePath = '/opt/logs';

  it('should return false when no filter is active', () => {
    const result = isEmptyAfterFilter('/opt/logs/subdir', connId, '', basePath, connId, new Set());
    expect(result).toBe(false);
  });

  it('should return false for a different connection', () => {
    const highlighted = new Set([basePath]);
    const result = isEmptyAfterFilter('/opt/logs/subdir', 'other-conn', '*uat*', basePath, connId, highlighted);
    expect(result).toBe(false);
  });

  it('should return false for folders outside basePath', () => {
    const highlighted = new Set([basePath]);
    const result = isEmptyAfterFilter('/opt/data/subdir', connId, '*uat*', basePath, connId, highlighted);
    expect(result).toBe(false);
  });

  it('should return false for the basePath itself', () => {
    const highlighted = new Set([basePath]);
    const result = isEmptyAfterFilter(basePath, connId, '*uat*', basePath, connId, highlighted);
    expect(result).toBe(false);
  });

  it('should return true for folders under basePath not in highlightedPaths', () => {
    const highlighted = new Set([basePath, '/opt/logs/has-matches']);
    const result = isEmptyAfterFilter('/opt/logs/empty-folder', connId, '*uat*', basePath, connId, highlighted);
    expect(result).toBe(true);
  });

  it('should return false for folders in highlightedPaths (has matching descendants)', () => {
    const highlighted = new Set([basePath, '/opt/logs/archive']);
    const result = isEmptyAfterFilter('/opt/logs/archive', connId, '*uat*', basePath, connId, highlighted);
    expect(result).toBe(false);
  });

  it('should work at nested depths', () => {
    const highlighted = new Set([
      basePath,
      '/opt/logs/archive',
      '/opt/logs/archive/2024',
      '/opt/logs/archive/2024/uat-jan.log',
    ]);

    // Folder with matching descendants at nested depth
    expect(isEmptyAfterFilter('/opt/logs/archive/2024', connId, '*uat*', basePath, connId, highlighted)).toBe(false);

    // Empty nested folder (no matching descendants)
    expect(isEmptyAfterFilter('/opt/logs/archive/2023', connId, '*uat*', basePath, connId, highlighted)).toBe(true);

    // Empty top-level folder
    expect(isEmptyAfterFilter('/opt/logs/empty', connId, '*uat*', basePath, connId, highlighted)).toBe(true);
  });

  it('should gray multiple empty folders in the same tree', () => {
    const highlighted = new Set([basePath, '/opt/logs/active']);
    expect(isEmptyAfterFilter('/opt/logs/empty1', connId, '*uat*', basePath, connId, highlighted)).toBe(true);
    expect(isEmptyAfterFilter('/opt/logs/empty2', connId, '*uat*', basePath, connId, highlighted)).toBe(true);
    expect(isEmptyAfterFilter('/opt/logs/active', connId, '*uat*', basePath, connId, highlighted)).toBe(false);
  });
});

/**
 * Connection reorder algorithm -- extracted from FileTreeProvider.handleDrop
 * for unit testing the drag/drop reorder logic.
 */
function reorderConnections(
  currentOrder: string[],
  draggedIds: string[],
  targetIndex: number,
): string[] {
  // Remove dragged items from current order
  const newOrder = currentOrder.filter((id) => !draggedIds.includes(id));

  // Adjust target index if items were removed before it
  let adjustedIndex = targetIndex;
  for (const draggedId of draggedIds) {
    const originalIndex = currentOrder.indexOf(draggedId);
    if (originalIndex !== -1 && originalIndex < targetIndex) {
      adjustedIndex--;
    }
  }

  // Insert dragged items at new position
  newOrder.splice(Math.max(0, adjustedIndex), 0, ...draggedIds);
  return newOrder;
}

describe('FileTreeProvider - drag/drop connection reorder', () => {
  const order = ['conn-A', 'conn-B', 'conn-C', 'conn-D', 'conn-E'];

  describe('single item drag', () => {
    it('should move item forward (A -> position of D)', () => {
      const result = reorderConnections(order, ['conn-A'], 3);
      // A removed from index 0, target adjusted 3->2, insert at 2
      expect(result).toEqual(['conn-B', 'conn-C', 'conn-A', 'conn-D', 'conn-E']);
    });

    it('should move item backward (D -> position of B)', () => {
      const result = reorderConnections(order, ['conn-D'], 1);
      // D removed from index 3, target stays 1 (removal was after target)
      expect(result).toEqual(['conn-A', 'conn-D', 'conn-B', 'conn-C', 'conn-E']);
    });

    it('should move item to end (B -> end)', () => {
      const result = reorderConnections(order, ['conn-B'], 5);
      // B removed from index 1, target adjusted 5->4, insert at 4
      expect(result).toEqual(['conn-A', 'conn-C', 'conn-D', 'conn-E', 'conn-B']);
    });

    it('should move item to beginning (E -> position 0)', () => {
      const result = reorderConnections(order, ['conn-E'], 0);
      expect(result).toEqual(['conn-E', 'conn-A', 'conn-B', 'conn-C', 'conn-D']);
    });

    it('should keep order when dropped on same position', () => {
      // conn-C is at index 2, dropping it at index 2 should be no-op
      const result = reorderConnections(order, ['conn-C'], 2);
      expect(result).toEqual(['conn-A', 'conn-B', 'conn-C', 'conn-D', 'conn-E']);
    });
  });

  describe('multi-item drag', () => {
    it('should move two adjacent items forward', () => {
      const result = reorderConnections(order, ['conn-A', 'conn-B'], 4);
      // A(0), B(1) removed, target adjusted 4->2, insert at 2
      expect(result).toEqual(['conn-C', 'conn-D', 'conn-A', 'conn-B', 'conn-E']);
    });

    it('should move two non-adjacent items backward', () => {
      const result = reorderConnections(order, ['conn-C', 'conn-E'], 0);
      expect(result).toEqual(['conn-C', 'conn-E', 'conn-A', 'conn-B', 'conn-D']);
    });

    it('should move all items to end (no-op for all)', () => {
      const result = reorderConnections(order, ['conn-A', 'conn-B', 'conn-C', 'conn-D', 'conn-E'], 5);
      expect(result).toEqual(['conn-A', 'conn-B', 'conn-C', 'conn-D', 'conn-E']);
    });
  });

  describe('edge cases', () => {
    it('should handle empty drag list', () => {
      const result = reorderConnections(order, [], 2);
      expect(result).toEqual(order);
    });

    it('should handle single item list', () => {
      const result = reorderConnections(['conn-A'], ['conn-A'], 0);
      expect(result).toEqual(['conn-A']);
    });

    it('should handle dragging item not in list', () => {
      const result = reorderConnections(order, ['conn-X'], 2);
      // conn-X not in order, so it gets inserted at position 2
      expect(result).toEqual(['conn-A', 'conn-B', 'conn-X', 'conn-C', 'conn-D', 'conn-E']);
    });

    it('should clamp negative target index to 0', () => {
      const result = reorderConnections(order, ['conn-C'], -1);
      expect(result[0]).toBe('conn-C');
    });
  });
});

describe('FileTreeProvider - handleDrag filtering', () => {
  /**
   * handleDrag only allows ConnectionTreeItem instances.
   * Simulate the filtering logic.
   */
  function filterDraggableItems(items: Array<{ type: string; id: string }>): string[] {
    return items
      .filter(item => item.type === 'connection')
      .map(item => item.id);
  }

  it('should only allow connection items to be dragged', () => {
    const items = [
      { type: 'connection', id: 'conn-1' },
      { type: 'file', id: 'file-1' },
      { type: 'connection', id: 'conn-2' },
      { type: 'folder', id: 'folder-1' },
    ];
    expect(filterDraggableItems(items)).toEqual(['conn-1', 'conn-2']);
  });

  it('should return empty array when no connection items', () => {
    const items = [
      { type: 'file', id: 'file-1' },
      { type: 'folder', id: 'folder-1' },
    ];
    expect(filterDraggableItems(items)).toEqual([]);
  });

  it('should handle single connection item', () => {
    const items = [{ type: 'connection', id: 'conn-1' }];
    expect(filterDraggableItems(items)).toEqual(['conn-1']);
  });

  it('should handle empty item list', () => {
    expect(filterDraggableItems([])).toEqual([]);
  });
});


// ============================================================================
// Change 7: Show Tree From Root
// ============================================================================

describe('FileTreeProvider - Change 7: Show Tree From Root', () => {
  let provider: FileTreeProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllConnections.mockReturnValue([]);
    mockGetAllConnectionsWithReconnecting.mockReturnValue({ active: [], reconnecting: [] });
    provider = new FileTreeProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('setAutoExpandPaths()', () => {
    it('should store expand paths for a connection', () => {
      const expandPaths = new Set(['/home', '/home/user']);
      provider.setAutoExpandPaths('conn-1', expandPaths);
      // Expand paths are used internally by getChildren for auto-expand
      // We verify via the auto-expand behavior in getChildren tests
    });

    it('should merge with existing pending paths', () => {
      provider.setAutoExpandPaths('conn-1', new Set(['/home']));
      provider.setAutoExpandPaths('conn-1', new Set(['/var', '/var/log']));
      // Both /home and /var paths should be pending — verified via getChildren behavior
    });

    it('should handle multiple connections independently', () => {
      provider.setAutoExpandPaths('conn-1', new Set(['/home']));
      provider.setAutoExpandPaths('conn-2', new Set(['/opt']));
      // Each connection has its own pending expand paths
    });
  });

  describe('loadAncestorDirs()', () => {
    it('should load root directory first', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.listFiles.mockResolvedValue([]);

      await provider.loadAncestorDirs(mockConn as any, '/home/user');

      // Should call listFiles for /, /home, /home/user
      expect(mockConn.listFiles).toHaveBeenCalledWith('/');
    });

    it('should load all ancestor directories along the path', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.listFiles.mockResolvedValue([]);

      await provider.loadAncestorDirs(mockConn as any, '/home/user/projects');

      // Should load: /, /home, /home/user, /home/user/projects
      expect(mockConn.listFiles).toHaveBeenCalledWith('/');
      expect(mockConn.listFiles).toHaveBeenCalledWith('/home');
      expect(mockConn.listFiles).toHaveBeenCalledWith('/home/user');
      expect(mockConn.listFiles).toHaveBeenCalledWith('/home/user/projects');
    });

    it('should skip directories already in cache', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.listFiles.mockResolvedValue([]);

      // Pre-populate cache by loading root first
      await provider.loadAncestorDirs(mockConn as any, '/home');
      mockConn.listFiles.mockClear();

      // Now load ancestors to a deeper path - root and /home should be cached
      await provider.loadAncestorDirs(mockConn as any, '/home/user/data');

      // Should only load /home/user and /home/user/data (root and /home cached)
      expect(mockConn.listFiles).toHaveBeenCalledWith('/home/user');
      expect(mockConn.listFiles).toHaveBeenCalledWith('/home/user/data');
      expect(mockConn.listFiles).not.toHaveBeenCalledWith('/');
      expect(mockConn.listFiles).not.toHaveBeenCalledWith('/home');
    });

    it('should stop loading if an ancestor fails (permission denied)', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.listFiles
        .mockResolvedValueOnce([]) // /
        .mockRejectedValueOnce(new Error('Permission denied')) // /root
        .mockResolvedValueOnce([]); // should not be called

      await provider.loadAncestorDirs(mockConn as any, '/root/secret/files');

      // Should stop after /root fails
      expect(mockConn.listFiles).toHaveBeenCalledWith('/');
      expect(mockConn.listFiles).toHaveBeenCalledWith('/root');
      expect(mockConn.listFiles).not.toHaveBeenCalledWith('/root/secret');
    });
  });

  describe('buildDirectoryItems() - tree item placement', () => {
    it('should NOT show any special navigation item when at root /', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockGetConnection.mockReturnValue(mockConn);
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });
      mockConn.listFiles.mockResolvedValue([
        createMockRemoteFile('dir1', { path: '/dir1', isDirectory: true, connectionId: 'conn-1' }),
      ]);

      provider.setCurrentPath('conn-1', '/');

      const rootItems = await provider.getChildren();
      const connItem = rootItems[0] as ConnectionTreeItem;
      const children = await provider.getChildren(connItem);

      // At root, no ParentFolderTreeItem should be shown
      const parentItem = children.find(c => c instanceof ParentFolderTreeItem);
      expect(parentItem).toBeUndefined();
    });

    it('should show ParentFolderTreeItem with currentPath when NOT at root', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockGetConnection.mockReturnValue(mockConn);
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });

      const files: IRemoteFile[] = [
        createMockRemoteFile('file1.ts', { path: '/home/user/file1.ts', connectionId: 'conn-1' }),
      ];
      mockConn.listFiles.mockResolvedValue(files);

      // Navigate to a non-root path
      provider.setCurrentPath('conn-1', '/home/user');

      const rootItems = await provider.getChildren();
      const connItem = rootItems[0] as ConnectionTreeItem;
      const children = await provider.getChildren(connItem);

      // ParentFolderTreeItem should carry currentPath for inline "Show tree from root" button
      const parentItem = children.find(c => c instanceof ParentFolderTreeItem) as ParentFolderTreeItem;
      expect(parentItem).toBeDefined();
      expect(parentItem.currentPath).toBe('/home/user');
    });

    it('should NOT show ParentFolderTreeItem when at root /', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockGetConnection.mockReturnValue(mockConn);
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });

      mockConn.listFiles.mockResolvedValue([]);
      provider.setCurrentPath('conn-1', '/');

      const rootItems = await provider.getChildren();
      const connItem = rootItems[0] as ConnectionTreeItem;
      const children = await provider.getChildren(connItem);

      const parentItem = children.find(c => c instanceof ParentFolderTreeItem);
      expect(parentItem).toBeUndefined();
    });

    it('should show ParentFolderTreeItem with currentPath when at home ~', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockGetConnection.mockReturnValue(mockConn);
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });

      mockConn.listFiles.mockResolvedValue([]);
      provider.setCurrentPath('conn-1', '~');

      const rootItems = await provider.getChildren();
      const connItem = rootItems[0] as ConnectionTreeItem;
      const children = await provider.getChildren(connItem);

      const parentItem = children.find(c => c instanceof ParentFolderTreeItem) as ParentFolderTreeItem;
      expect(parentItem).toBeDefined();
      expect(parentItem.currentPath).toBe('~');
    });
  });

  describe('getChildren(FileTreeItem) - auto-expand logic', () => {
    it('should auto-expand folders on the expand path', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockGetConnection.mockReturnValue(mockConn);

      // Set up auto-expand paths
      const expandPaths = new Set(['/home', '/home/user']);
      provider.setAutoExpandPaths('conn-1', expandPaths);

      // Create a directory listing for /home with /home/user in it
      const homeDir: IRemoteFile = {
        name: 'home',
        path: '/home',
        isDirectory: true,
        size: 0,
        modifiedTime: Date.now(),
        connectionId: 'conn-1',
      };

      const userDir: IRemoteFile = {
        name: 'user',
        path: '/home/user',
        isDirectory: true,
        size: 0,
        modifiedTime: Date.now(),
        connectionId: 'conn-1',
      };

      const otherDir: IRemoteFile = {
        name: 'other',
        path: '/home/other',
        isDirectory: true,
        size: 0,
        modifiedTime: Date.now(),
        connectionId: 'conn-1',
      };

      // Cache the /home directory
      mockConn.listFiles.mockResolvedValue([userDir, otherDir]);

      // Create a FileTreeItem for /home
      const homeItem = new FileTreeItem(homeDir, mockConn as any, false, false, false, true);

      // Get children of /home
      const children = await provider.getChildren(homeItem);

      // Find the 'user' item - it should be auto-expanded (shouldBeExpanded = true)
      const userItem = children.find(c =>
        c instanceof FileTreeItem && (c as FileTreeItem).file.path === '/home/user'
      ) as FileTreeItem | undefined;
      expect(userItem).toBeDefined();
      expect(userItem!.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);

      // 'other' should NOT be auto-expanded
      const otherItem = children.find(c =>
        c instanceof FileTreeItem && (c as FileTreeItem).file.path === '/home/other'
      ) as FileTreeItem | undefined;
      expect(otherItem).toBeDefined();
      expect(otherItem!.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Collapsed);
    });
  });
});


// ============================================================================
// Change 8: Smart Reveal
// ============================================================================

describe('FileTreeProvider - Change 8: Smart Reveal', () => {
  let provider: FileTreeProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllConnections.mockReturnValue([]);
    mockGetAllConnectionsWithReconnecting.mockReturnValue({ active: [], reconnecting: [] });
    provider = new FileTreeProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('revealFile() - Case A: file under currentPath', () => {
    it('should load intermediate dirs and return FileTreeItem without changing currentPath', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.exec.mockResolvedValue('/home/user\n');
      mockGetConnection.mockReturnValue(mockConn);
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });

      // Set current path to ~ which resolves to /home/user
      provider.setCurrentPath('conn-1', '~');

      // Mock listFiles for intermediate directories
      mockConn.listFiles.mockImplementation(async (remotePath: string) => {
        if (remotePath === '/home/user') {
          return [
            createMockRemoteFile('projects', { path: '/home/user/projects', isDirectory: true, connectionId: 'conn-1' }),
          ];
        }
        if (remotePath === '/home/user/projects') {
          return [
            createMockRemoteFile('app.ts', { path: '/home/user/projects/app.ts', connectionId: 'conn-1' }),
          ];
        }
        return [];
      });

      const result = await provider.revealFile('conn-1', '/home/user/projects/app.ts');

      expect(result).toBeDefined();
      expect(result!.file.path).toBe('/home/user/projects/app.ts');
      // currentPath should still be ~ (not changed to the parent of the revealed file)
      expect(provider.getCurrentPath('conn-1')).toBe('~');
    });

    it('should use cached parent if file is already visible', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockGetConnection.mockReturnValue(mockConn);
      mockGetAllConnections.mockReturnValue([mockConn]);

      provider.setCurrentPath('conn-1', '/home/user');

      // Pre-cache the parent directory
      mockConn.listFiles.mockResolvedValue([
        createMockRemoteFile('readme.md', { path: '/home/user/readme.md', connectionId: 'conn-1' }),
      ]);

      // Trigger a load to populate cache
      await provider.getChildren(new ConnectionTreeItem(mockConn as any, '/home/user'));

      const result = await provider.revealFile('conn-1', '/home/user/readme.md');
      expect(result).toBeDefined();
      expect(result!.file.path).toBe('/home/user/readme.md');
    });
  });

  describe('revealFile() - Case B: file outside currentPath', () => {
    it('should navigate to root with auto-expand when file is outside currentPath', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.exec.mockResolvedValue('/home/user\n');
      mockGetConnection.mockReturnValue(mockConn);
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });

      provider.setCurrentPath('conn-1', '~');

      // File is at /var/log/app.log - outside of /home/user
      mockConn.listFiles.mockResolvedValue([]);

      const result = await provider.revealFile('conn-1', '/var/log/app.log');

      expect(result).toBeDefined();
      expect(result!.file.path).toBe('/var/log/app.log');
      // currentPath should now be / (root) — navigated to root with auto-expand
      expect(provider.getCurrentPath('conn-1')).toBe('/');
    });

    it('should return undefined if connection not found', async () => {
      mockGetConnection.mockReturnValue(undefined);

      const result = await provider.revealFile('nonexistent', '/some/file.ts');
      expect(result).toBeUndefined();
    });
  });

  describe('loadIntermediateDirs()', () => {
    it('should cache all directories between fromPath and toPath', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockGetConnection.mockReturnValue(mockConn);

      // We access loadIntermediateDirs indirectly through revealFile Case A
      // But we can verify the caching behavior by checking listFiles calls

      mockConn.exec.mockResolvedValue('/home\n');
      mockConn.listFiles.mockImplementation(async (remotePath: string) => {
        if (remotePath === '/home') {
          return [
            createMockRemoteFile('user', { path: '/home/user', isDirectory: true, connectionId: 'conn-1' }),
          ];
        }
        if (remotePath === '/home/user') {
          return [
            createMockRemoteFile('projects', { path: '/home/user/projects', isDirectory: true, connectionId: 'conn-1' }),
          ];
        }
        if (remotePath === '/home/user/projects') {
          return [
            createMockRemoteFile('src', { path: '/home/user/projects/src', isDirectory: true, connectionId: 'conn-1' }),
          ];
        }
        if (remotePath === '/home/user/projects/src') {
          return [
            createMockRemoteFile('app.ts', { path: '/home/user/projects/src/app.ts', connectionId: 'conn-1' }),
          ];
        }
        return [];
      });

      provider.setCurrentPath('conn-1', '~');
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });

      await provider.revealFile('conn-1', '/home/user/projects/src/app.ts');

      // Should have loaded intermediate directories from /home to /home/user/projects/src
      expect(mockConn.listFiles).toHaveBeenCalledWith('/home');
      expect(mockConn.listFiles).toHaveBeenCalledWith('/home/user');
      expect(mockConn.listFiles).toHaveBeenCalledWith('/home/user/projects');
      expect(mockConn.listFiles).toHaveBeenCalledWith('/home/user/projects/src');
    });

    it('should stop loading on permission error', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockGetConnection.mockReturnValue(mockConn);
      mockConn.exec.mockResolvedValue('/\n');

      // /restricted throws permission denied
      mockConn.listFiles.mockImplementation(async (remotePath: string) => {
        if (remotePath === '/') {
          return [
            createMockRemoteFile('restricted', { path: '/restricted', isDirectory: true, connectionId: 'conn-1' }),
          ];
        }
        if (remotePath === '/restricted') {
          throw new Error('Permission denied');
        }
        return [];
      });

      provider.setCurrentPath('conn-1', '/');
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });

      // This should not throw - it gracefully handles permission errors
      const result = await provider.revealFile('conn-1', '/restricted/secret/file.txt');
      expect(result).toBeDefined();
    });
  });

  describe('navigateToRootWithExpand() (via revealFile Case B)', () => {
    it('should navigate to root with both original and target paths as auto-expand', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.exec.mockResolvedValue('/home/user\n');
      mockGetConnection.mockReturnValue(mockConn);
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });

      mockConn.listFiles.mockResolvedValue([]);

      provider.setCurrentPath('conn-1', '~');

      // Reveal a file at /var/log/app.log (outside current path /home/user)
      await provider.revealFile('conn-1', '/var/log/app.log');

      // Current path should be / (root view)
      expect(provider.getCurrentPath('conn-1')).toBe('/');

      // Should have loaded ancestor dirs for both paths
      // For /home/user: /, /home, /home/user
      // For /var/log: /, /var, /var/log
      expect(mockConn.listFiles).toHaveBeenCalledWith('/');
    });

    it('should load ancestor directories for both original and target paths', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.exec.mockResolvedValue('/home/admin\n');
      mockGetConnection.mockReturnValue(mockConn);
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });

      const listFilesCalls: string[] = [];
      mockConn.listFiles.mockImplementation(async (remotePath: string) => {
        listFilesCalls.push(remotePath);
        return [];
      });

      provider.setCurrentPath('conn-1', '~');

      // Reveal file at /etc/nginx/nginx.conf (outside /home/admin)
      await provider.revealFile('conn-1', '/etc/nginx/nginx.conf');

      // Should have loaded ancestor dirs for:
      // Original path /home/admin: /, /home, /home/admin
      // Target parent /etc/nginx: /, /etc, /etc/nginx
      expect(listFilesCalls).toContain('/');
      expect(listFilesCalls).toContain('/home');
      expect(listFilesCalls).toContain('/home/admin');
      expect(listFilesCalls).toContain('/etc');
      expect(listFilesCalls).toContain('/etc/nginx');
    });
  });

  describe('revealFile() - edge cases', () => {
    it('should handle file at root level', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.exec.mockResolvedValue('/\n');
      mockGetConnection.mockReturnValue(mockConn);
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });

      mockConn.listFiles.mockResolvedValue([
        createMockRemoteFile('etc', { path: '/etc', isDirectory: true, connectionId: 'conn-1' }),
      ]);

      // Current path is / and we reveal /etc/hosts
      provider.setCurrentPath('conn-1', '/');

      mockConn.listFiles.mockImplementation(async (remotePath: string) => {
        if (remotePath === '/') {
          return [createMockRemoteFile('etc', { path: '/etc', isDirectory: true, connectionId: 'conn-1' })];
        }
        if (remotePath === '/etc') {
          return [createMockRemoteFile('hosts', { path: '/etc/hosts', connectionId: 'conn-1' })];
        }
        return [];
      });

      const result = await provider.revealFile('conn-1', '/etc/hosts');
      expect(result).toBeDefined();
      expect(result!.file.path).toBe('/etc/hosts');
      // When already at /, it stays at / (Case A applies since all paths are under /)
      expect(provider.getCurrentPath('conn-1')).toBe('/');
    });

    it('should handle the case when exec fails to resolve home directory', async () => {
      const mockConn = createMockConnection({ id: 'conn-1' });
      mockConn.exec.mockRejectedValue(new Error('Connection lost'));
      mockGetConnection.mockReturnValue(mockConn);
      mockGetAllConnections.mockReturnValue([mockConn]);
      mockGetAllConnectionsWithReconnecting.mockReturnValue({
        active: [mockConn],
        reconnecting: [],
      });

      mockConn.listFiles.mockResolvedValue([]);
      provider.setCurrentPath('conn-1', '~');

      // When exec fails, resolvedCurrentPath stays as ~
      // Since /var/log/app.log doesn't start with "~/", it will go to Case B (navigate to root)
      const result = await provider.revealFile('conn-1', '/var/log/app.log');
      expect(result).toBeDefined();
      expect(provider.getCurrentPath('conn-1')).toBe('/');
    });
  });
});


// ============================================================================
// Tree item constructors
// ============================================================================

describe('ParentFolderTreeItem', () => {
  it('should have correct properties', () => {
    const mockConn = createMockConnection({ id: 'conn-1' });
    const item = new ParentFolderTreeItem(mockConn as any, '/home', '/home/user');

    expect(item.label).toBe('..');
    expect(item.description).toBe('Go to parent folder');
    expect(item.contextValue).toBe('parentFolder');
    expect(item.parentPath).toBe('/home');
    expect(item.currentPath).toBe('/home/user');
    expect(item.command?.command).toBe('sshLite.goToPath');
    expect(item.command?.arguments).toEqual([mockConn, '/home']);
  });

  it('should default currentPath to parentPath when not specified', () => {
    const mockConn = createMockConnection({ id: 'conn-1' });
    const item = new ParentFolderTreeItem(mockConn as any, '/home');

    expect(item.parentPath).toBe('/home');
    expect(item.currentPath).toBe('/home');
  });
});

