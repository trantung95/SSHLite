/**
 * HostTreeProvider tests
 *
 * Tests the host tree view including:
 * - Server grouping by host:port
 * - ServerTreeItem properties (icons, context values, descriptions)
 * - UserCredentialTreeItem display
 * - PinnedFolderTreeItem commands
 * - Tree refresh on connection changes
 */

import { IHostConfig, ConnectionState } from '../types';
import { SavedCredential, PinnedFolder } from '../services/CredentialService';
import { createMockHostConfig, createMockCredential, createMockPinnedFolder } from '../__mocks__/testHelpers';

// Mock dependencies
const mockGetAllHosts = jest.fn().mockReturnValue([]);
const mockGetAllConnections = jest.fn().mockReturnValue([]);
const mockListCredentials = jest.fn().mockReturnValue([]);
let mockConnectionChangeCallback: (() => void) | null = null;

jest.mock('../services/HostService', () => ({
  HostService: {
    getInstance: jest.fn().mockReturnValue({
      getAllHosts: mockGetAllHosts,
    }),
  },
}));

jest.mock('../connection/ConnectionManager', () => {
  const { EventEmitter } = require('../__mocks__/vscode');
  const emitter = new EventEmitter();
  // Capture the callback registered by HostTreeProvider
  const origEvent = emitter.event;
  emitter.event = (listener: any) => {
    mockConnectionChangeCallback = listener;
    return origEvent(listener);
  };
  return {
    ConnectionManager: {
      getInstance: jest.fn().mockReturnValue({
        getAllConnections: mockGetAllConnections,
        onDidChangeConnections: emitter.event,
      }),
    },
  };
});

jest.mock('../services/CredentialService', () => ({
  CredentialService: {
    getInstance: jest.fn().mockReturnValue({
      listCredentials: mockListCredentials,
    }),
  },
}));

import {
  HostTreeProvider,
  ServerTreeItem,
  UserCredentialTreeItem,
  PinnedFolderTreeItem,
  AddCredentialTreeItem,
} from './HostTreeProvider';

