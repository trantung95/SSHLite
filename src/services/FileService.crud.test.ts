/**
 * FileService CRUD tests - behavioral simulators
 *
 * Tests the delete, create folder, and open file flow logic.
 * Since FileService is tightly coupled to VS Code, these tests
 * simulate the core CRUD flow as behavioral tests.
 */

import { IRemoteFile } from '../types';
import { createMockRemoteFile } from '../__mocks__/testHelpers';

/**
 * Simulate the delete flow from FileService.deleteRemote
 */
class DeleteFlowSimulator {
  auditLog: Array<{ action: string; remotePath: string; success: boolean; error?: string }> = [];
  deletedPaths: string[] = [];
  backups: Map<string, string> = new Map(); // remotePath -> backupPath
  lastConfirmResult: string | undefined = undefined;

  // Track operations for directories
  directoryContents: Map<string, IRemoteFile[]> = new Map();

  async deleteRemote(
    remoteFile: IRemoteFile,
    confirmResult: string | undefined,
    createBackup = true
  ): Promise<boolean> {
    this.lastConfirmResult = confirmResult;

    if (!confirmResult) {
      return false;
    }

    const shouldBackup = confirmResult === 'Delete with Backup';

    try {
      let backupPath: string | undefined;

      // Create backup
      if (shouldBackup && createBackup) {
        if (remoteFile.isDirectory) {
          backupPath = `/tmp/.ssh-lite-backup/${remoteFile.name}_backup.tar.gz`;
        } else {
          backupPath = `/tmp/.ssh-lite-backup/${remoteFile.name}_backup`;
        }
        this.backups.set(remoteFile.path, backupPath);
      }

      // Perform deletion
      if (remoteFile.isDirectory) {
        await this.deleteDirectoryRecursive(remoteFile.path);
      } else {
        this.deletedPaths.push(remoteFile.path);
      }

      this.auditLog.push({
        action: 'delete',
        remotePath: remoteFile.path,
        success: true,
      });

      return true;
    } catch (error) {
      this.auditLog.push({
        action: 'delete',
        remotePath: remoteFile.path,
        success: false,
        error: (error as Error).message,
      });
      return false;
    }
  }

  private async deleteDirectoryRecursive(remotePath: string): Promise<void> {
    const files = this.directoryContents.get(remotePath) || [];

    for (const file of files) {
      if (file.isDirectory) {
        await this.deleteDirectoryRecursive(file.path);
      } else {
        this.deletedPaths.push(file.path);
      }
    }

    this.deletedPaths.push(remotePath);
  }
}

/**
 * Simulate the create folder flow from FileService.createFolder
 */
class CreateFolderSimulator {
  auditLog: Array<{ action: string; remotePath: string; success: boolean }> = [];
  createdPaths: string[] = [];

  async createFolder(
    parentPath: string,
    folderName: string | undefined,
    mkdirFails = false
  ): Promise<string | undefined> {
    if (!folderName) {
      return undefined;
    }

    const remotePath = `${parentPath}/${folderName}`;

    try {
      if (mkdirFails) {
        throw new Error('Permission denied');
      }

      this.createdPaths.push(remotePath);
      this.auditLog.push({
        action: 'mkdir',
        remotePath,
        success: true,
      });

      return remotePath;
    } catch (error) {
      return undefined;
    }
  }

  /**
   * Validate folder name (matches real validation logic)
   */
  static validateFolderName(value: string): string | null {
    if (!value || value.trim().length === 0) {
      return 'Folder name cannot be empty';
    }
    if (value.includes('/') || value.includes('\\')) {
      return 'Folder name cannot contain slashes';
    }
    return null;
  }
}

/**
 * Simulate the open file flow from FileService.openRemoteFile
 */
class OpenFileSimulator {
  mappings: Map<string, { localPath: string; remotePath: string; connectionId: string; originalContent: string }> = new Map();
  downloadedFiles: Map<string, Buffer> = new Map();
  openedLocalPaths: string[] = [];

