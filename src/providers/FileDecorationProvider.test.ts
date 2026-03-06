/**
 * SSHFileDecorationProvider tests
 *
 * Tests file decoration logic:
 * - No decoration for non-SSH files
 * - Gray decoration for orphaned SSH temp files
 * - Gray decoration when connection is lost
 * - No decoration for active SSH files
 */

import * as fs from 'fs';
import { Uri, ThemeColor, setMockConfig, clearMockConfig } from '../__mocks__/vscode';
import { SSHFileDecorationProvider } from './FileDecorationProvider';

jest.mock('fs');

// Create mock FileService
function createMockFileService(tempDir: string) {
  const mappings = new Map<string, { connectionId: string }>();
  return {
    getTempDir: jest.fn().mockReturnValue(tempDir),
    getFileMapping: jest.fn().mockImplementation((path: string) => mappings.get(path)),
    isFileUploading: jest.fn().mockReturnValue(false),
    isFileUploadFailed: jest.fn().mockReturnValue(false),
    onFileMappingsChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    onUploadStateChanged: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    _mappings: mappings, // for test setup
  };
}

// Create mock ConnectionManager
function createMockConnectionManager() {
  const connections = new Map<string, object>();
  return {
    getConnection: jest.fn().mockImplementation((id: string) => connections.get(id)),
    onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    onConnectionStateChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    _connections: connections, // for test setup
  };
}

