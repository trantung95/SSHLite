import { IRemoteFile, ConnectionState } from '../types';
import * as vscode from 'vscode';

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
 * Connection reorder algorithm — extracted from FileTreeProvider.handleDrop
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
    it('should move item forward (A → position of D)', () => {
      const result = reorderConnections(order, ['conn-A'], 3);
      // A removed from index 0, target adjusted 3→2, insert at 2
      expect(result).toEqual(['conn-B', 'conn-C', 'conn-A', 'conn-D', 'conn-E']);
    });

    it('should move item backward (D → position of B)', () => {
      const result = reorderConnections(order, ['conn-D'], 1);
      // D removed from index 3, target stays 1 (removal was after target)
      expect(result).toEqual(['conn-A', 'conn-D', 'conn-B', 'conn-C', 'conn-E']);
    });

    it('should move item to end (B → end)', () => {
      const result = reorderConnections(order, ['conn-B'], 5);
      // B removed from index 1, target adjusted 5→4, insert at 4
      expect(result).toEqual(['conn-A', 'conn-C', 'conn-D', 'conn-E', 'conn-B']);
    });

    it('should move item to beginning (E → position 0)', () => {
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
      // A(0), B(1) removed, target adjusted 4→2, insert at 2
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