  async openFile(
    connectionId: string,
    remoteFile: IRemoteFile,
    fileContent: Buffer,
    existingMapping?: string
  ): Promise<string> {
    const localPath = existingMapping || `/tmp/ssh-lite-${connectionId}${remoteFile.path}`;

    // Download file content
    this.downloadedFiles.set(remoteFile.path, fileContent);

    // Create mapping
    this.mappings.set(localPath, {
      localPath,
      remotePath: remoteFile.path,
      connectionId,
      originalContent: fileContent.toString(),
    });

    this.openedLocalPaths.push(localPath);
    return localPath;
  }

  getMapping(localPath: string) {
    return this.mappings.get(localPath);
  }
}

describe('FileService - Delete Flow', () => {
  let flow: DeleteFlowSimulator;

  beforeEach(() => {
    flow = new DeleteFlowSimulator();
  });

  describe('confirmation dialog', () => {
    it('should cancel when user dismisses dialog', async () => {
      const file = createMockRemoteFile('test.ts');
      const result = await flow.deleteRemote(file, undefined);
      expect(result).toBe(false);
      expect(flow.deletedPaths).toHaveLength(0);
    });

    it('should proceed with backup when user selects "Delete with Backup"', async () => {
      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      const result = await flow.deleteRemote(file, 'Delete with Backup');

      expect(result).toBe(true);
      expect(flow.backups.has('/home/user/test.ts')).toBe(true);
      expect(flow.deletedPaths).toContain('/home/user/test.ts');
    });

    it('should delete without backup when user selects "Delete Permanently"', async () => {
      const file = createMockRemoteFile('test.ts', { path: '/home/user/test.ts' });
      const result = await flow.deleteRemote(file, 'Delete Permanently');

      expect(result).toBe(true);
      expect(flow.backups.has('/home/user/test.ts')).toBe(false);
      expect(flow.deletedPaths).toContain('/home/user/test.ts');
    });
  });

  describe('file deletion', () => {
    it('should delete a single file', async () => {
      const file = createMockRemoteFile('config.json', { path: '/etc/config.json' });
      await flow.deleteRemote(file, 'Delete Permanently');

      expect(flow.deletedPaths).toEqual(['/etc/config.json']);
    });

    it('should log successful deletion', async () => {
      const file = createMockRemoteFile('test.ts', { path: '/test.ts' });
      await flow.deleteRemote(file, 'Delete Permanently');

      expect(flow.auditLog).toHaveLength(1);
      expect(flow.auditLog[0]).toEqual({
        action: 'delete',
        remotePath: '/test.ts',
        success: true,
      });
    });
  });

  describe('directory deletion', () => {
    it('should recursively delete directory contents', async () => {
      const dir = createMockRemoteFile('mydir', {
        path: '/home/user/mydir',
        isDirectory: true,
      });

      // Set up directory contents
      flow.directoryContents.set('/home/user/mydir', [
        createMockRemoteFile('file1.ts', { path: '/home/user/mydir/file1.ts' }),
        createMockRemoteFile('file2.ts', { path: '/home/user/mydir/file2.ts' }),
      ]);

      await flow.deleteRemote(dir, 'Delete Permanently');

      expect(flow.deletedPaths).toContain('/home/user/mydir/file1.ts');
      expect(flow.deletedPaths).toContain('/home/user/mydir/file2.ts');
      expect(flow.deletedPaths).toContain('/home/user/mydir'); // Directory itself
    });

    it('should recursively delete nested directories', async () => {
      const dir = createMockRemoteFile('root', {
        path: '/root',
        isDirectory: true,
      });

      flow.directoryContents.set('/root', [
        createMockRemoteFile('subdir', { path: '/root/subdir', isDirectory: true }),
      ]);
      flow.directoryContents.set('/root/subdir', [
        createMockRemoteFile('nested.txt', { path: '/root/subdir/nested.txt' }),
      ]);

      await flow.deleteRemote(dir, 'Delete Permanently');

      expect(flow.deletedPaths).toContain('/root/subdir/nested.txt');
      expect(flow.deletedPaths).toContain('/root/subdir');
      expect(flow.deletedPaths).toContain('/root');
    });

    it('should create tar.gz backup for directories', async () => {
      const dir = createMockRemoteFile('mydir', {
        path: '/home/user/mydir',
        isDirectory: true,
      });
      flow.directoryContents.set('/home/user/mydir', []);

      await flow.deleteRemote(dir, 'Delete with Backup');

      const backupPath = flow.backups.get('/home/user/mydir');
      expect(backupPath).toContain('.tar.gz');
    });
  });
});

