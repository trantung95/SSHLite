/**
 * ProgressiveDownloadManager tests
 *
 * Tests progressive file download management:
 * - Singleton pattern
 * - shouldUseProgressiveDownload threshold logic
 * - Download state management (get, cancel, cleanup)
 * - Active downloads tracking
 * - isDownloading check
 * - getLocalPath for completed downloads
 * - cancelDownloadByUri matching logic
 * - Configuration access
 * - Dispose cleanup
 */

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
}));

// Mock progressive types
jest.mock('../types/progressive', () => ({
  isLikelyBinary: jest.fn().mockImplementation((filename: string) => {
    const ext = filename.toLowerCase().substring(filename.lastIndexOf('.'));
    const binaryExts = new Set(['.bin', '.exe', '.dll', '.zip', '.jpg', '.png', '.pdf']);
    return binaryExts.has(ext);
  }),
  loadProgressiveConfig: jest.fn().mockReturnValue({
    threshold: 1048576, // 1MB
    previewLines: 1000,
    tailFollowEnabled: true,
    tailPollInterval: 1000,
    chunkSize: 65536,
  }),
  createPreviewUri: jest.fn().mockImplementation((connId: string, path: string, lines: number) => ({
    toString: () => `ssh-lite-preview://${connId}${path}?lines=${lines}`,
    scheme: 'ssh-lite-preview',
    authority: connId,
    path,
    query: `lines=${lines}`,
    fsPath: path,
  })),
  PROGRESSIVE_PREVIEW_SCHEME: 'ssh-lite-preview',
}));

import { ProgressiveDownloadManager } from './ProgressiveDownloadManager';
import { DownloadState } from '../types/progressive';

function resetManager(): ProgressiveDownloadManager {
  (ProgressiveDownloadManager as any)._instance = undefined;
  return ProgressiveDownloadManager.getInstance();
}

