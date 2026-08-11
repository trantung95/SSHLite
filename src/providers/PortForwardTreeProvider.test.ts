/**
 * PortForwardTreeProvider tests
 *
 * Tests the tree provider for port forwards including:
 * - Adding/removing forwards from storage
 * - Filtering by connection
 * - Tree item generation
 * - Cleanup of disconnected forwards
 * - Saved-but-inactive forward display
 */

import { IPortForward, ConnectionState } from '../types';
import { createMockConnection, createMockHostConfig, createMockPortForward } from '../__mocks__/testHelpers';

// Mock PortForwardService for saved rules
var mockGetSavedRules = jest.fn().mockReturnValue([]);
var mockGetHostIdsWithSavedRules = jest.fn().mockReturnValue([]);
var mockGetRestoreFailure = jest.fn().mockReturnValue(undefined);
jest.mock('../services/PortForwardService', () => ({
  PortForwardService: {
    getInstance: jest.fn().mockImplementation(() => ({
      get getSavedRules() { return mockGetSavedRules; },
      get getHostIdsWithSavedRules() { return mockGetHostIdsWithSavedRules; },
      get getRestoreFailure() { return mockGetRestoreFailure; },
    })),
  },
}));

// Mock HostService for host lookup
var mockGetAllHosts = jest.fn().mockReturnValue([]);
jest.mock('../services/HostService', () => ({
  HostService: {
    getInstance: jest.fn().mockImplementation(() => ({
      get getAllHosts() { return mockGetAllHosts; },
    })),
  },
}));

// We need to mock ConnectionManager before importing PortForwardTreeProvider
jest.mock('../connection/ConnectionManager', () => {
  const { EventEmitter } = require('../__mocks__/vscode');
  const mockOnDidChangeConnections = new EventEmitter();
  return {
    ConnectionManager: {
      getInstance: jest.fn().mockReturnValue({
        getAllConnections: jest.fn().mockReturnValue([]),
        getConnection: jest.fn().mockReturnValue(undefined),
        onDidChangeConnections: mockOnDidChangeConnections.event,
        _mockEmitter: mockOnDidChangeConnections,
      }),
    },
  };
});

import {
  PortForwardServerGroupTreeItem,
  PortForwardTreeProvider,
  PortForwardTreeItem,
  SavedForwardTreeItem,
} from './PortForwardTreeProvider';
import { ConnectionManager } from '../connection/ConnectionManager';

function createProvider(): PortForwardTreeProvider {
  return new PortForwardTreeProvider();
}

