/**
 * PortForwardTreeProvider tests
 *
 * Tests the tree provider for port forwards including:
 * - Adding/removing forwards from storage
 * - Filtering by connection
 * - Tree item generation
 * - Cleanup of disconnected forwards
 */

import { IPortForward, ConnectionState } from '../types';
import { createMockConnection, createMockHostConfig, createMockPortForward } from '../__mocks__/testHelpers';

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

import { PortForwardTreeProvider } from './PortForwardTreeProvider';
import { ConnectionManager } from '../connection/ConnectionManager';

function createProvider(): PortForwardTreeProvider {
  return new PortForwardTreeProvider();
}

describe('PortForwardTreeProvider', () => {
  let provider: PortForwardTreeProvider;

  beforeEach(() => {
    provider = createProvider();
    jest.clearAllMocks();
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
    it('should return empty when no forwards', async () => {
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