describe('ProgressiveDownloadManager', () => {
  let manager: ProgressiveDownloadManager;

  beforeEach(() => {
    jest.clearAllMocks();
    manager = resetManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  describe('getInstance', () => {
    it('should return singleton', () => {
      const a = ProgressiveDownloadManager.getInstance();
      const b = ProgressiveDownloadManager.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('shouldUseProgressiveDownload', () => {
    it('should return true for files above threshold', () => {
      // Threshold is 1MB (1048576 bytes)
      expect(manager.shouldUseProgressiveDownload(2 * 1024 * 1024, 'large.txt')).toBe(true);
      expect(manager.shouldUseProgressiveDownload(1048576, 'exactly-threshold.txt')).toBe(true);
    });

    it('should return false for files below threshold', () => {
      expect(manager.shouldUseProgressiveDownload(500 * 1024, 'small.txt')).toBe(false);
      expect(manager.shouldUseProgressiveDownload(0, 'empty.txt')).toBe(false);
      expect(manager.shouldUseProgressiveDownload(1048575, 'just-under.txt')).toBe(false);
    });

    it('should return false for binary files regardless of size', () => {
      expect(manager.shouldUseProgressiveDownload(10 * 1024 * 1024, 'image.jpg')).toBe(false);
      expect(manager.shouldUseProgressiveDownload(50 * 1024 * 1024, 'archive.zip')).toBe(false);
      expect(manager.shouldUseProgressiveDownload(100 * 1024 * 1024, 'program.exe')).toBe(false);
      expect(manager.shouldUseProgressiveDownload(5 * 1024 * 1024, 'doc.pdf')).toBe(false);
    });

    it('should return true for large text-like files', () => {
      expect(manager.shouldUseProgressiveDownload(5 * 1024 * 1024, 'large.ts')).toBe(true);
      expect(manager.shouldUseProgressiveDownload(2 * 1024 * 1024, 'big.json')).toBe(true);
      expect(manager.shouldUseProgressiveDownload(3 * 1024 * 1024, 'huge.log')).toBe(true);
      expect(manager.shouldUseProgressiveDownload(10 * 1024 * 1024, 'dump.sql')).toBe(true);
    });
  });

  describe('getDownloadState', () => {
    it('should return undefined for unknown download ID', () => {
      expect(manager.getDownloadState('nonexistent')).toBeUndefined();
    });

    it('should return state for known download', () => {
      // Manually set a download state
      const state: DownloadState = {
        id: 'conn1:/path/file.ts',
        remotePath: '/path/file.ts',
        connectionId: 'conn1',
        totalBytes: 1024,
        downloadedBytes: 0,
        status: 'downloading',
        startTime: Date.now(),
      };
      (manager as any).downloads.set('conn1:/path/file.ts', state);

      const result = manager.getDownloadState('conn1:/path/file.ts');
      expect(result).toBeDefined();
      expect(result!.remotePath).toBe('/path/file.ts');
      expect(result!.status).toBe('downloading');
    });
  });

  describe('getActiveDownloads', () => {
    it('should return empty array when no downloads', () => {
      expect(manager.getActiveDownloads()).toEqual([]);
    });

    it('should return only downloading and pending downloads', () => {
      const downloads = (manager as any).downloads as Map<string, DownloadState>;

      downloads.set('d1', {
        id: 'd1', remotePath: '/file1.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'downloading', startTime: Date.now(),
      });
      downloads.set('d2', {
        id: 'd2', remotePath: '/file2.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 1024, status: 'completed', startTime: Date.now(),
      });
      downloads.set('d3', {
        id: 'd3', remotePath: '/file3.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'pending', startTime: Date.now(),
      });
      downloads.set('d4', {
        id: 'd4', remotePath: '/file4.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'error', startTime: Date.now(),
      });
      downloads.set('d5', {
        id: 'd5', remotePath: '/file5.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'cancelled', startTime: Date.now(),
      });

      const active = manager.getActiveDownloads();
      expect(active).toHaveLength(2);
      expect(active.map(d => d.id).sort()).toEqual(['d1', 'd3']);
    });
  });

  describe('isDownloading', () => {
    it('should return false for unknown file', () => {
      expect(manager.isDownloading('conn1', '/nonexistent.ts')).toBe(false);
    });

    it('should return true for downloading file', () => {
      (manager as any).downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 512, status: 'downloading', startTime: Date.now(),
      });

      expect(manager.isDownloading('conn1', '/file.ts')).toBe(true);
    });

    it('should return true for pending file', () => {
      (manager as any).downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 0, status: 'pending', startTime: Date.now(),
      });

      expect(manager.isDownloading('conn1', '/file.ts')).toBe(true);
    });

    it('should return false for completed file', () => {
      (manager as any).downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 1024, status: 'completed', startTime: Date.now(),
      });

      expect(manager.isDownloading('conn1', '/file.ts')).toBe(false);
    });

    it('should return false for cancelled file', () => {
      (manager as any).downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 0, status: 'cancelled', startTime: Date.now(),
      });

      expect(manager.isDownloading('conn1', '/file.ts')).toBe(false);
    });

    it('should return false for errored file', () => {
      (manager as any).downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 0, status: 'error', startTime: Date.now(),
      });

      expect(manager.isDownloading('conn1', '/file.ts')).toBe(false);
    });
  });

  describe('getLocalPath', () => {
    it('should return undefined for unknown download', () => {
      expect(manager.getLocalPath('conn1', '/unknown.ts')).toBeUndefined();
    });

    it('should return local path for completed download', () => {
      (manager as any).downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 1024, status: 'completed',
        startTime: Date.now(), localPath: '/tmp/ssh-lite/abc123/[SSH] file.ts',
      });

      expect(manager.getLocalPath('conn1', '/file.ts')).toBe('/tmp/ssh-lite/abc123/[SSH] file.ts');
    });

    it('should return undefined for non-completed download', () => {
      (manager as any).downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 512, status: 'downloading',
        startTime: Date.now(), localPath: '/tmp/ssh-lite/abc123/[SSH] file.ts',
      });

      expect(manager.getLocalPath('conn1', '/file.ts')).toBeUndefined();
    });

    it('should return undefined for errored download even with localPath set', () => {
      (manager as any).downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 0, status: 'error',
        startTime: Date.now(), localPath: '/tmp/ssh-lite/abc123/[SSH] file.ts',
      });

      expect(manager.getLocalPath('conn1', '/file.ts')).toBeUndefined();
    });
  });

  describe('cancelDownload', () => {
    it('should cancel an active download', () => {
      const mockCancel = jest.fn();
      (manager as any).downloads.set('d1', {
        id: 'd1', remotePath: '/file.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'downloading',
        startTime: Date.now(),
        cancelTokenSource: { cancel: mockCancel, dispose: jest.fn() },
      });

      manager.cancelDownload('d1');

      expect(mockCancel).toHaveBeenCalled();
      const state = (manager as any).downloads.get('d1');
      expect(state.status).toBe('cancelled');
    });

    it('should do nothing for unknown download', () => {
      // Should not throw
      manager.cancelDownload('nonexistent');
    });

    it('should do nothing if no cancel token', () => {
      (manager as any).downloads.set('d1', {
        id: 'd1', remotePath: '/file.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'downloading',
        startTime: Date.now(),
        // No cancelTokenSource
      });

      // Should not throw
      manager.cancelDownload('d1');
    });
  });

  describe('cancelDownloadByUri', () => {
    it('should cancel download matching preview URI', () => {
      const mockCancel = jest.fn();
      const previewUri = {
        toString: () => 'ssh-lite-preview://conn1/file.ts?lines=1000',
        scheme: 'ssh-lite-preview',
        fsPath: '/file.ts',
      };
      (manager as any).downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 0, status: 'downloading',
        startTime: Date.now(), previewUri,
        cancelTokenSource: { cancel: mockCancel, dispose: jest.fn() },
      });

      const result = manager.cancelDownloadByUri(previewUri as any);

      expect(result).toBe(true);
      expect(mockCancel).toHaveBeenCalled();
    });

    it('should cancel download matching local file path', () => {
      const mockCancel = jest.fn();
      (manager as any).downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 0, status: 'downloading',
        startTime: Date.now(),
        localPath: '/tmp/ssh-lite/abc123/[SSH] file.ts',
        cancelTokenSource: { cancel: mockCancel, dispose: jest.fn() },
      });

      const uri = {
        toString: () => 'file:///tmp/ssh-lite/abc123/[SSH] file.ts',
        scheme: 'file',
        fsPath: '/tmp/ssh-lite/abc123/[SSH] file.ts',
      };
      const result = manager.cancelDownloadByUri(uri as any);

      expect(result).toBe(true);
      expect(mockCancel).toHaveBeenCalled();
    });

    it('should return false when no matching download found', () => {
      const uri = {
        toString: () => 'file:///some/other/file.ts',
        scheme: 'file',
        fsPath: '/some/other/file.ts',
      };
      const result = manager.cancelDownloadByUri(uri as any);

      expect(result).toBe(false);
    });

    it('should skip already completed downloads', () => {
      (manager as any).downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 1024, status: 'completed',
        startTime: Date.now(),
        localPath: '/tmp/ssh-lite/abc123/[SSH] file.ts',
      });

      const uri = {
        toString: () => 'file:///tmp/ssh-lite/abc123/[SSH] file.ts',
        scheme: 'file',
        fsPath: '/tmp/ssh-lite/abc123/[SSH] file.ts',
      };
      const result = manager.cancelDownloadByUri(uri as any);

      expect(result).toBe(false);
    });

    it('should match by remote filename in file scheme URI', () => {
      const mockCancel = jest.fn();
      (manager as any).downloads.set('conn1:/home/user/app.ts', {
        id: 'conn1:/home/user/app.ts', remotePath: '/home/user/app.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 0, status: 'downloading',
        startTime: Date.now(),
        localPath: '/tmp/ssh-lite/abc/[SSH] app.ts',
        cancelTokenSource: { cancel: mockCancel, dispose: jest.fn() },
      });

      const uri = {
        toString: () => 'file:///tmp/ssh-lite/abc/[SSH] app.ts',
        scheme: 'file',
        fsPath: '/tmp/ssh-lite/abc/[SSH] app.ts',
      };
      const result = manager.cancelDownloadByUri(uri as any);

      expect(result).toBe(true);
    });
  });

  describe('cleanupDownloads', () => {
    it('should remove completed downloads', () => {
      const downloads = (manager as any).downloads as Map<string, DownloadState>;

      downloads.set('d1', {
        id: 'd1', remotePath: '/f1.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 1024, status: 'completed', startTime: Date.now(),
      });
      downloads.set('d2', {
        id: 'd2', remotePath: '/f2.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'downloading', startTime: Date.now(),
      });

      manager.cleanupDownloads();

      expect(downloads.size).toBe(1);
      expect(downloads.has('d2')).toBe(true);
    });

    it('should remove cancelled and errored downloads', () => {
      const downloads = (manager as any).downloads as Map<string, DownloadState>;

      downloads.set('d1', {
        id: 'd1', remotePath: '/f1.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'cancelled', startTime: Date.now(),
      });
      downloads.set('d2', {
        id: 'd2', remotePath: '/f2.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'error', startTime: Date.now(),
      });
      downloads.set('d3', {
        id: 'd3', remotePath: '/f3.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'pending', startTime: Date.now(),
      });

      manager.cleanupDownloads();

      expect(downloads.size).toBe(1);
      expect(downloads.has('d3')).toBe(true);
    });

    it('should keep active downloads', () => {
      const downloads = (manager as any).downloads as Map<string, DownloadState>;

      downloads.set('d1', {
        id: 'd1', remotePath: '/f1.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 512, status: 'downloading', startTime: Date.now(),
      });
      downloads.set('d2', {
        id: 'd2', remotePath: '/f2.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'pending', startTime: Date.now(),
      });

      manager.cleanupDownloads();

      expect(downloads.size).toBe(2);
    });
  });

  describe('getConfig', () => {
    it('should return config copy', () => {
      const config = manager.getConfig();
      expect(config.threshold).toBe(1048576);
      expect(config.previewLines).toBe(1000);
      expect(config.tailFollowEnabled).toBe(true);
      expect(config.chunkSize).toBe(65536);
    });

    it('should return a copy not a reference', () => {
      const config1 = manager.getConfig();
      const config2 = manager.getConfig();
      expect(config1).not.toBe(config2);
      expect(config1).toEqual(config2);
    });
  });

  describe('dispose', () => {
    it('should cancel all active downloads', () => {
      const mockCancel1 = jest.fn();
      const mockCancel2 = jest.fn();

      const downloads = (manager as any).downloads as Map<string, DownloadState>;
      downloads.set('d1', {
        id: 'd1', remotePath: '/f1.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'downloading', startTime: Date.now(),
        cancelTokenSource: { cancel: mockCancel1, dispose: jest.fn() },
      } as any);
      downloads.set('d2', {
        id: 'd2', remotePath: '/f2.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 0, status: 'pending', startTime: Date.now(),
        cancelTokenSource: { cancel: mockCancel2, dispose: jest.fn() },
      } as any);

      manager.dispose();

      expect(mockCancel1).toHaveBeenCalled();
      expect(mockCancel2).toHaveBeenCalled();
    });

    it('should clear all download state', () => {
      const downloads = (manager as any).downloads as Map<string, DownloadState>;
      downloads.set('d1', {
        id: 'd1', remotePath: '/f1.ts', connectionId: 'c1',
        totalBytes: 1024, downloadedBytes: 1024, status: 'completed', startTime: Date.now(),
      });

      manager.dispose();

      expect(downloads.size).toBe(0);
    });
  });

  describe('download ID format', () => {
    it('should use connectionId:remotePath format', () => {
      // Verify the download ID convention used internally
      const connectionId = '10.0.0.1:22:admin';
      const remotePath = '/home/admin/app.ts';
      const expectedId = `${connectionId}:${remotePath}`;

      expect(expectedId).toBe('10.0.0.1:22:admin:/home/admin/app.ts');
    });

    it('should produce unique IDs for different connections', () => {
      const id1 = 'conn1:/path/file.ts';
      const id2 = 'conn2:/path/file.ts';
      expect(id1).not.toBe(id2);
    });

    it('should produce unique IDs for different files on same connection', () => {
      const id1 = 'conn1:/path/file1.ts';
      const id2 = 'conn1:/path/file2.ts';
      expect(id1).not.toBe(id2);
    });
  });

  describe('multi-connection download scenarios', () => {
    it('should track downloads from different connections independently', () => {
      const downloads = (manager as any).downloads as Map<string, DownloadState>;

      downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 0, status: 'downloading', startTime: Date.now(),
      });
      downloads.set('conn2:/file.ts', {
        id: 'conn2:/file.ts', remotePath: '/file.ts', connectionId: 'conn2',
        totalBytes: 2048, downloadedBytes: 0, status: 'pending', startTime: Date.now(),
      });

      expect(manager.isDownloading('conn1', '/file.ts')).toBe(true);
      expect(manager.isDownloading('conn2', '/file.ts')).toBe(true);
      expect(manager.getActiveDownloads()).toHaveLength(2);
    });

    it('should cancel one connection without affecting another', () => {
      const downloads = (manager as any).downloads as Map<string, DownloadState>;
      const mockCancel = jest.fn();

      downloads.set('conn1:/file.ts', {
        id: 'conn1:/file.ts', remotePath: '/file.ts', connectionId: 'conn1',
        totalBytes: 1024, downloadedBytes: 0, status: 'downloading', startTime: Date.now(),
        cancelTokenSource: { cancel: mockCancel, dispose: jest.fn() },
      } as any);
      downloads.set('conn2:/file.ts', {
        id: 'conn2:/file.ts', remotePath: '/file.ts', connectionId: 'conn2',
        totalBytes: 2048, downloadedBytes: 0, status: 'downloading', startTime: Date.now(),
      });

      manager.cancelDownload('conn1:/file.ts');

      expect(mockCancel).toHaveBeenCalled();
      expect(manager.isDownloading('conn1', '/file.ts')).toBe(false);
      expect(manager.isDownloading('conn2', '/file.ts')).toBe(true);
    });
  });
});
