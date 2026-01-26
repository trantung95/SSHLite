import { CredentialService, SavedCredential, PinnedFolder } from './CredentialService';
import { setMockConfig, clearMockConfig, workspace } from '../__mocks__/vscode';

/**
 * Helper: Make workspace.getConfiguration().update actually persist changes
 * so subsequent reads via getCredentialIndex() see the updated data.
 */
function enableConfigPersistence(): void {
  const getConfig = workspace.getConfiguration as jest.Mock;
  if (!getConfig.mockImplementation) {
    // Already using the default mock, just need to intercept update
  }
  // Override update to also persist to the mock config store
  const origGetConfig = workspace.getConfiguration;
  (workspace as any).getConfiguration = (section?: string) => {
    const config = origGetConfig(section);
    config.update = jest.fn().mockImplementation(
      (key: string, value: unknown, _target: unknown) => {
        const fullKey = section ? `${section}.${key}` : key;
        setMockConfig(fullKey, value);
        return Promise.resolve();
      }
    );
    return config;
  };
}

function resetCredentialService(): CredentialService {
  try {
    CredentialService.getInstance().dispose();
  } catch {
    // ignore
  }
  // Reset the singleton by clearing the private static instance
  (CredentialService as any)._instance = undefined;
  return CredentialService.getInstance();
}