describe('PortForwardTreeProvider', () => {
  let provider: PortForwardTreeProvider;

  beforeEach(() => {
    provider = createProvider();
    jest.clearAllMocks();
    mockGetSavedRules.mockReturnValue([]);
    mockGetHostIdsWithSavedRules.mockReturnValue([]);
    mockGetRestoreFailure.mockReturnValue(undefined);
    mockGetAllHosts.mockReturnValue([]);
  });

  afterEach(() => {
    provider.dispose();
  });

  describe('addForward / removeForward', () => {
    it('should add a forward to internal storage', () => {
      provider.addForward('conn1', 3000, 'localhost', 3000);

      const forwards = provider.getForwardsForConnection('conn1');
      expect(forwards).toHaveLength(1);
      expect(forwards[0].localPort).toBe(3000);
      expect(forwards[0].remotePort).toBe(3000);
    });

    it('should add multiple forwards', () => {
      provider.addForward('conn1', 3000, 'localhost', 3000);
      provider.addForward('conn1', 8080, 'localhost', 80);
      provider.addForward('conn2', 5432, 'localhost', 5432);

      expect(provider.getForwardsForConnection('conn1')).toHaveLength(2);
      expect(provider.getForwardsForConnection('conn2')).toHaveLength(1);
    });

    it('should remove a forward by localPort and connectionId', () => {
      provider.addForward('conn1', 3000, 'localhost', 3000);
      provider.addForward('conn1', 8080, 'localhost', 80);

      provider.removeForward(3000, 'conn1');

      const forwards = provider.getForwardsForConnection('conn1');
      expect(forwards).toHaveLength(1);
      expect(forwards[0].localPort).toBe(8080);
    });

    it('should not affect other connections when removing', () => {
      provider.addForward('conn1', 3000, 'localhost', 3000);
      provider.addForward('conn2', 3000, 'localhost', 3000);

      provider.removeForward(3000, 'conn1');

      expect(provider.getForwardsForConnection('conn1')).toHaveLength(0);
      expect(provider.getForwardsForConnection('conn2')).toHaveLength(1);
    });
  });

  describe('getForwardsForConnection', () => {
    it('should return empty array for unknown connection', () => {
      const forwards = provider.getForwardsForConnection('nonexistent');
      expect(forwards).toEqual([]);
    });

    it('should filter by connectionId', () => {
      provider.addForward('conn1', 3000, 'localhost', 3000);
      provider.addForward('conn2', 8080, 'localhost', 80);
      provider.addForward('conn1', 5432, 'localhost', 5432);

      const conn1Forwards = provider.getForwardsForConnection('conn1');
      expect(conn1Forwards).toHaveLength(2);
      expect(conn1Forwards.every(f => f.connectionId === 'conn1')).toBe(true);
    });
  });

  describe('getChildren', () => {
    it('should return empty when no forwards and no saved rules', async () => {
      const children = await provider.getChildren();
      expect(children).toEqual([]);
    });

    it('groups active forwards under their host', async () => {
      const mockConn = createMockConnection();
      const connectionManager = ConnectionManager.getInstance();
      (connectionManager.getAllConnections as jest.Mock).mockReturnValue([mockConn]);

      provider.addForward(mockConn.id, 3000, 'localhost', 3000);

      const groups = await provider.getChildren();
      expect(groups).toHaveLength(1);
      expect(groups[0]).toBeInstanceOf(PortForwardServerGroupTreeItem);

      const rules = await provider.getChildren(groups[0]);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toBeInstanceOf(PortForwardTreeItem);
      expect(provider.getParent(rules[0])).toBe(groups[0]);
    });

    it('should skip forwards for disconnected connections', async () => {
      const connectionManager = ConnectionManager.getInstance();
      // getChildren builds connectionMap from getAllConnections
      (connectionManager.getAllConnections as jest.Mock).mockReturnValue([]);

      provider.addForward('disconnected-conn', 3000, 'localhost', 3000);

      const children = await provider.getChildren();
      // No matching connection in map, so forward is skipped
      expect(children).toHaveLength(0);
    });

    it('should show saved-but-inactive rules as SavedForwardTreeItem', async () => {
      const connectionManager = ConnectionManager.getInstance();
      (connectionManager.getAllConnections as jest.Mock).mockReturnValue([]);

      const host = createMockHostConfig();
      mockGetAllHosts.mockReturnValue([host]);
      mockGetHostIdsWithSavedRules.mockReturnValue([host.id]);
      mockGetSavedRules.mockReturnValue([
        { id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 },
      ]);

      const groups = await provider.getChildren();
      expect(groups).toHaveLength(1);
      expect(groups[0]).toBeInstanceOf(PortForwardServerGroupTreeItem);
      const rules = await provider.getChildren(groups[0]);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toBeInstanceOf(SavedForwardTreeItem);
      expect(rules[0].description).toBe('Host disconnected');
    });

    it('should not duplicate active forward as saved item', async () => {
      // Use host.id that matches connectionId (as in production)
      const host = createMockHostConfig({ id: '192.168.1.100:22:testuser' });
      const mockConn = createMockConnection({ host });
      const connectionManager = ConnectionManager.getInstance();
      (connectionManager.getAllConnections as jest.Mock).mockReturnValue([mockConn]);

      // Active forward
      provider.addForward(mockConn.id, 3000, 'localhost', 3000);

      // Same rule saved for same host
      mockGetAllHosts.mockReturnValue([host]);
      mockGetHostIdsWithSavedRules.mockReturnValue([host.id]);
      mockGetSavedRules.mockReturnValue([
        { id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 },
      ]);

      const groups = await provider.getChildren();
      const rules = await provider.getChildren(groups[0]);
      expect(groups).toHaveLength(1);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toBeInstanceOf(PortForwardTreeItem);
    });

    it('should show both active and saved items for different ports', async () => {
      // Use host.id that matches connectionId (as in production)
      const host = createMockHostConfig({ id: '192.168.1.100:22:testuser' });
      const mockConn = createMockConnection({ host });
      const connectionManager = ConnectionManager.getInstance();
      (connectionManager.getAllConnections as jest.Mock).mockReturnValue([mockConn]);

      // Active forward on port 3000
      provider.addForward(mockConn.id, 3000, 'localhost', 3000);

      // Saved rules: port 3000 (active, deduped) and port 8080 (inactive)
      mockGetAllHosts.mockReturnValue([host]);
      mockGetHostIdsWithSavedRules.mockReturnValue([host.id]);
      mockGetSavedRules.mockReturnValue([
        { id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 },
        { id: 'pf_2', localPort: 8080, remoteHost: 'localhost', remotePort: 80 },
      ]);

      const groups = await provider.getChildren();
      const rules = await provider.getChildren(groups[0]);
      expect(groups).toHaveLength(1);
      expect(rules).toHaveLength(2);
      expect(rules[0]).toBeInstanceOf(PortForwardTreeItem);
      expect(rules[1]).toBeInstanceOf(SavedForwardTreeItem);
    });

    it('should show saved rules for hosts not in hostService', async () => {
      const connectionManager = ConnectionManager.getInstance();
      (connectionManager.getAllConnections as jest.Mock).mockReturnValue([]);

      mockGetAllHosts.mockReturnValue([]); // No known hosts
      mockGetHostIdsWithSavedRules.mockReturnValue(['orphan-host:22:user']);
      mockGetSavedRules.mockImplementation((hostId: string) => {
        if (hostId === 'orphan-host:22:user') {
          return [{ id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 }];
        }
        return [];
      });

      const groups = await provider.getChildren();
      expect(groups).toHaveLength(1);
      expect(groups[0]).toBeInstanceOf(PortForwardServerGroupTreeItem);
      expect(groups[0].label).toBe('orphan-host:22:user');
      const rules = await provider.getChildren(groups[0]);
      expect(rules).toHaveLength(1);
      expect(rules[0]).toBeInstanceOf(SavedForwardTreeItem);
    });

    it('keeps restore failures visible under the connected host', async () => {
      const host = createMockHostConfig({ id: 'production:22:deploy', name: 'Production' });
      const mockConn = createMockConnection({ host });
      const connectionManager = ConnectionManager.getInstance();
      (connectionManager.getAllConnections as jest.Mock).mockReturnValue([mockConn]);
      mockGetAllHosts.mockReturnValue([host]);
      mockGetHostIdsWithSavedRules.mockReturnValue([host.id]);
      mockGetSavedRules.mockReturnValue([
        { id: 'pf_failed', localPort: 8080, remoteHost: 'localhost', remotePort: 3000 },
      ]);
      mockGetRestoreFailure.mockReturnValue('Address already in use');

      const groups = await provider.getChildren();
      const rules = await provider.getChildren(groups[0]);

      expect(rules).toHaveLength(1);
      expect(rules[0].description).toBe('Restore failed · Address already in use');
      expect(provider.getParent(rules[0])).toBe(groups[0]);
    });

    it('reuses one host snapshot across root and child reads', async () => {
      const mockConn = createMockConnection();
      const connectionManager = ConnectionManager.getInstance();
      (connectionManager.getAllConnections as jest.Mock).mockReturnValue([mockConn]);
      provider.addForward(mockConn.id, 3000, 'localhost', 3000);

      const groups = await provider.getChildren();
      await provider.getChildren(groups[0]);

      expect(mockGetAllHosts).toHaveBeenCalledTimes(1);
    });
  });

  describe('PortForwardServerGroupTreeItem', () => {
    it('uses a stable server id and count description', () => {
      const item = new PortForwardServerGroupTreeItem('host1:22:user', 'My Server', '1 active · 2 saved');
      expect(item.id).toBe('port-forward-server:host1:22:user');
      expect(item.contextValue).toBe('portForwardServerGroup');
      expect(item.description).toBe('1 active · 2 saved');
    });
  });

  describe('SavedForwardTreeItem', () => {
    it('should have correct contextValue', () => {
      const item = new SavedForwardTreeItem(
        { id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 },
        'host1:22:user',
        'My Server',
        'host1'
      );
      expect(item.contextValue).toBe('savedForward');
    });

    it('should have stable id', () => {
      const item = new SavedForwardTreeItem(
        { id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 },
        'host1:22:user',
        'My Server',
        'host1'
      );
      expect(item.id).toBe('saved:host1:22:user:pf_1');
    });

    it('shows saved stopped description while the host is connected', () => {
      const item = new SavedForwardTreeItem(
        { id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 },
        'host1:22:user',
        'My Server',
        'host1',
        true
      );
      expect(item.description).toBe('Saved · stopped');
    });

    it('substitutes the server name for a saved localhost target', () => {
      const item = new SavedForwardTreeItem(
        { id: 'pf_1', localPort: 8080, remoteHost: 'localhost', remotePort: 3000 },
        'host1:22:user',
        'Production',
        'host1',
        true
      );

      expect(item.label).toBe('localhost:8080 → Production:3000');
    });
  });

  describe('PortForwardTreeItem', () => {
    it('should have correct contextValue', () => {
      const mockConn = createMockConnection();
      const forward = createMockPortForward({ connectionId: mockConn.id });
      const item = new PortForwardTreeItem(forward, mockConn as any);
      expect(item.contextValue).toBe('forward');
    });

    it('reads the route from the local endpoint to the remote endpoint', () => {
      const mockConn = createMockConnection();
      const forward = createMockPortForward({
        connectionId: mockConn.id,
        localPort: 8080,
        remoteHost: 'production-api',
        remotePort: 3000,
      });

      const item = new PortForwardTreeItem(forward, mockConn as any);

      expect(item.label).toBe('localhost:8080 → production-api:3000');
    });

    it('substitutes the server name for an active localhost target', () => {
      const mockConn = createMockConnection();
      const forward = createMockPortForward({
        connectionId: mockConn.id,
        localPort: 8080,
        remoteHost: 'localhost',
        remotePort: 3000,
      });

      const item = new PortForwardTreeItem(forward, mockConn as any);

      expect(item.label).toBe(`localhost:8080 → ${mockConn.host.name}:3000`);
    });
  });

  describe('cleanupDisconnectedForwards', () => {
    it('should remove forwards for connections that are no longer active', () => {
      const connectionManager = ConnectionManager.getInstance();
      (connectionManager.getAllConnections as jest.Mock).mockReturnValue([]);

      provider.addForward('disconnected-conn', 3000, 'localhost', 3000);

      // Trigger cleanup by firing the connection change event
      const mockEmitter = (connectionManager as any)._mockEmitter;
      mockEmitter.fire();

      const forwards = provider.getForwardsForConnection('disconnected-conn');
      expect(forwards).toHaveLength(0);
    });

    it('should keep forwards for still-connected connections', () => {
      const mockConn = createMockConnection({ id: 'active-conn' });
      const connectionManager = ConnectionManager.getInstance();
      (connectionManager.getAllConnections as jest.Mock).mockReturnValue([mockConn]);

      provider.addForward('active-conn', 3000, 'localhost', 3000);
      provider.addForward('disconnected-conn', 8080, 'localhost', 80);

      // Trigger cleanup
      const mockEmitter = (connectionManager as any)._mockEmitter;
      mockEmitter.fire();

      expect(provider.getForwardsForConnection('active-conn')).toHaveLength(1);
      expect(provider.getForwardsForConnection('disconnected-conn')).toHaveLength(0);
    });
  });

  describe('refresh', () => {
    it('should fire onDidChangeTreeData', () => {
      const listener = jest.fn();
      provider.onDidChangeTreeData(listener);

      provider.refresh();

      expect(listener).toHaveBeenCalled();
    });
  });
});
