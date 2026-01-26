/**
 * FolderHistoryService tests
 *
 * Tests folder and file visit tracking:
 * - Record visits, increment counts
 * - Frequency-based sorting
 * - Max entries limit
 * - Special path filtering
 * - Clear/remove operations
 * - Decay visit counts
 * - Cleanup old entries
 */

import { FolderHistoryService } from './FolderHistoryService';

function resetService(): FolderHistoryService {
  (FolderHistoryService as any)._instance = undefined;
  return FolderHistoryService.getInstance();
}

// Mock extension context
function createMockContext() {
  const storage = new Map<string, unknown>();
  return {
    globalState: {
      get: jest.fn().mockImplementation((key: string) => storage.get(key)),
      update: jest.fn().mockImplementation((key: string, value: unknown) => {
        storage.set(key, value);
        return Promise.resolve();
      }),
    },
  } as any;
}

describe('FolderHistoryService', () => {
  let service: FolderHistoryService;
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    service = resetService();
    context = createMockContext();
    service.initialize(context);
  });

  describe('getInstance', () => {
    it('should return singleton', () => {
      const a = FolderHistoryService.getInstance();
      const b = FolderHistoryService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('recordVisit', () => {
    it('should record a folder visit', async () => {
      await service.recordVisit('conn1', '/home/user/projects');

      const folders = service.getFrequentFolders('conn1');
      expect(folders).toContain('/home/user/projects');
    });

    it('should increment visit count on repeat visits', async () => {
      await service.recordVisit('conn1', '/home/user/projects');
      await service.recordVisit('conn1', '/home/user/projects');
      await service.recordVisit('conn1', '/home/user/projects');

      const history = service.getFolderHistory('conn1');
      const entry = history.find(f => f.path === '/home/user/projects');
      expect(entry?.visitCount).toBe(3);
    });

    it('should skip ~ path', async () => {
      await service.recordVisit('conn1', '~');

      const folders = service.getFrequentFolders('conn1');
      expect(folders).toHaveLength(0);
    });

    it('should skip / path', async () => {
      await service.recordVisit('conn1', '/');

      const folders = service.getFrequentFolders('conn1');
      expect(folders).toHaveLength(0);
    });

    it('should sort by visit count descending', async () => {
      await service.recordVisit('conn1', '/path/a');
      await service.recordVisit('conn1', '/path/b');
      await service.recordVisit('conn1', '/path/b');
      await service.recordVisit('conn1', '/path/b');
      await service.recordVisit('conn1', '/path/a');

      const folders = service.getFrequentFolders('conn1');
      expect(folders[0]).toBe('/path/b'); // 3 visits
      expect(folders[1]).toBe('/path/a'); // 2 visits
    });

    it('should limit to MAX_FOLDERS_PER_CONNECTION', async () => {
      for (let i = 0; i < 15; i++) {
        await service.recordVisit('conn1', `/path/${i}`);
      }

      const folders = service.getFrequentFolders('conn1');
      expect(folders.length).toBeLessThanOrEqual(10);
    });

    it('should isolate history per connection', async () => {
      await service.recordVisit('conn1', '/path/a');
      await service.recordVisit('conn2', '/path/b');

      expect(service.getFrequentFolders('conn1')).toEqual(['/path/a']);
      expect(service.getFrequentFolders('conn2')).toEqual(['/path/b']);
    });
  });

  describe('getFrequentFolders', () => {
    it('should return empty array for unknown connection', () => {
      const folders = service.getFrequentFolders('nonexistent');
      expect(folders).toEqual([]);
    });

    it('should respect limit parameter', async () => {
      await service.recordVisit('conn1', '/path/a');
      await service.recordVisit('conn1', '/path/b');
      await service.recordVisit('conn1', '/path/c');

      const folders = service.getFrequentFolders('conn1', 2);
      expect(folders).toHaveLength(2);
    });
  });

  describe('recordFileOpen', () => {
    it('should record a file open', async () => {
      await service.recordFileOpen('conn1', '/home/user/app.ts');

      const files = service.getFrequentFiles('conn1');
      expect(files).toContain('/home/user/app.ts');
    });

    it('should increment count on repeat opens', async () => {
      await service.recordFileOpen('conn1', '/home/user/app.ts');
      await service.recordFileOpen('conn1', '/home/user/app.ts');

      const history = service.getFileHistory('conn1');
      const entry = history.find(f => f.path === '/home/user/app.ts');
      expect(entry?.visitCount).toBe(2);
    });

    it('should limit to MAX_FILES_PER_CONNECTION', async () => {
      for (let i = 0; i < 15; i++) {
        await service.recordFileOpen('conn1', `/file${i}.ts`);
      }

      const files = service.getFrequentFiles('conn1');
      expect(files.length).toBeLessThanOrEqual(10);
    });
  });

  describe('clearHistory', () => {
    it('should clear folder and file history for a connection', async () => {
      await service.recordVisit('conn1', '/path/a');
      await service.recordFileOpen('conn1', '/file.ts');

      await service.clearHistory('conn1');

      expect(service.getFrequentFolders('conn1')).toEqual([]);
      expect(service.getFrequentFiles('conn1')).toEqual([]);
    });

    it('should not affect other connections', async () => {
      await service.recordVisit('conn1', '/path/a');
      await service.recordVisit('conn2', '/path/b');

      await service.clearHistory('conn1');

      expect(service.getFrequentFolders('conn1')).toEqual([]);
      expect(service.getFrequentFolders('conn2')).toEqual(['/path/b']);
    });
  });

  describe('clearAllHistory', () => {
    it('should clear all connections', async () => {
      await service.recordVisit('conn1', '/path/a');
      await service.recordVisit('conn2', '/path/b');

      await service.clearAllHistory();

      expect(service.getFrequentFolders('conn1')).toEqual([]);
      expect(service.getFrequentFolders('conn2')).toEqual([]);
    });
  });

  describe('removeFolder', () => {
    it('should remove a specific folder from history', async () => {
      await service.recordVisit('conn1', '/path/a');
      await service.recordVisit('conn1', '/path/b');

      await service.removeFolder('conn1', '/path/a');

      const folders = service.getFrequentFolders('conn1');
      expect(folders).toEqual(['/path/b']);
    });

    it('should do nothing for nonexistent folder', async () => {
      await service.recordVisit('conn1', '/path/a');
      await service.removeFolder('conn1', '/nonexistent');

      expect(service.getFrequentFolders('conn1')).toEqual(['/path/a']);
    });
  });

  describe('removeFile', () => {
    it('should remove a specific file from history', async () => {
      await service.recordFileOpen('conn1', '/file1.ts');
      await service.recordFileOpen('conn1', '/file2.ts');

      await service.removeFile('conn1', '/file1.ts');

      const files = service.getFrequentFiles('conn1');
      expect(files).toEqual(['/file2.ts']);
    });
  });

  describe('decayVisitCounts', () => {
    it('should halve visit counts for old entries', async () => {
      await service.recordVisit('conn1', '/path/a');
      // Visit multiple times
      for (let i = 0; i < 9; i++) {
        await service.recordVisit('conn1', '/path/a');
      }

      // Manually set lastVisit to 2 weeks ago
      const history = service.getFolderHistory('conn1');
      const entry = history.find(f => f.path === '/path/a');
      expect(entry?.visitCount).toBe(10);

      (entry as any).lastVisit = Date.now() - 14 * 24 * 60 * 60 * 1000;

      await service.decayVisitCounts();

      const updated = service.getFolderHistory('conn1');
      const updatedEntry = updated.find(f => f.path === '/path/a');
      expect(updatedEntry?.visitCount).toBe(5); // halved from 10
    });

    it('should not decay entries visited recently', async () => {
      await service.recordVisit('conn1', '/path/a');
      await service.recordVisit('conn1', '/path/a');

      await service.decayVisitCounts();

      const history = service.getFolderHistory('conn1');
      expect(history[0].visitCount).toBe(2); // unchanged
    });

    it('should not reduce below 1', async () => {
      await service.recordVisit('conn1', '/path/a');

      const history = service.getFolderHistory('conn1');
      (history[0] as any).lastVisit = Date.now() - 14 * 24 * 60 * 60 * 1000;

      await service.decayVisitCounts();

      const updated = service.getFolderHistory('conn1');
      expect(updated[0].visitCount).toBe(1); // min 1
    });
  });
});
