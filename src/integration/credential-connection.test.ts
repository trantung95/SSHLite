/**
 * Integration tests - Credential + Connection + Tree flows
 *
 * Tests the full lifecycle of connecting with credentials,
 * tree view updates, and pinned folder interactions.
 * All SSH connections are mocked.
 */

import { IHostConfig, ConnectionState } from '../types';
import { SavedCredential, PinnedFolder, CredentialService } from '../services/CredentialService';
import {
  ServerTreeItem,
  UserCredentialTreeItem,
  PinnedFolderTreeItem,
  AddCredentialTreeItem,
} from '../providers/HostTreeProvider';
import { createMockHostConfig, createMockCredential, createMockPinnedFolder, createMockConnection } from '../__mocks__/testHelpers';
import { setMockConfig, clearMockConfig, workspace } from '../__mocks__/vscode';

/**
 * Helper: Make workspace config actually persist updates
 */
function enableConfigPersistence(): void {
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

describe('Integration: Credential + Connection + Tree', () => {
  beforeEach(() => {
    clearMockConfig();
    enableConfigPersistence();
  });

  afterEach(() => {
    clearMockConfig();
  });

  describe('connect with credential flow', () => {
    it('should format connection ID as host:port:username', () => {
      const host = createMockHostConfig({
        host: '192.168.1.50',
        port: 2222,
        username: 'deploy',
      });
      const expectedId = '192.168.1.50:2222:deploy';

      const conn = createMockConnection({ host });
      expect(conn.id).toBe(expectedId);
    });

    it('should create credential with unique ID', () => {
      const cred = createMockCredential({ id: 'cred_123_abc' });
      expect(cred.id).toMatch(/^cred_/);
      expect(cred.type).toBe('password');
    });

    it('should store credential in CredentialService', async () => {
      // Reset and initialize CredentialService
      (CredentialService as any)._instance = undefined;
      const credService = CredentialService.getInstance();
      credService.initialize({
        secrets: {
          get: jest.fn().mockResolvedValue(undefined),
          store: jest.fn().mockResolvedValue(undefined),
          delete: jest.fn().mockResolvedValue(undefined),
          onDidChange: jest.fn(),
        },
      } as any);

      // Set up empty credential index
      setMockConfig('sshLite.credentialIndex', {});

      const hostId = 'test-host';
      const cred = await credService.addCredential(
        hostId,
        'My Password',
        'password',
        'secret123'
      );

      expect(cred.id).toMatch(/^cred_/);
      expect(cred.label).toBe('My Password');

      const credentials = credService.listCredentials(hostId);
      expect(credentials).toHaveLength(1);
    });
  });

  describe('server tree item display based on connection state', () => {
    it('should show connected icon when host is connected', () => {
      const hosts: IHostConfig[] = [createMockHostConfig({ id: 'h1' })];
      const item = new ServerTreeItem('10.0.0.1:22', hosts, true);

      expect(item.isConnected).toBe(true);
      expect(item.contextValue).toBe('connectedServer.saved');
    });

    it('should show disconnected icon when host is not connected', () => {
      const hosts: IHostConfig[] = [createMockHostConfig({ id: 'h1' })];
      const item = new ServerTreeItem('10.0.0.1:22', hosts, false);

      expect(item.isConnected).toBe(false);
      // Context depends on credential state, but it should not be 'connectedServer'
      expect(item.contextValue).not.toBe('connectedServer');
    });

    it('should use first host name as label', () => {
      const hosts: IHostConfig[] = [
        createMockHostConfig({ id: 'h1', name: 'Production' }),
        createMockHostConfig({ id: 'h2', name: 'Staging' }),
      ];
      const item = new ServerTreeItem('10.0.0.1:22', hosts, false);

      expect(item.label).toBe('Production');
    });
  });

  describe('credential tree item behavior', () => {
    it('should show connect command when disconnected', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const item = new UserCredentialTreeItem(host, cred, false);

      expect(item.command?.command).toBe('sshLite.connectWithCredential');
      expect(item.command?.arguments).toContain(host);
      expect(item.command?.arguments).toContain(cred);
    });

    it('should not show connect command when already connected', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const item = new UserCredentialTreeItem(host, cred, true);

      expect(item.command).toBeUndefined();
    });

    it('should show different description for different credential types', () => {
      const host = createMockHostConfig();

      const pwItem = new UserCredentialTreeItem(
        host,
        createMockCredential({ type: 'password' }),
        false
      );
      expect(pwItem.description).toBe('Password saved');

      const keyItem = new UserCredentialTreeItem(
        host,
        createMockCredential({ type: 'privateKey' }),
        false
      );
      expect(keyItem.description).toBe('Private Key');

      const noCredItem = new UserCredentialTreeItem(host, null, false);
      expect(noCredItem.description).toBe('No password saved');
    });
  });

  describe('pinned folder lifecycle', () => {
    it('should add, rename, and delete a pinned folder', async () => {
      (CredentialService as any)._instance = undefined;
      const credService = CredentialService.getInstance();
      credService.initialize({
        secrets: {
          get: jest.fn().mockResolvedValue(undefined),
          store: jest.fn().mockResolvedValue(undefined),
          delete: jest.fn().mockResolvedValue(undefined),
          onDidChange: jest.fn(),
        },
      } as any);

      const hostId = 'int-host';
      const credId = 'int-cred';
      setMockConfig('sshLite.credentialIndex', {
        [hostId]: [{
          id: credId,
          label: 'Default',
          type: 'password' as const,
          pinnedFolders: [],
        }],
      });

      // Add
      const folder = await credService.addPinnedFolder(hostId, credId, 'Projects', '/home/user/projects');
      expect(folder.name).toBe('Projects');
      expect(folder.remotePath).toBe('/home/user/projects');

      let folders = credService.getPinnedFolders(hostId, credId);
      expect(folders).toHaveLength(1);

      // Rename
      await credService.renamePinnedFolder(hostId, credId, folder.id, 'My Projects');
      folders = credService.getPinnedFolders(hostId, credId);
      expect(folders[0].name).toBe('My Projects');

      // Delete
      await credService.deletePinnedFolder(hostId, credId, folder.id);
      folders = credService.getPinnedFolders(hostId, credId);
      expect(folders).toHaveLength(0);
    });
  });

  describe('pinned folder tree item based on connection state', () => {
    it('should use goToPath when connected', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const folder = createMockPinnedFolder({
        name: 'Logs',
        remotePath: '/var/log',
      });

      const item = new PinnedFolderTreeItem(host, cred, folder, true);

      expect(item.command?.command).toBe('sshLite.goToPath');
      expect(item.command?.arguments).toContain('/var/log');
      expect(item.contextValue).toBe('pinnedFolderConnected');
    });

    it('should use connectToPinnedFolder when disconnected', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const folder = createMockPinnedFolder({
        name: 'Logs',
        remotePath: '/var/log',
      });

      const item = new PinnedFolderTreeItem(host, cred, folder, false);

      expect(item.command?.command).toBe('sshLite.connectToPinnedFolder');
      expect(item.command?.arguments).toContain(host);
      expect(item.command?.arguments).toContain(cred);
      expect(item.command?.arguments).toContain(folder);
      expect(item.contextValue).toBe('pinnedFolder');
    });

    it('should display folder name and path', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const folder = createMockPinnedFolder({
        name: 'My Logs',
        remotePath: '/var/log/myapp',
      });

      const item = new PinnedFolderTreeItem(host, cred, folder);

      expect(item.label).toBe('My Logs');
      expect(item.description).toBe('/var/log/myapp');
    });
  });

  describe('tree hierarchy with pinned folders', () => {
    it('should show credential as expandable when it has pinned folders', () => {
      const host = createMockHostConfig();
      const pinnedFolders: PinnedFolder[] = [
        createMockPinnedFolder({ name: 'Projects' }),
      ];
      const cred = createMockCredential({ pinnedFolders });

      const item = new UserCredentialTreeItem(host, cred, false, true);

      // TreeItemCollapsibleState.Collapsed = 1
      expect(item.collapsibleState).toBe(1);
    });

    it('should show credential as non-expandable when no pinned folders', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential({ pinnedFolders: [] });

      const item = new UserCredentialTreeItem(host, cred, false, false);

      // TreeItemCollapsibleState.None = 0
      expect(item.collapsibleState).toBe(0);
    });
  });

  describe('AddCredentialTreeItem', () => {
    it('should have correct label and command', () => {
      const hosts = [createMockHostConfig()];
      const serverItem = new ServerTreeItem('10.0.0.1:22', hosts, false);
      const addItem = new AddCredentialTreeItem(serverItem);

      expect(addItem.label).toBe('Add User...');
      expect(addItem.command?.command).toBe('sshLite.addCredential');
      expect(addItem.contextValue).toBe('addCredential');
    });
  });
});
