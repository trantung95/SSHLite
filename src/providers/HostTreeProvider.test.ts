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
        getLastConnectionAttempt: jest.fn().mockReturnValue(undefined),
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
      expect(items[0].contextValue).toBe('connectedServer.saved');
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

    it('should show vm-outline icon when SSH config host disconnected with no credentials', () => {
      // SSH config hosts (source: 'ssh-config') without credentials show as 'server'
      const host = createMockHostConfig({ id: 'h1', source: 'ssh-config' });
      mockGetAllHosts.mockReturnValue([host]);
      mockListCredentials.mockReturnValue([]);

      const items = provider.getChildren() as ServerTreeItem[];
      expect(items[0].contextValue).toBe('server');
      expect((items[0].iconPath as any).id).toBe('vm-outline');
    });

    it('should show vm icon when saved host disconnected with no credentials', () => {
      // Manually added hosts (source: 'saved') without credentials show as 'savedServer'
      const host = createMockHostConfig({ id: 'h1', source: 'saved' });
      mockGetAllHosts.mockReturnValue([host]);
      mockListCredentials.mockReturnValue([]);

      const items = provider.getChildren() as ServerTreeItem[];
      expect(items[0].contextValue).toBe('savedServer');
      expect((items[0].iconPath as any).id).toBe('vm');
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

  describe('host filter', () => {
    const setupHosts = () => {
      const hosts: IHostConfig[] = [
        createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, username: 'admin', name: 'Production' }),
        createMockHostConfig({ id: 'h2', host: '10.0.0.2', port: 22, username: 'deploy', name: 'Staging' }),
        createMockHostConfig({ id: 'h3', host: '192.168.1.100', port: 2222, username: 'root', name: 'Dev Server' }),
      ];
      mockGetAllHosts.mockReturnValue(hosts);
      return hosts;
    };

    it('should return all hosts when no filter is set', () => {
      setupHosts();
      const items = provider.getChildren() as ServerTreeItem[];
      expect(items).toHaveLength(3);
    });

    it('should filter by host display name (substring)', () => {
      setupHosts();
      provider.setFilter('prod');
      const items = provider.getChildren() as ServerTreeItem[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('Production');
    });

    it('should filter by hostname', () => {
      setupHosts();
      provider.setFilter('192.168');
      const items = provider.getChildren() as ServerTreeItem[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('Dev Server');
    });

    it('should filter by username', () => {
      setupHosts();
      provider.setFilter('deploy');
      const items = provider.getChildren() as ServerTreeItem[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('Staging');
    });

    it('should filter by host:port server key', () => {
      setupHosts();
      provider.setFilter('10.0.0.1:22');
      const items = provider.getChildren() as ServerTreeItem[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('Production');
    });

    it('should be case insensitive', () => {
      setupHosts();
      provider.setFilter('STAGING');
      const items = provider.getChildren() as ServerTreeItem[];
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('Staging');
    });

    it('should support glob wildcards', () => {
      setupHosts();
      provider.setFilter('10.0.0.*');
      const items = provider.getChildren() as ServerTreeItem[];
      expect(items).toHaveLength(2);
    });

    it('should support ? wildcard for single char', () => {
      setupHosts();
      provider.setFilter('*?erver');
      const items = provider.getChildren() as ServerTreeItem[];
      // 'Dev Server' and 'Staging' don't match, but 'Production' doesn't either...
      // Actually all three have 'Server' in serverKey or name? 'Dev Server' has 'Server' in name
      // Let's check: 'Production' name, 'Staging' name, 'Dev Server' name
      // *?erver matches any string ending with one char + 'erver', effectively any string containing 'erver'
      // '10.0.0.1:22' - no, 'Production' - no, 'admin' - no
      // '10.0.0.2:22' - no, 'Staging' - no, 'deploy' - no
      // '192.168.1.100:2222' - no, 'Dev Server' - 'Server' matches *?erver, yes
      expect(items).toHaveLength(1);
      expect(items[0].label).toBe('Dev Server');
    });

    it('should clear filter and show all hosts again', () => {
      setupHosts();
      provider.setFilter('prod');
      expect(provider.getChildren()).toHaveLength(1);

      provider.clearFilter();
      expect(provider.getChildren()).toHaveLength(3);
    });

    it('should return empty when filter matches nothing', () => {
      setupHosts();
      provider.setFilter('nonexistent');
      const items = provider.getChildren();
      expect(items).toHaveLength(0);
    });

    it('should report filter pattern via getFilter', () => {
      provider.setFilter('test');
      expect(provider.getFilter()).toBe('test');

      provider.clearFilter();
      expect(provider.getFilter()).toBe('');
    });

    it('should match any username in a multi-user server', () => {
      const hosts: IHostConfig[] = [
        createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, username: 'user1', name: 'Multi' }),
        createMockHostConfig({ id: 'h2', host: '10.0.0.1', port: 22, username: 'user2', name: 'Multi' }),
      ];
      mockGetAllHosts.mockReturnValue(hosts);

      // Filter by second username should still show the server
      provider.setFilter('user2');
      const items = provider.getChildren() as ServerTreeItem[];
      expect(items).toHaveLength(1);
      expect(items[0].hosts).toHaveLength(2);
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

  describe('Last Failed Connection Indicator', () => {
    const failedAttempt = {
      timestamp: Date.now() - 60_000, // 1 minute ago
      success: false,
      errorMessage: 'Connection refused',
      errorCode: 'ECONNREFUSED',
    };

    describe('ServerTreeItem unit tests', () => {
      it('should show orange vm-outline icon when lastFailedAttempt is present', () => {
        const hosts = [createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1' })];
        const item = new ServerTreeItem('10.0.0.1:22', hosts, false, failedAttempt);

        expect((item.iconPath as any).id).toBe('vm-outline');
        expect((item.iconPath as any).color.id).toBe('charts.orange');
      });

      it('should show error details in tooltip when lastFailedAttempt is present', () => {
        const hosts = [createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1', username: 'admin' })];
        const item = new ServerTreeItem('10.0.0.1:22', hosts, false, failedAttempt);

        const tooltipValue = (item.tooltip as any).value;
        expect(tooltipValue).toContain('Last connection failed');
        expect(tooltipValue).toContain('Connection refused');
        expect(tooltipValue).toContain('\u26A0\uFE0F'); // warning emoji in title
      });

      it('should include time ago in failed tooltip', () => {
        // 2 hours ago
        const twoHoursAgo = {
          ...failedAttempt,
          timestamp: Date.now() - 2 * 60 * 60 * 1000,
        };
        const hosts = [createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1' })];
        const item = new ServerTreeItem('10.0.0.1:22', hosts, false, twoHoursAgo);

        const tooltipValue = (item.tooltip as any).value;
        expect(tooltipValue).toContain('2h ago');
      });

      it('should show "just now" for very recent failures', () => {
        const justNow = {
          ...failedAttempt,
          timestamp: Date.now() - 5_000, // 5 seconds ago
        };
        const hosts = [createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1' })];
        const item = new ServerTreeItem('10.0.0.1:22', hosts, false, justNow);

        const tooltipValue = (item.tooltip as any).value;
        expect(tooltipValue).toContain('just now');
      });

      it('should show days ago for old failures', () => {
        const threeDaysAgo = {
          ...failedAttempt,
          timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000,
        };
        const hosts = [createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1' })];
        const item = new ServerTreeItem('10.0.0.1:22', hosts, false, threeDaysAgo);

        const tooltipValue = (item.tooltip as any).value;
        expect(tooltipValue).toContain('3d ago');
      });

      it('should show "Unknown error" when errorMessage is not provided', () => {
        const noMessage = { timestamp: Date.now() - 60_000, success: false };
        const hosts = [createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1' })];
        const item = new ServerTreeItem('10.0.0.1:22', hosts, false, noMessage);

        const tooltipValue = (item.tooltip as any).value;
        expect(tooltipValue).toContain('Unknown error');
      });

      it('should preserve savedServer contextValue for saved hosts with failed attempt', () => {
        const host = createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1', source: 'saved' });
        const item = new ServerTreeItem('10.0.0.1:22', [host], false, failedAttempt);

        expect(item.contextValue).toBe('savedServer');
      });

      it('should preserve server contextValue for ssh-config hosts with failed attempt', () => {
        const host = createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1', source: 'ssh-config' });
        mockListCredentials.mockReturnValue([]);
        const item = new ServerTreeItem('10.0.0.1:22', [host], false, failedAttempt);

        expect(item.contextValue).toBe('server');
      });

      it('should show normal vm-outline icon when no lastFailedAttempt (ssh-config host)', () => {
        const host = createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1', source: 'ssh-config' });
        mockListCredentials.mockReturnValue([]);
        const item = new ServerTreeItem('10.0.0.1:22', [host], false);

        expect((item.iconPath as any).id).toBe('vm-outline');
        expect((item.iconPath as any).color).toBeUndefined();
      });

      it('should show normal vm icon when no lastFailedAttempt (saved host)', () => {
        const host = createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1', source: 'saved' });
        const item = new ServerTreeItem('10.0.0.1:22', [host], false);

        expect((item.iconPath as any).id).toBe('vm');
        expect((item.iconPath as any).color).toBeUndefined();
      });

      it('should show normal disconnected tooltip when no lastFailedAttempt', () => {
        const host = createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1', username: 'admin' });
        const item = new ServerTreeItem('10.0.0.1:22', [host], false);

        const tooltipValue = (item.tooltip as any).value;
        expect(tooltipValue).toContain('Disconnected');
        expect(tooltipValue).not.toContain('Last connection failed');
        expect(tooltipValue).not.toContain('\u26A0\uFE0F');
      });
    });

    describe('getServerItems integration tests', () => {
      it('should query getLastConnectionAttempt for disconnected servers', () => {
        const host = createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1' });
        mockGetAllHosts.mockReturnValue([host]);
        mockGetAllConnections.mockReturnValue([]);

        const { ConnectionManager } = require('../connection/ConnectionManager');
        const mockGetLastAttempt = ConnectionManager.getInstance().getLastConnectionAttempt;
        mockGetLastAttempt.mockReturnValue(failedAttempt);

        const items = provider.getChildren() as ServerTreeItem[];

        expect(mockGetLastAttempt).toHaveBeenCalledWith('h1');
        expect(items).toHaveLength(1);
        expect((items[0].iconPath as any).id).toBe('vm-outline');
        expect((items[0].iconPath as any).color.id).toBe('charts.orange');
      });

      it('should check all hosts in a server group for failed attempts', () => {
        const hosts = [
          createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, username: 'user1', name: 'S1' }),
          createMockHostConfig({ id: 'h2', host: '10.0.0.1', port: 22, username: 'user2', name: 'S1' }),
        ];
        mockGetAllHosts.mockReturnValue(hosts);
        mockGetAllConnections.mockReturnValue([]);

        const { ConnectionManager } = require('../connection/ConnectionManager');
        const mockGetLastAttempt = ConnectionManager.getInstance().getLastConnectionAttempt;
        mockGetLastAttempt.mockImplementation((id: string) => {
          if (id === 'h2') {
            return failedAttempt;
          }
          return undefined;
        });

        const items = provider.getChildren() as ServerTreeItem[];

        expect(mockGetLastAttempt).toHaveBeenCalledWith('h1');
        expect(mockGetLastAttempt).toHaveBeenCalledWith('h2');
        expect(items).toHaveLength(1);
        expect((items[0].iconPath as any).color.id).toBe('charts.orange');
      });

      it('should use the most recent failed attempt when multiple hosts have failures', () => {
        const hosts = [
          createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, username: 'user1', name: 'S1' }),
          createMockHostConfig({ id: 'h2', host: '10.0.0.1', port: 22, username: 'user2', name: 'S1' }),
        ];
        mockGetAllHosts.mockReturnValue(hosts);
        mockGetAllConnections.mockReturnValue([]);

        const olderAttempt = {
          timestamp: Date.now() - 300_000, // 5 minutes ago
          success: false,
          errorMessage: 'Older error',
        };
        const newerAttempt = {
          timestamp: Date.now() - 60_000, // 1 minute ago
          success: false,
          errorMessage: 'Newer error',
        };

        const { ConnectionManager } = require('../connection/ConnectionManager');
        const mockGetLastAttempt = ConnectionManager.getInstance().getLastConnectionAttempt;
        mockGetLastAttempt.mockImplementation((id: string) => {
          if (id === 'h1') return olderAttempt;
          if (id === 'h2') return newerAttempt;
          return undefined;
        });

        const items = provider.getChildren() as ServerTreeItem[];

        // Should use the newer error message
        const tooltipValue = (items[0].tooltip as any).value;
        expect(tooltipValue).toContain('Newer error');
        expect(tooltipValue).not.toContain('Older error');
      });

      it('should not show failed indicator for connected servers even with past failure', () => {
        const host = createMockHostConfig({ id: '10.0.0.1:22:user', host: '10.0.0.1', port: 22, username: 'user', name: 'S1' });
        const mockConn = { id: '10.0.0.1:22:user', state: 'connected' };
        mockGetAllHosts.mockReturnValue([host]);
        mockGetAllConnections.mockReturnValue([mockConn]);

        const { ConnectionManager } = require('../connection/ConnectionManager');
        const mockGetLastAttempt = ConnectionManager.getInstance().getLastConnectionAttempt;
        // Even if there's a past failed attempt, connected servers should NOT query it
        mockGetLastAttempt.mockReturnValue(failedAttempt);

        const items = provider.getChildren() as ServerTreeItem[];

        // Should NOT call getLastConnectionAttempt for connected servers
        expect(mockGetLastAttempt).not.toHaveBeenCalled();
        // Should show connected icon, not orange
        expect((items[0].iconPath as any).id).toBe('vm-running');
        expect((items[0].iconPath as any).color.id).toBe('charts.green');
      });

      it('should not show failed indicator when attempt was successful', () => {
        const host = createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1', source: 'ssh-config' });
        mockGetAllHosts.mockReturnValue([host]);
        mockGetAllConnections.mockReturnValue([]);
        mockListCredentials.mockReturnValue([]);

        const successAttempt = {
          timestamp: Date.now() - 60_000,
          success: true,
        };

        const { ConnectionManager } = require('../connection/ConnectionManager');
        const mockGetLastAttempt = ConnectionManager.getInstance().getLastConnectionAttempt;
        mockGetLastAttempt.mockReturnValue(successAttempt);

        const items = provider.getChildren() as ServerTreeItem[];

        // Successful attempt should not trigger orange icon
        expect((items[0].iconPath as any).id).toBe('vm-outline');
        expect((items[0].iconPath as any).color).toBeUndefined();
      });

      it('should show normal state when getLastConnectionAttempt returns undefined', () => {
        const host = createMockHostConfig({ id: 'h1', host: '10.0.0.1', port: 22, name: 'S1', source: 'ssh-config' });
        mockGetAllHosts.mockReturnValue([host]);
        mockGetAllConnections.mockReturnValue([]);
        mockListCredentials.mockReturnValue([]);

        const { ConnectionManager } = require('../connection/ConnectionManager');
        const mockGetLastAttempt = ConnectionManager.getInstance().getLastConnectionAttempt;
        mockGetLastAttempt.mockReturnValue(undefined);

        const items = provider.getChildren() as ServerTreeItem[];

        expect((items[0].iconPath as any).id).toBe('vm-outline');
        expect((items[0].iconPath as any).color).toBeUndefined();
        const tooltipValue = (items[0].tooltip as any).value;
        expect(tooltipValue).toContain('Disconnected');
      });
    });
  });
});