describe('CredentialService - Pinned Folders', () => {
  let service: CredentialService;

  const hostId = 'test-host-1';
  const credentialId = 'cred_123_abc';

  beforeEach(() => {
    clearMockConfig();
    enableConfigPersistence();
    service = resetCredentialService();
    // Initialize with a mock context (for secretStorage)
    service.initialize({
      secrets: {
        get: jest.fn().mockResolvedValue(undefined),
        store: jest.fn().mockResolvedValue(undefined),
        delete: jest.fn().mockResolvedValue(undefined),
        onDidChange: jest.fn(),
      },
    } as any);
  });

  afterEach(() => {
    clearMockConfig();
  });

  function setupCredentialIndex(pinnedFolders?: PinnedFolder[]): void {
    const credential: SavedCredential = {
      id: credentialId,
      label: 'Default',
      type: 'password',
      pinnedFolders: pinnedFolders || [],
    };
    setMockConfig('sshLite.credentialIndex', {
      [hostId]: [credential],
    });
  }

  describe('addPinnedFolder', () => {
    it('should create a pinned folder with pin_ prefix ID', async () => {
      setupCredentialIndex();

      const folder = await service.addPinnedFolder(hostId, credentialId, 'Projects', '/home/user/projects');

      expect(folder.id).toMatch(/^pin_/);
      expect(folder.name).toBe('Projects');
      expect(folder.remotePath).toBe('/home/user/projects');
    });

    it('should add folder to credential pinnedFolders array', async () => {
      setupCredentialIndex();

      await service.addPinnedFolder(hostId, credentialId, 'Projects', '/home/user/projects');

      const folders = service.getPinnedFolders(hostId, credentialId);
      expect(folders).toHaveLength(1);
      expect(folders[0].name).toBe('Projects');
    });

    it('should initialize pinnedFolders array if not present', async () => {
      // Set up credential without pinnedFolders field
      const credential: SavedCredential = {
        id: credentialId,
        label: 'Default',
        type: 'password',
        // No pinnedFolders field
      };
      setMockConfig('sshLite.credentialIndex', {
        [hostId]: [credential],
      });

      const folder = await service.addPinnedFolder(hostId, credentialId, 'Home', '/home/user');

      expect(folder.name).toBe('Home');
      const folders = service.getPinnedFolders(hostId, credentialId);
      expect(folders).toHaveLength(1);
    });

    it('should support multiple pinned folders', async () => {
      setupCredentialIndex();

      await service.addPinnedFolder(hostId, credentialId, 'Projects', '/home/user/projects');
      await service.addPinnedFolder(hostId, credentialId, 'Logs', '/var/log');
      await service.addPinnedFolder(hostId, credentialId, 'Config', '/etc');

      const folders = service.getPinnedFolders(hostId, credentialId);
      expect(folders).toHaveLength(3);
      expect(folders.map(f => f.name)).toEqual(['Projects', 'Logs', 'Config']);
    });

    it('should throw if host not found', async () => {
      setMockConfig('sshLite.credentialIndex', {});

      await expect(
        service.addPinnedFolder('nonexistent', credentialId, 'Test', '/test')
      ).rejects.toThrow('Host not found');
    });

    it('should throw if credential not found', async () => {
      setMockConfig('sshLite.credentialIndex', {
        [hostId]: [{ id: 'other_cred', label: 'Other', type: 'password' }],
      });

      await expect(
        service.addPinnedFolder(hostId, credentialId, 'Test', '/test')
      ).rejects.toThrow('Credential not found');
    });
  });

  describe('deletePinnedFolder', () => {
    it('should remove a pinned folder by ID', async () => {
      const existingFolder: PinnedFolder = { id: 'pin_1', name: 'Projects', remotePath: '/projects' };
      setupCredentialIndex([existingFolder]);

      await service.deletePinnedFolder(hostId, credentialId, 'pin_1');

      const folders = service.getPinnedFolders(hostId, credentialId);
      expect(folders).toHaveLength(0);
    });

    it('should not affect other pinned folders', async () => {
      const folders: PinnedFolder[] = [
        { id: 'pin_1', name: 'Projects', remotePath: '/projects' },
        { id: 'pin_2', name: 'Logs', remotePath: '/var/log' },
        { id: 'pin_3', name: 'Config', remotePath: '/etc' },
      ];
      setupCredentialIndex(folders);

      await service.deletePinnedFolder(hostId, credentialId, 'pin_2');

      const remaining = service.getPinnedFolders(hostId, credentialId);
      expect(remaining).toHaveLength(2);
      expect(remaining.map(f => f.id)).toEqual(['pin_1', 'pin_3']);
    });

    it('should do nothing if folder not found', async () => {
      setupCredentialIndex([{ id: 'pin_1', name: 'Projects', remotePath: '/projects' }]);

      // Should not throw
      await service.deletePinnedFolder(hostId, credentialId, 'nonexistent');

      const folders = service.getPinnedFolders(hostId, credentialId);
      expect(folders).toHaveLength(1);
    });

    it('should do nothing if host not found', async () => {
      setMockConfig('sshLite.credentialIndex', {});

      // Should not throw
      await service.deletePinnedFolder('nonexistent', credentialId, 'pin_1');
    });
  });

  describe('renamePinnedFolder', () => {
    it('should update the folder name', async () => {
      setupCredentialIndex([{ id: 'pin_1', name: 'Old Name', remotePath: '/projects' }]);

      await service.renamePinnedFolder(hostId, credentialId, 'pin_1', 'New Name');

      const folders = service.getPinnedFolders(hostId, credentialId);
      expect(folders[0].name).toBe('New Name');
    });

    it('should preserve the remotePath when renaming', async () => {
      setupCredentialIndex([{ id: 'pin_1', name: 'Projects', remotePath: '/home/user/projects' }]);

      await service.renamePinnedFolder(hostId, credentialId, 'pin_1', 'My Projects');

      const folders = service.getPinnedFolders(hostId, credentialId);
      expect(folders[0].remotePath).toBe('/home/user/projects');
    });

    it('should do nothing if folder not found', async () => {
      setupCredentialIndex([{ id: 'pin_1', name: 'Projects', remotePath: '/projects' }]);

      await service.renamePinnedFolder(hostId, credentialId, 'nonexistent', 'New Name');

      const folders = service.getPinnedFolders(hostId, credentialId);
      expect(folders[0].name).toBe('Projects'); // Unchanged
    });
  });

  describe('getPinnedFolders', () => {
    it('should return empty array when no pinned folders', async () => {
      setupCredentialIndex();

      const folders = service.getPinnedFolders(hostId, credentialId);
      expect(folders).toEqual([]);
    });

    it('should return empty array for non-existent credential', () => {
      setMockConfig('sshLite.credentialIndex', {});

      const folders = service.getPinnedFolders('nonexistent', 'nonexistent');
      expect(folders).toEqual([]);
    });

    it('should return all pinned folders for a credential', () => {
      const pinnedFolders: PinnedFolder[] = [
        { id: 'pin_1', name: 'Projects', remotePath: '/projects' },
        { id: 'pin_2', name: 'Logs', remotePath: '/var/log' },
      ];
      setupCredentialIndex(pinnedFolders);

      const result = service.getPinnedFolders(hostId, credentialId);
      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('Projects');
      expect(result[1].name).toBe('Logs');
    });
  });
});