describe('FileService - Create Folder Flow', () => {
  let flow: CreateFolderSimulator;

  beforeEach(() => {
    flow = new CreateFolderSimulator();
  });

  describe('folder name validation', () => {
    it('should reject empty name', () => {
      expect(CreateFolderSimulator.validateFolderName('')).not.toBeNull();
    });

    it('should reject whitespace-only name', () => {
      expect(CreateFolderSimulator.validateFolderName('   ')).not.toBeNull();
    });

    it('should reject name with forward slash', () => {
      expect(CreateFolderSimulator.validateFolderName('my/folder')).not.toBeNull();
    });

    it('should reject name with backslash', () => {
      expect(CreateFolderSimulator.validateFolderName('my\\folder')).not.toBeNull();
    });

    it('should accept valid name', () => {
      expect(CreateFolderSimulator.validateFolderName('my-folder')).toBeNull();
    });

    it('should accept name with special characters', () => {
      expect(CreateFolderSimulator.validateFolderName('my folder (1)')).toBeNull();
    });
  });

  describe('folder creation', () => {
    it('should return undefined when user cancels', async () => {
      const result = await flow.createFolder('/home/user', undefined);
      expect(result).toBeUndefined();
      expect(flow.createdPaths).toHaveLength(0);
    });

    it('should create folder with correct path', async () => {
      const result = await flow.createFolder('/home/user', 'projects');
      expect(result).toBe('/home/user/projects');
      expect(flow.createdPaths).toContain('/home/user/projects');
    });

    it('should log successful creation', async () => {
      await flow.createFolder('/home/user', 'projects');

      expect(flow.auditLog).toHaveLength(1);
      expect(flow.auditLog[0]).toEqual({
        action: 'mkdir',
        remotePath: '/home/user/projects',
        success: true,
      });
    });

    it('should return undefined on mkdir failure', async () => {
      const result = await flow.createFolder('/home/user', 'protected', true);
      expect(result).toBeUndefined();
    });
  });
});

describe('FileService - Open File Flow', () => {
  let flow: OpenFileSimulator;

  beforeEach(() => {
    flow = new OpenFileSimulator();
  });

  it('should download file content', async () => {
    const file = createMockRemoteFile('test.ts', { path: '/src/test.ts' });
    const content = Buffer.from('console.log("hello")');

    await flow.openFile('conn1', file, content);

    expect(flow.downloadedFiles.get('/src/test.ts')).toEqual(content);
  });

  it('should create a local mapping', async () => {
    const file = createMockRemoteFile('test.ts', { path: '/src/test.ts' });
    const content = Buffer.from('hello');

    const localPath = await flow.openFile('conn1', file, content);

    const mapping = flow.getMapping(localPath);
    expect(mapping).toBeDefined();
    expect(mapping!.remotePath).toBe('/src/test.ts');
    expect(mapping!.connectionId).toBe('conn1');
  });

  it('should store original content in mapping', async () => {
    const file = createMockRemoteFile('test.ts', { path: '/src/test.ts' });
    const content = Buffer.from('original content');

    const localPath = await flow.openFile('conn1', file, content);

    const mapping = flow.getMapping(localPath);
    expect(mapping!.originalContent).toBe('original content');
  });

  it('should reuse existing mapping path', async () => {
    const file = createMockRemoteFile('test.ts', { path: '/src/test.ts' });
    const content = Buffer.from('content');
    const existingPath = '/tmp/existing-mapping';

    const localPath = await flow.openFile('conn1', file, content, existingPath);

    expect(localPath).toBe(existingPath);
  });

  it('should track all opened files', async () => {
    const file1 = createMockRemoteFile('a.ts', { path: '/a.ts' });
    const file2 = createMockRemoteFile('b.ts', { path: '/b.ts' });

    await flow.openFile('conn1', file1, Buffer.from(''));
    await flow.openFile('conn1', file2, Buffer.from(''));

    expect(flow.openedLocalPaths).toHaveLength(2);
  });
});