describe('SSHFileDecorationProvider', () => {
  const tempDir = '/tmp/ssh-lite';
  let provider: SSHFileDecorationProvider;
  let fileService: ReturnType<typeof createMockFileService>;
  let connectionManager: ReturnType<typeof createMockConnectionManager>;

  beforeEach(() => {
    fileService = createMockFileService(tempDir);
    connectionManager = createMockConnectionManager();
    provider = new SSHFileDecorationProvider(
      fileService as any,
      connectionManager as any
    );
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('non-SSH files', () => {
    it('should return undefined for regular files', () => {
      const uri = { scheme: 'file', fsPath: '/home/user/regular-file.ts' } as any;
      const decoration = provider.provideFileDecoration(uri);
      expect(decoration).toBeUndefined();
    });

    it('should return undefined for non-file scheme', () => {
      const uri = { scheme: 'untitled', fsPath: '' } as any;
      const decoration = provider.provideFileDecoration(uri);
      expect(decoration).toBeUndefined();
    });
  });

  describe('SSH temp files without mapping', () => {
    it('should gray out orphaned SSH temp files', () => {
      const uri = { scheme: 'file', fsPath: `${tempDir}/conn1/file.ts` } as any;
      fileService.getFileMapping.mockReturnValue(undefined);

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toContain('Not connected');
    });
  });

  describe('SSH temp files with mapping but no connection', () => {
    it('should gray out when connection is lost', () => {
      const localPath = `${tempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      // Has mapping but no active connection
      fileService.getFileMapping.mockReturnValue({ connectionId: 'conn1' });
      connectionManager.getConnection.mockReturnValue(undefined);

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toContain('Connection lost');
    });
  });

  describe('SSH temp files with active connection', () => {
    it('should return remote tooltip when file is live', () => {
      const localPath = `${tempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      // Has mapping AND active connection
      fileService.getFileMapping.mockReturnValue({
        connectionId: 'host:22:root',
        remotePath: '/var/log/test.log',
      });
      connectionManager.getConnection.mockReturnValue({ id: 'conn1' });

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toContain('Path: /var/log/test.log');
      expect(decoration!.tooltip).toContain('Server: host:22 (root)');
      expect(decoration!.badge).toBeUndefined();
      expect(decoration!.color).toBeUndefined();
    });
  });

  describe('upload state badges', () => {
    it('should show ↑ badge when file is uploading', () => {
      const localPath = `${tempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      fileService.isFileUploading.mockReturnValue(true);

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.badge).toBe('↑');
      expect(decoration!.tooltip).toContain('Uploading');
    });

    it('should show ✗ badge when upload failed', () => {
      const localPath = `${tempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      fileService.isFileUploadFailed.mockReturnValue(true);

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.badge).toBe('✗');
      expect(decoration!.tooltip).toContain('Upload failed');
    });

    it('should prioritize upload state over connection state', () => {
      const localPath = `${tempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      // File is uploading AND has mapping AND connection is active
      fileService.isFileUploading.mockReturnValue(true);
      fileService.getFileMapping.mockReturnValue({ connectionId: 'conn1' });
      connectionManager.getConnection.mockReturnValue({ id: 'conn1' });

      const decoration = provider.provideFileDecoration(uri);

      // Upload badge takes priority
      expect(decoration).toBeDefined();
      expect(decoration!.badge).toBe('↑');
    });
  });

  describe('Windows path case normalization', () => {
    // Simulate Windows: tempDir is lowercase (normalized by FileService),
    // but VS Code may give us fsPath with uppercase drive letter
    const winTempDir = 'c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite';
    let winProvider: SSHFileDecorationProvider;
    let winFileService: ReturnType<typeof createMockFileService>;
    let winConnMgr: ReturnType<typeof createMockConnectionManager>;

    beforeEach(() => {
      winFileService = createMockFileService(winTempDir);
      winConnMgr = createMockConnectionManager();
      winProvider = new SSHFileDecorationProvider(winFileService as any, winConnMgr as any);
    });

    afterEach(() => {
      winProvider.dispose();
    });

    it('should recognize SSH file when fsPath has uppercase drive letter', () => {
      // VS Code may provide uppercase drive letter even though tempDir is lowercase
      const uri = {
        scheme: 'file',
        fsPath: 'C:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\conn1\\file.ts',
      } as any;

      winFileService.getFileMapping.mockReturnValue(undefined);
      const decoration = winProvider.provideFileDecoration(uri);

      // Should recognize this as an SSH temp file (not return undefined for "non-SSH")
      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toContain('Not connected');
    });

    it('should pass normalized path to isFileUploading', () => {
      const uri = {
        scheme: 'file',
        fsPath: 'C:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\conn1\\file.ts',
      } as any;

      winFileService.isFileUploading.mockReturnValue(true);
      const decoration = winProvider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.badge).toBe('↑');
      // Verify the normalized path was passed to the service
      expect(winFileService.isFileUploading).toHaveBeenCalledWith(
        'c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\conn1\\file.ts'
      );
    });

    it('should pass normalized path to getFileMapping', () => {
      const uri = {
        scheme: 'file',
        fsPath: 'C:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\conn1\\file.ts',
      } as any;

      winFileService.getFileMapping.mockReturnValue({ connectionId: 'host:22:root', remotePath: '/test' });
      winConnMgr.getConnection.mockReturnValue({ id: 'conn1' });

      const decoration = winProvider.provideFileDecoration(uri);

      expect(decoration).toBeDefined(); // Active file — has remote tooltip
      expect(decoration!.tooltip).toContain('Server: host:22 (root)');
      expect(winFileService.getFileMapping).toHaveBeenCalledWith(
        'c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\conn1\\file.ts'
      );
    });

    it('should not decorate files outside SSH temp dir even with uppercase', () => {
      const uri = {
        scheme: 'file',
        fsPath: 'C:\\Users\\user\\Documents\\file.ts',
      } as any;

      const decoration = winProvider.provideFileDecoration(uri);
      expect(decoration).toBeUndefined();
    });
  });

  describe('macOS/Linux path handling', () => {
    const unixTempDir = '/var/folders/zz/abc123/T/ssh-lite';
    let unixProvider: SSHFileDecorationProvider;
    let unixFileService: ReturnType<typeof createMockFileService>;
    let unixConnMgr: ReturnType<typeof createMockConnectionManager>;

    beforeEach(() => {
      unixFileService = createMockFileService(unixTempDir);
      unixConnMgr = createMockConnectionManager();
      unixProvider = new SSHFileDecorationProvider(unixFileService as any, unixConnMgr as any);
    });

    afterEach(() => {
      unixProvider.dispose();
    });

    it('should recognize SSH files in macOS temp dir', () => {
      const uri = {
        scheme: 'file',
        fsPath: `${unixTempDir}/conn1/file.ts`,
      } as any;

      unixFileService.getFileMapping.mockReturnValue(undefined);
      const decoration = unixProvider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toContain('Not connected');
    });

    it('should not decorate files outside SSH temp dir on Unix', () => {
      const uri = {
        scheme: 'file',
        fsPath: '/home/user/Documents/file.ts',
      } as any;

      const decoration = unixProvider.provideFileDecoration(uri);
      expect(decoration).toBeUndefined();
    });

    it('should pass exact Unix paths to file service methods', () => {
      const filePath = `${unixTempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: filePath } as any;

      unixFileService.isFileUploading.mockReturnValue(false);
      unixFileService.isFileUploadFailed.mockReturnValue(false);
      unixFileService.getFileMapping.mockReturnValue({ connectionId: 'conn1' });
      unixConnMgr.getConnection.mockReturnValue({ id: 'conn1' });

      unixProvider.provideFileDecoration(uri);

      expect(unixFileService.isFileUploading).toHaveBeenCalledWith(filePath);
      expect(unixFileService.getFileMapping).toHaveBeenCalledWith(filePath);
    });
  });

  describe('filtered folder decoration (ssh:// scheme)', () => {
    function sshUri(connectionId: string, path: string) {
      return {
        scheme: 'ssh',
        toString: () => `ssh://${connectionId}${path}`,
      } as any;
    }

    it('should return undefined for ssh:// URIs when no filter is set', () => {
      const uri = sshUri('host:22:user', '/var/log');
      const decoration = provider.provideFileDecoration(uri);
      expect(decoration).toBeUndefined();
    });

    it('should highlight the filtered folder with blue color and F badge', () => {
      provider.setFilteredFolder('host:22:user', '/var/log');

      const uri = sshUri('host:22:user', '/var/log');
      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.badge).toBe('F');
      expect(decoration!.tooltip).toBe('Filtered folder');
    });

    it('should not highlight non-matching ssh:// URIs', () => {
      provider.setFilteredFolder('host:22:user', '/var/log');

      const uri = sshUri('host:22:user', '/var/log/subdir');
      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeUndefined();
    });

    it('should not highlight folders from a different connection', () => {
      provider.setFilteredFolder('host:22:user', '/var/log');

      const uri = sshUri('other:22:admin', '/var/log');
      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeUndefined();
    });

    it('should clear filtered folder decoration', () => {
      provider.setFilteredFolder('host:22:user', '/var/log');
      provider.clearFilteredFolder();

      const uri = sshUri('host:22:user', '/var/log');
      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeUndefined();
    });

    it('should support multiple filtered folders (additive)', () => {
      provider.setFilteredFolder('host:22:user', '/var/log');
      provider.setFilteredFolder('host:22:user', '/etc');

      const uri1 = sshUri('host:22:user', '/var/log');
      const uri2 = sshUri('host:22:user', '/etc');

      // Both should be highlighted (multi-filter support)
      expect(provider.provideFileDecoration(uri1)).toBeDefined();
      expect(provider.provideFileDecoration(uri1)!.badge).toBe('F');
      expect(provider.provideFileDecoration(uri2)).toBeDefined();
      expect(provider.provideFileDecoration(uri2)!.badge).toBe('F');
    });

    it('should clear specific filtered folder', () => {
      provider.setFilteredFolder('host:22:user', '/var/log');
      provider.setFilteredFolder('host:22:user', '/etc');

      const uri1 = sshUri('host:22:user', '/var/log');
      const uri2 = sshUri('host:22:user', '/etc');

      // Clear only /var/log
      provider.clearFilteredFolder('host:22:user', '/var/log');
      expect(provider.provideFileDecoration(uri1)).toBeUndefined();
      expect(provider.provideFileDecoration(uri2)).toBeDefined();
      expect(provider.provideFileDecoration(uri2)!.badge).toBe('F');
    });

    it('should not affect file:// URI decorations', () => {
      provider.setFilteredFolder('host:22:user', '/var/log');

      // Regular file outside temp dir — still undefined
      const fileUri = { scheme: 'file', fsPath: '/home/user/file.ts' } as any;
      expect(provider.provideFileDecoration(fileUri)).toBeUndefined();

      // SSH temp file — still gets orphaned decoration
      const sshTempUri = { scheme: 'file', fsPath: `${tempDir}/conn1/file.ts` } as any;
      fileService.getFileMapping.mockReturnValue(undefined);
      const decoration = provider.provideFileDecoration(sshTempUri);
      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toContain('Not connected');
    });
  });

  describe('empty folder graying (ssh:// scheme)', () => {
    function sshUri(connectionId: string, path: string) {
      return {
        scheme: 'ssh',
        toString: () => `ssh://${connectionId}${path}`,
      } as any;
    }

    it('should return undefined when no filter paths are set', () => {
      const uri = sshUri('host:22:user', '/var/log/empty');
      expect(provider.provideFileDecoration(uri)).toBeUndefined();
    });

    it('should gray out folders under basePath not in highlighted paths', () => {
      const highlighted = new Set(['/var/log', '/var/log/active']);
      provider.setFilenameFilterPaths(highlighted, '/var/log', 'host:22:user');

      const emptyUri = sshUri('host:22:user', '/var/log/empty');
      const decoration = provider.provideFileDecoration(emptyUri);

      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toBe('Not matching filter');
    });

    it('should not gray out folders in highlighted paths', () => {
      const highlighted = new Set(['/var/log', '/var/log/active']);
      provider.setFilenameFilterPaths(highlighted, '/var/log', 'host:22:user');

      const activeUri = sshUri('host:22:user', '/var/log/active');
      const decoration = provider.provideFileDecoration(activeUri);

      expect(decoration).toBeUndefined();
    });

    it('should not gray out folders outside basePath', () => {
      const highlighted = new Set(['/var/log']);
      provider.setFilenameFilterPaths(highlighted, '/var/log', 'host:22:user');

      const outsideUri = sshUri('host:22:user', '/opt/data/folder');
      const decoration = provider.provideFileDecoration(outsideUri);

      expect(decoration).toBeUndefined();
    });

    it('should not gray out folders from a different connection', () => {
      const highlighted = new Set(['/var/log']);
      provider.setFilenameFilterPaths(highlighted, '/var/log', 'host:22:user');

      const otherConnUri = sshUri('other:22:admin', '/var/log/empty');
      const decoration = provider.provideFileDecoration(otherConnUri);

      expect(decoration).toBeUndefined();
    });

    it('should prioritize filtered folder blue badge over empty graying', () => {
      const highlighted = new Set(['/var/log']);
      provider.setFilteredFolder('host:22:user', '/var/log');
      provider.setFilenameFilterPaths(highlighted, '/var/log', 'host:22:user');

      const baseUri = sshUri('host:22:user', '/var/log');
      const decoration = provider.provideFileDecoration(baseUri);

      expect(decoration).toBeDefined();
      expect(decoration!.badge).toBe('F');
    });

    it('should clear empty folder graying when clearFilteredFolder is called', () => {
      const highlighted = new Set(['/var/log']);
      provider.setFilteredFolder('host:22:user', '/var/log');
      provider.setFilenameFilterPaths(highlighted, '/var/log', 'host:22:user');

      provider.clearFilteredFolder();

      const emptyUri = sshUri('host:22:user', '/var/log/empty');
      expect(provider.provideFileDecoration(emptyUri)).toBeUndefined();
    });

    it('should work at nested depths', () => {
      const highlighted = new Set([
        '/var/log',
        '/var/log/archive',
        '/var/log/archive/2024',
      ]);
      provider.setFilenameFilterPaths(highlighted, '/var/log', 'host:22:user');

      // Highlighted ancestor directory — should NOT be grayed
      const activeUri = sshUri('host:22:user', '/var/log/archive/2024');
      expect(provider.provideFileDecoration(activeUri)).toBeUndefined();

      // Empty nested folder — SHOULD be grayed
      const emptyUri = sshUri('host:22:user', '/var/log/archive/2023');
      const decoration = provider.provideFileDecoration(emptyUri);
      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toBe('Not matching filter');
    });
  });

  describe('local file tooltips', () => {
    const mockedFs = fs as jest.Mocked<typeof fs>;
    const localFile = '/home/user/project/src/app.ts';
    const localDir = '/home/user/project/src';

    afterEach(() => {
      clearMockConfig();
    });

    it('should show tooltip with file info for local files', () => {
      const uri = { scheme: 'file', fsPath: localFile } as any;
      (mockedFs.statSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        size: 4300,
        birthtimeMs: 1706940000000,
        mtimeMs: 1706947170000,
        atimeMs: 1706950770000,
        mode: 0o100644, // rw-r--r--
      });

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).not.toContain('Path:');
      expect(decoration!.tooltip).toContain('Size:');
      expect(decoration!.tooltip).toContain('Created:');
      expect(decoration!.tooltip).toContain('Modified:');
      expect(decoration!.tooltip).toContain('Accessed:');
      expect(decoration!.tooltip).toContain('Permissions:');
      expect(decoration!.badge).toBeUndefined();
      expect(decoration!.color).toBeUndefined();
    });

    it('should show "Directory" for folder size', () => {
      const uri = { scheme: 'file', fsPath: localDir } as any;
      (mockedFs.statSync as jest.Mock).mockReturnValue({
        isDirectory: () => true,
        size: 4096,
        birthtimeMs: 1706940000000,
        mtimeMs: 1706947170000,
        atimeMs: 1706950770000,
        mode: 0o40755, // rwxr-xr-x
      });

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toContain('Size: Directory');
    });

    it('should format permissions correctly from mode bitmask', () => {
      const uri = { scheme: 'file', fsPath: localFile } as any;
      (mockedFs.statSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        size: 100,
        birthtimeMs: 1706940000000,
        mtimeMs: 1706947170000,
        atimeMs: 1706950770000,
        mode: 0o100755, // rwxr-xr-x
      });

      const decoration = provider.provideFileDecoration(uri);
      expect(decoration!.tooltip).toContain('rwxr-xr-x');
    });

    it('should format rw-r--r-- permissions', () => {
      const uri = { scheme: 'file', fsPath: localFile } as any;
      (mockedFs.statSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        size: 100,
        birthtimeMs: 1706940000000,
        mtimeMs: 1706947170000,
        atimeMs: 1706950770000,
        mode: 0o100644,
      });

      const decoration = provider.provideFileDecoration(uri);
      expect(decoration!.tooltip).toContain('rw-r--r--');
    });

    it('should return undefined when fs.statSync throws', () => {
      const uri = { scheme: 'file', fsPath: '/nonexistent/file.ts' } as any;
      (mockedFs.statSync as jest.Mock).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const decoration = provider.provideFileDecoration(uri);
      expect(decoration).toBeUndefined();
    });

    it('should return undefined when localFileTooltips setting is false', () => {
      setMockConfig('sshLite.localFileTooltips', false);
      const uri = { scheme: 'file', fsPath: localFile } as any;
      (mockedFs.statSync as jest.Mock).mockClear();

      const decoration = provider.provideFileDecoration(uri);
      expect(decoration).toBeUndefined();
      expect(mockedFs.statSync).not.toHaveBeenCalled();
    });

    it('should show tooltip when localFileTooltips setting is true', () => {
      setMockConfig('sshLite.localFileTooltips', true);
      const uri = { scheme: 'file', fsPath: localFile } as any;
      (mockedFs.statSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        size: 1024,
        birthtimeMs: 1706940000000,
        mtimeMs: 1706947170000,
        atimeMs: 1706950770000,
        mode: 0o100644,
      });

      const decoration = provider.provideFileDecoration(uri);
      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toContain('Size:');
    });

    it('should show tooltip by default (setting not explicitly set)', () => {
      // Default is true — no setMockConfig call
      const uri = { scheme: 'file', fsPath: localFile } as any;
      (mockedFs.statSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        size: 512,
        birthtimeMs: 1706940000000,
        mtimeMs: 1706947170000,
        atimeMs: 1706950770000,
        mode: 0o100644,
      });

      const decoration = provider.provideFileDecoration(uri);
      expect(decoration).toBeDefined();
    });
  });

  describe('local file tooltips — Windows paths', () => {
    const mockedFs = fs as jest.Mocked<typeof fs>;
    const winTempDir2 = 'c:\\users\\dev\\appdata\\local\\temp\\ssh-lite';
    let winProvider2: SSHFileDecorationProvider;
    let winFileService2: ReturnType<typeof createMockFileService>;
    let winConnMgr2: ReturnType<typeof createMockConnectionManager>;

    beforeEach(() => {
      winFileService2 = createMockFileService(winTempDir2);
      winConnMgr2 = createMockConnectionManager();
      winProvider2 = new SSHFileDecorationProvider(winFileService2 as any, winConnMgr2 as any);
    });

    afterEach(() => {
      winProvider2.dispose();
      clearMockConfig();
    });

    it('should show tooltip for Windows local files outside SSH temp dir', () => {
      const uri = { scheme: 'file', fsPath: 'D:\\Projects\\app\\main.ts' } as any;
      (mockedFs.statSync as jest.Mock).mockReturnValue({
        isDirectory: () => false,
        size: 2048,
        birthtimeMs: 1706940000000,
        mtimeMs: 1706947170000,
        atimeMs: 1706950770000,
        mode: 0o100666, // rw-rw-rw- (Windows typical)
      });

      const decoration = winProvider2.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).not.toContain('Path:');
      expect(decoration!.tooltip).toContain('Created:');
      expect(decoration!.tooltip).toContain('rw-rw-rw-');
    });

    it('should not show tooltip for Windows files when setting disabled', () => {
      setMockConfig('sshLite.localFileTooltips', false);
      const uri = { scheme: 'file', fsPath: 'D:\\Projects\\app\\main.ts' } as any;

      const decoration = winProvider2.provideFileDecoration(uri);
      expect(decoration).toBeUndefined();
    });
  });

  describe('remote tooltip on SSH temp files', () => {
    afterEach(() => {
      clearMockConfig();
    });

    it('should show remote file info with full IRemoteFile', () => {
      const localPath = `${tempDir}/conn1/app.log`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      fileService.getFileMapping.mockReturnValue({
        connectionId: 'myserver:22:root',
        remotePath: '/var/log/app.log',
        remoteFile: {
          path: '/var/log/app.log',
          size: 498073,
          modifiedTime: 1706947170000,
          accessTime: 1706950770000,
          owner: 'root',
          group: 'root',
          permissions: 'rw-r--r--',
        },
      });
      connectionManager.getConnection.mockReturnValue({ id: 'conn1' });

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toContain('Path: /var/log/app.log');
      expect(decoration!.tooltip).toContain('Server: myserver:22 (root)');
      expect(decoration!.tooltip).toContain('Owner: root:root');
      expect(decoration!.tooltip).toContain('Permissions: rw-r--r--');
      expect(decoration!.badge).toBeUndefined();
    });

    it('should fallback to lastRemoteSize/lastRemoteModTime when remoteFile is undefined', () => {
      const localPath = `${tempDir}/conn1/preloaded.txt`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      fileService.getFileMapping.mockReturnValue({
        connectionId: 'host:2222:admin',
        remotePath: '/home/admin/preloaded.txt',
        lastRemoteSize: 1024,
        lastRemoteModTime: 1706947170000,
        // remoteFile is undefined (preloaded file)
      });
      connectionManager.getConnection.mockReturnValue({ id: 'conn1' });

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeDefined();
      expect(decoration!.tooltip).toContain('Path: /home/admin/preloaded.txt');
      expect(decoration!.tooltip).toContain('Server: host:2222 (admin)');
      expect(decoration!.tooltip).toContain('Modified:');
      // Size and Modified should be resolved from fallbacks; Accessed/Owner/Permissions are N/A (no remoteFile)
      expect(decoration!.tooltip).toMatch(/Size: \d/); // not "Size: N/A"
      expect(decoration!.tooltip).not.toMatch(/Modified: N\/A/);
    });

    it('should show N/A for missing fields when no remoteFile and no fallbacks', () => {
      const localPath = `${tempDir}/conn1/minimal.txt`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      fileService.getFileMapping.mockReturnValue({
        connectionId: 'srv:22:user',
        remotePath: '/tmp/minimal.txt',
        // No remoteFile, no lastRemoteSize, no lastRemoteModTime
      });
      connectionManager.getConnection.mockReturnValue({ id: 'conn1' });

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration!.tooltip).toContain('Size: N/A');
      expect(decoration!.tooltip).toContain('Modified: N/A');
      expect(decoration!.tooltip).toContain('Accessed: N/A');
      expect(decoration!.tooltip).toContain('Owner: N/A');
      expect(decoration!.tooltip).toContain('Permissions: N/A');
    });

    it('should append remote tooltip to upload badge', () => {
      const localPath = `${tempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      fileService.isFileUploading.mockReturnValue(true);
      fileService.getFileMapping.mockReturnValue({
        connectionId: 'host:22:root',
        remotePath: '/app/file.ts',
        remoteFile: {
          path: '/app/file.ts',
          size: 500,
          modifiedTime: 1706947170000,
          owner: 'root',
          group: 'root',
          permissions: 'rw-r--r--',
        },
      });

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration!.badge).toBe('↑');
      expect(decoration!.tooltip).toContain('Uploading to server...');
      expect(decoration!.tooltip).toContain('Path: /app/file.ts');
      expect(decoration!.tooltip).toContain('Server: host:22 (root)');
    });

    it('should append remote tooltip to failed upload badge', () => {
      const localPath = `${tempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      fileService.isFileUploadFailed.mockReturnValue(true);
      fileService.getFileMapping.mockReturnValue({
        connectionId: 'host:22:root',
        remotePath: '/app/file.ts',
      });

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration!.badge).toBe('✗');
      expect(decoration!.tooltip).toContain('Upload failed');
      expect(decoration!.tooltip).toContain('Server: host:22 (root)');
    });

    it('should append remote tooltip to connection lost state', () => {
      const localPath = `${tempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      fileService.getFileMapping.mockReturnValue({
        connectionId: 'host:22:root',
        remotePath: '/app/file.ts',
      });
      connectionManager.getConnection.mockReturnValue(undefined);

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration!.tooltip).toContain('Connection lost');
      expect(decoration!.tooltip).toContain('Server: host:22 (root)');
    });

    it('should not show remote tooltip when setting is disabled', () => {
      setMockConfig('sshLite.localFileTooltips', false);
      const localPath = `${tempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      fileService.getFileMapping.mockReturnValue({
        connectionId: 'host:22:root',
        remotePath: '/app/file.ts',
      });
      connectionManager.getConnection.mockReturnValue({ id: 'conn1' });

      const decoration = provider.provideFileDecoration(uri);

      // Should return undefined (no tooltip when setting off and file is live)
      expect(decoration).toBeUndefined();
    });

    it('should still show upload badge when tooltips disabled (badge is independent)', () => {
      setMockConfig('sshLite.localFileTooltips', false);
      const localPath = `${tempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      fileService.isFileUploading.mockReturnValue(true);

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration!.badge).toBe('↑');
      expect(decoration!.tooltip).toBe('Uploading to server...');
      // No remote info appended
      expect(decoration!.tooltip).not.toContain('Server:');
    });
  });

  describe('event subscriptions', () => {
    it('should subscribe to file mapping changes', () => {
      expect(fileService.onFileMappingsChanged).toHaveBeenCalled();
    });

    it('should subscribe to upload state changes', () => {
      expect(fileService.onUploadStateChanged).toHaveBeenCalled();
    });

    it('should subscribe to connection changes', () => {
      expect(connectionManager.onDidChangeConnections).toHaveBeenCalled();
      expect(connectionManager.onConnectionStateChange).toHaveBeenCalled();
    });
  });
});
