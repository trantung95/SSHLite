/**
 * SSHFileDecorationProvider tests
 *
 * Tests file decoration logic:
 * - No decoration for non-SSH files
 * - Gray decoration for orphaned SSH temp files
 * - Gray decoration when connection is lost
 * - No decoration for active SSH files
 */

import { Uri, ThemeColor } from '../__mocks__/vscode';
import { SSHFileDecorationProvider } from './FileDecorationProvider';

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
    it('should return undefined (no decoration) when file is live', () => {
      const localPath = `${tempDir}/conn1/file.ts`;
      const uri = { scheme: 'file', fsPath: localPath } as any;

      // Has mapping AND active connection
      fileService.getFileMapping.mockReturnValue({ connectionId: 'conn1' });
      connectionManager.getConnection.mockReturnValue({ id: 'conn1' });

      const decoration = provider.provideFileDecoration(uri);

      expect(decoration).toBeUndefined();
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

      winFileService.getFileMapping.mockReturnValue({ connectionId: 'conn1' });
      winConnMgr.getConnection.mockReturnValue({ id: 'conn1' });

      const decoration = winProvider.provideFileDecoration(uri);

      expect(decoration).toBeUndefined(); // Active file, no decoration
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
