/**
 * ProgressiveFileContentProvider tests
 *
 * Tests the progressive file preview system:
 * - Singleton pattern
 * - Preview cache management
 * - Tail follow start/stop
 * - Download progress tracking
 * - Cache clearing
 * - URI scheme
 */

import { ProgressiveFileContentProvider } from './ProgressiveFileContentProvider';

// Mock PriorityQueueService
jest.mock('../services/PriorityQueueService', () => ({
  PriorityQueueService: {
    getInstance: jest.fn().mockReturnValue({
      enqueue: jest.fn().mockImplementation(async (_c: string, _d: string, _p: number, fn: () => Promise<void>) => {
        await fn();
      }),
    }),
  },
  PreloadPriority: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, IDLE: 4 },
}));

// Mock ConnectionManager
jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: {
    getInstance: jest.fn().mockReturnValue({
      getConnection: jest.fn().mockReturnValue(undefined),
    }),
  },
}));

// Mock progressive types
jest.mock('../types/progressive', () => ({
  PROGRESSIVE_PREVIEW_SCHEME: 'ssh-preview',
  parsePreviewUri: jest.fn().mockReturnValue(null),
  createPreviewUri: jest.fn().mockImplementation((connId: string, path: string, lines: number) => ({
    toString: () => `ssh-preview://${connId}${path}?lines=${lines}`,
  })),
  loadProgressiveConfig: jest.fn().mockReturnValue({
    tailFollowEnabled: true,
    tailPollInterval: 2000,
    previewLineCount: 100,
    largeFileThreshold: 1048576,
  }),
}));

function resetProvider(): ProgressiveFileContentProvider {
  (ProgressiveFileContentProvider as any)._instance = undefined;
  return ProgressiveFileContentProvider.getInstance();
}

describe('ProgressiveFileContentProvider', () => {
  let provider: ProgressiveFileContentProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    provider = resetProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('getInstance', () => {
    it('should return singleton', () => {
      const a = ProgressiveFileContentProvider.getInstance();
      const b = ProgressiveFileContentProvider.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('scheme', () => {
    it('should return ssh-preview scheme', () => {
      expect(provider.scheme).toBe('ssh-preview');
    });
  });

  describe('provideTextDocumentContent', () => {
    it('should return error for invalid URI', async () => {
      const { parsePreviewUri } = require('../types/progressive');
      (parsePreviewUri as jest.Mock).mockReturnValue(null);

      const uri = { toString: () => 'invalid' } as any;
      const content = await provider.provideTextDocumentContent(uri);
      expect(content).toContain('Error: Invalid preview URI');
    });
  });

  describe('cache management', () => {
    it('should report no preview initially', () => {
      const uri = { toString: () => 'test-uri' } as any;
      expect(provider.hasPreview(uri)).toBe(false);
    });

    it('should clear specific cache entry', () => {
      const uri = { toString: () => 'test-uri' } as any;
      // Manually set cache
      (provider as any).previewCache.set('test-uri', {
        content: 'test',
        lastUpdate: Date.now(),
        lineCount: 100,
        fileSize: 1024,
        isDownloading: false,
        downloadProgress: 100,
        fileName: 'test.ts',
      });

      expect(provider.hasPreview(uri)).toBe(true);
      provider.clearCache(uri);
      expect(provider.hasPreview(uri)).toBe(false);
    });

    it('should clear all cache entries', () => {
      (provider as any).previewCache.set('uri1', { content: 'a' });
      (provider as any).previewCache.set('uri2', { content: 'b' });

      provider.clearAllCache();

      expect((provider as any).previewCache.size).toBe(0);
    });
  });

  describe('download progress', () => {
    it('should update download progress', () => {
      const uri = { toString: () => 'test-uri' } as any;
      (provider as any).previewCache.set('test-uri', {
        content: 'test',
        lastUpdate: 0,
        downloadProgress: 0,
        isDownloading: true,
        lineCount: 100,
        fileSize: 1024,
        fileName: 'test.ts',
      });

      provider.updateDownloadProgress(uri, 50);

      const cached = (provider as any).previewCache.get('test-uri');
      expect(cached.downloadProgress).toBe(50);
    });

    it('should mark download as complete', () => {
      const uri = { toString: () => 'test-uri' } as any;
      (provider as any).previewCache.set('test-uri', {
        content: 'test',
        lastUpdate: 0,
        downloadProgress: 50,
        isDownloading: true,
        lineCount: 100,
        fileSize: 1024,
        fileName: 'test.ts',
      });

      provider.markDownloadComplete(uri);

      const cached = (provider as any).previewCache.get('test-uri');
      expect(cached.isDownloading).toBe(false);
      expect(cached.downloadProgress).toBe(100);
    });
  });

  describe('tail follow', () => {
    it('should stop tail follow and clean up', () => {
      const uri = { toString: () => 'test-uri' } as any;

      // Manually add a follower
      (provider as any).tailFollowers.set('test-uri', {
        connectionId: 'conn1',
        remotePath: '/test.ts',
        intervalId: null,
        lastLineCount: 100,
      });

      provider.stopTailFollow(uri);

      expect((provider as any).tailFollowers.has('test-uri')).toBe(false);
    });

    it('should stop all tail followers', () => {
      (provider as any).tailFollowers.set('uri1', {
        connectionId: 'conn1',
        remotePath: '/a.ts',
        intervalId: null,
        lastLineCount: 100,
      });
      (provider as any).tailFollowers.set('uri2', {
        connectionId: 'conn2',
        remotePath: '/b.ts',
        intervalId: null,
        lastLineCount: 100,
      });

      provider.stopAllTailFollowers();

      expect((provider as any).tailFollowers.size).toBe(0);
    });
  });

  describe('getConfig', () => {
    it('should return a copy of config', () => {
      const config = provider.getConfig();
      expect(config.tailFollowEnabled).toBe(true);
      expect(config.tailPollInterval).toBe(2000);
    });
  });
});