describe('HostTreeProvider', () => {
  let provider: HostTreeProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllHosts.mockReturnValue([]);
    mockGetAllConnections.mockReturnValue([]);
    mockListCredentials.mockReturnValue([]);
    provider = new HostTreeProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('root level (getChildren with no element)', () => {
    it('should return empty array when no hosts', () => {
      const items = provider.getChildren();
      expect(items).toEqual([]);
    });

    it('should group hosts by host:port', () => {
      const hosts: IHostConfig[] = [
        createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, username: 'user1', name: 'Server A' }),
        createMockHostConfig({ id: 'h2', host: '10.0.0.1', port: 22, username: 'user2', name: 'Server A' }),
        createMockHostConfig({ id: 'h3', host: '10.0.0.2', port: 22, username: 'admin', name: 'Server B' }),
      ];
      mockGetAllHosts.mockReturnValue(hosts);

      const items = provider.getChildren() as ServerTreeItem[];
      expect(items).toHaveLength(2); // Two servers: 10.0.0.1:22 and 10.0.0.2:22
    });

    it('should separate hosts with different ports', () => {
      const hosts: IHostConfig[] = [
        createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, username: 'user', name: 'S1' }),
        createMockHostConfig({ id: 'h2', host: '10.0.0.1', port: 2222, username: 'user', name: 'S2' }),
      ];
      mockGetAllHosts.mockReturnValue(hosts);

      const items = provider.getChildren() as ServerTreeItem[];
      expect(items).toHaveLength(2);
    });
  });

  describe('ServerTreeItem', () => {
    it('should use first host name as display name', () => {
      const hosts: IHostConfig[] = [
        createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, username: 'user1', name: 'My Server' }),
      ];
      mockGetAllHosts.mockReturnValue(hosts);

      const items = provider.getChildren() as ServerTreeItem[];
      expect(items[0].label).toBe('My Server');
    });

    it('should show host:port as description', () => {
      const hosts: IHostConfig[] = [
        createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, username: 'user', name: 'S1' }),
      ];
      mockGetAllHosts.mockReturnValue(hosts);

      const items = provider.getChildren() as ServerTreeItem[];
      expect(items[0].description).toBe('10.0.0.1:22');
    });

    it('should have stable ID for tree expansion tracking', () => {
      const hosts: IHostConfig[] = [
        createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, username: 'user', name: 'S1' }),
      ];
      mockGetAllHosts.mockReturnValue(hosts);

      const items = provider.getChildren() as ServerTreeItem[];
      expect(items[0].id).toBe('server:10.0.0.1:22');
    });

    it('should show vm-running icon when connected', () => {
      // Host id must match connection id format (host:port:username) for lookup
      const host = createMockHostConfig({ id: '10.0.0.1:22:user', host: '10.0.0.1', port: 22, username: 'user', name: 'S1' });
      const mockConn = { id: '10.0.0.1:22:user', state: ConnectionState.Connected };
      mockGetAllHosts.mockReturnValue([host]);
      mockGetAllConnections.mockReturnValue([mockConn]);

      const items = provider.getChildren() as ServerTreeItem[];
      expect(items[0].contextValue).toBe('connectedServer');
      expect((items[0].iconPath as any).id).toBe('vm-running');
    });

    it('should show vm icon when has saved credentials', () => {
      const host = createMockHostConfig({ id: 'h1' });
      mockGetAllHosts.mockReturnValue([host]);
      mockListCredentials.mockReturnValue([createMockCredential()]);

      const items = provider.getChildren() as ServerTreeItem[];
      expect(items[0].contextValue).toBe('savedServer');
      expect((items[0].iconPath as any).id).toBe('vm');
    });

    it('should show vm-outline icon when disconnected with no credentials', () => {
      const host = createMockHostConfig({ id: 'h1' });
      mockGetAllHosts.mockReturnValue([host]);
      mockListCredentials.mockReturnValue([]);

      const items = provider.getChildren() as ServerTreeItem[];
      expect(items[0].contextValue).toBe('server');
      expect((items[0].iconPath as any).id).toBe('vm-outline');
    });

    it('should expose primaryHost', () => {
      const host = createMockHostConfig({ id: 'h1', name: 'Primary' });
      mockGetAllHosts.mockReturnValue([host]);

      const items = provider.getChildren() as ServerTreeItem[];
      expect(items[0].primaryHost.name).toBe('Primary');
    });
  });

  describe('server children (UserCredentialTreeItem)', () => {
    it('should show users for a server', () => {
      const hosts: IHostConfig[] = [
        createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, username: 'user1', name: 'S1' }),
        createMockHostConfig({ id: 'h2', host: '10.0.0.1', port: 22, username: 'user2', name: 'S1' }),
      ];
      mockGetAllHosts.mockReturnValue(hosts);

      const serverItems = provider.getChildren() as ServerTreeItem[];
      const children = provider.getChildren(serverItems[0]);

      // 2 users + 1 "Add User" item
      expect(children).toHaveLength(3);
    });

    it('should include AddCredentialTreeItem at the end', () => {
      const hosts: IHostConfig[] = [
        createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, username: 'user', name: 'S1' }),
      ];
      mockGetAllHosts.mockReturnValue(hosts);

      const serverItems = provider.getChildren() as ServerTreeItem[];
      const children = provider.getChildren(serverItems[0]);
      const lastItem = children[children.length - 1];

      expect(lastItem).toBeInstanceOf(AddCredentialTreeItem);
      expect(lastItem.label).toBe('Add User...');
    });
  });

  describe('UserCredentialTreeItem', () => {
    it('should display username as label', () => {
      const host = createMockHostConfig({ username: 'admin' });
      const item = new UserCredentialTreeItem(host, null, false);
      expect(item.label).toBe('admin');
    });

    it('should show "Password saved" for password credential', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential({ type: 'password' });
      const item = new UserCredentialTreeItem(host, cred, false);
      expect(item.description).toBe('Password saved');
    });

    it('should show "Private Key" for privateKey credential', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential({ type: 'privateKey' });
      const item = new UserCredentialTreeItem(host, cred, false);
      expect(item.description).toBe('Private Key');
    });

    it('should show "No password saved" when no credential', () => {
      const host = createMockHostConfig();
      const item = new UserCredentialTreeItem(host, null, false);
      expect(item.description).toBe('No password saved');
    });

    it('should set contextValue to credentialConnected when connected', () => {
      const host = createMockHostConfig();
      const item = new UserCredentialTreeItem(host, null, true);
      expect(item.contextValue).toBe('credentialConnected');
    });

    it('should set contextValue to credential when disconnected', () => {
      const host = createMockHostConfig();
      const item = new UserCredentialTreeItem(host, null, false);
      expect(item.contextValue).toBe('credential');
    });

    it('should have connect command when disconnected', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const item = new UserCredentialTreeItem(host, cred, false);
      expect(item.command?.command).toBe('sshLite.connectWithCredential');
    });

    it('should not have connect command when connected', () => {
      const host = createMockHostConfig();
      const item = new UserCredentialTreeItem(host, null, true);
      expect(item.command).toBeUndefined();
    });

    it('should show key icon when credential is saved', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const item = new UserCredentialTreeItem(host, cred, false);
      expect((item.iconPath as any).id).toBe('key');
    });

    it('should show person icon when no credential', () => {
      const host = createMockHostConfig();
      const item = new UserCredentialTreeItem(host, null, false);
      expect((item.iconPath as any).id).toBe('person');
    });
  });

  describe('PinnedFolderTreeItem', () => {
    it('should display folder name as label', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const folder = createMockPinnedFolder({ name: 'My Projects' });
      const item = new PinnedFolderTreeItem(host, cred, folder);
      expect(item.label).toBe('My Projects');
    });

    it('should show remotePath as description', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const folder = createMockPinnedFolder({ remotePath: '/home/user/projects' });
      const item = new PinnedFolderTreeItem(host, cred, folder);
      expect(item.description).toBe('/home/user/projects');
    });

    it('should use goToPath command when connected', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const folder = createMockPinnedFolder({ remotePath: '/projects' });
      const item = new PinnedFolderTreeItem(host, cred, folder, true);
      expect(item.command?.command).toBe('sshLite.goToPath');
      expect(item.contextValue).toBe('pinnedFolderConnected');
    });

    it('should use connectToPinnedFolder command when disconnected', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const folder = createMockPinnedFolder({ remotePath: '/projects' });
      const item = new PinnedFolderTreeItem(host, cred, folder, false);
      expect(item.command?.command).toBe('sshLite.connectToPinnedFolder');
      expect(item.contextValue).toBe('pinnedFolder');
    });

    it('should have folder icon', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();
      const folder = createMockPinnedFolder();
      const item = new PinnedFolderTreeItem(host, cred, folder);
      expect((item.iconPath as any).id).toBe('folder');
    });
  });

  describe('pinned folders in tree hierarchy', () => {
    it('should show pinned folders as children of credential', () => {
      const host = createMockHostConfig();
      const pinnedFolders: PinnedFolder[] = [
        createMockPinnedFolder({ name: 'Projects', remotePath: '/projects' }),
        createMockPinnedFolder({ name: 'Logs', remotePath: '/var/log' }),
      ];
      const cred = createMockCredential({ pinnedFolders });
      const credItem = new UserCredentialTreeItem(host, cred, false, true);

      const children = provider.getChildren(credItem);
      expect(children).toHaveLength(2);
      expect(children[0]).toBeInstanceOf(PinnedFolderTreeItem);
      expect(children[1]).toBeInstanceOf(PinnedFolderTreeItem);
    });

    it('should return empty for credential with no pinned folders', () => {
      const host = createMockHostConfig();
      const cred = createMockCredential({ pinnedFolders: [] });
      const credItem = new UserCredentialTreeItem(host, cred, false);

      const children = provider.getChildren(credItem);
      expect(children).toEqual([]);
    });
  });

  describe('refresh', () => {
    it('should fire onDidChangeTreeData on manual refresh', () => {
      const listener = jest.fn();
      provider.onDidChangeTreeData(listener);

      provider.refresh();

      expect(listener).toHaveBeenCalled();
    });

    it('should refresh when connections change', () => {
      const listener = jest.fn();
      provider.onDidChangeTreeData(listener);

      // Simulate connection change
      if (mockConnectionChangeCallback) {
        mockConnectionChangeCallback();
      }

      expect(listener).toHaveBeenCalled();
    });
  });

  describe('getTreeItem', () => {
    it('should return the element itself', () => {
      const host = createMockHostConfig();
      const item = new UserCredentialTreeItem(host, null, false);

      const treeItem = provider.getTreeItem(item);
      expect(treeItem).toBe(item);
    });
  });
});
