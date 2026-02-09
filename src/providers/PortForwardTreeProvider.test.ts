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
const mockGetSavedRules = jest.fn().mockReturnValue([]);
const mockGetHostIdsWithSavedRules = jest.fn().mockReturnValue([]);
jest.mock('../services/PortForwardService', () => ({
  PortForwardService: {
    getInstance: jest.fn().mockReturnValue({
      getSavedRules: mockGetSavedRules,
      getHostIdsWithSavedRules: mockGetHostIdsWithSavedRules,
    }),
  },
}));

// Mock HostService for host lookup
const mockGetAllHosts = jest.fn().mockReturnValue([]);
jest.mock('../services/HostService', () => ({
  HostService: {
    getInstance: jest.fn().mockReturnValue({
      getAllHosts: mockGetAllHosts,
    }),
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

import { PortForwardTreeProvider, PortForwardTreeItem, SavedForwardTreeItem } from './PortForwardTreeProvider';
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

    it('should return tree items for active forwards with connection', async () => {
      const mockConn = createMockConnection();
      const connectionManager = ConnectionManager.getInstance();
      // getChildren uses getAllConnections(), not getConnection()
      (connectionManager.getAllConnections as jest.Mock).mockReturnValue([mockConn]);

      provider.addForward(mockConn.id, 3000, 'localhost', 3000);

      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(PortForwardTreeItem);
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
      mockGetSavedRules.mockReturnValue([
        { id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 },
      ]);

      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(SavedForwardTreeItem);
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
      mockGetSavedRules.mockReturnValue([
        { id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 },
      ]);

      const children = await provider.getChildren();
      // Should only show the active forward, not the saved duplicate
      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(PortForwardTreeItem);
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
      mockGetSavedRules.mockReturnValue([
        { id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 },
        { id: 'pf_2', localPort: 8080, remoteHost: 'localhost', remotePort: 80 },
      ]);

      const children = await provider.getChildren();
      expect(children).toHaveLength(2);
      expect(children.filter(c => c instanceof PortForwardTreeItem)).toHaveLength(1);
      expect(children.filter(c => c instanceof SavedForwardTreeItem)).toHaveLength(1);
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

      const children = await provider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(SavedForwardTreeItem);
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

    it('should show saved description', () => {
      const item = new SavedForwardTreeItem(
        { id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 },
        'host1:22:user',
        'My Server',
        'host1'
      );
      expect(item.description).toBe('My Server (saved)');
    });
  });

  describe('PortForwardTreeItem', () => {
    it('should have correct contextValue', () => {
      const mockConn = createMockConnection();
      const forward = createMockPortForward({ connectionId: mockConn.id });
      const item = new PortForwardTreeItem(forward, mockConn as any);
      expect(item.contextValue).toBe('forward');
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
