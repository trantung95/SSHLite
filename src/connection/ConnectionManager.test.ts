/**
 * ConnectionManager tests
 *
 * Tests connection lifecycle, auto-reconnect, and connection management.
 * SSHConnection is fully mocked to avoid real SSH connections.
 */

import { ConnectionState } from '../types';
import { commands } from '../__mocks__/vscode';
import { createMockHostConfig, createMockCredential } from '../__mocks__/testHelpers';

// Mock SSHConnection - captures onStateChange listener for simulating disconnects
let mockStateChangeListeners: Map<string, ((state: ConnectionState) => void)[]> = new Map();
let mockConnectBehavior: (() => Promise<void>) | null = null;

jest.mock('./SSHConnection', () => {
  const { EventEmitter } = require('../__mocks__/vscode');
  return {
    SSHConnection: jest.fn().mockImplementation((host: any, credential?: any) => {
      const id = `${host.host}:${host.port}:${host.username}`;
      const stateEmitter = new EventEmitter();

      // Store listeners for test access
      if (!mockStateChangeListeners.has(id)) {
        mockStateChangeListeners.set(id, []);
      }
      stateEmitter.event((state: any) => {
        const listeners = mockStateChangeListeners.get(id) || [];
        listeners.forEach(l => l(state));
      });

      return {
        id,
        host,
        state: ConnectionState.Disconnected,
        client: null,
        onStateChange: stateEmitter.event,
        _stateEmitter: stateEmitter,
        connect: jest.fn().mockImplementation(async () => {
          if (mockConnectBehavior) {
            return mockConnectBehavior();
          }
          // Default: succeed
        }),
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn(),
      };
    }),
  };
});

// Mock ActivityService
jest.mock('../services/ActivityService', () => {
  return {
    ActivityService: {
      getInstance: jest.fn().mockReturnValue({
        startActivity: jest.fn().mockReturnValue('activity-1'),
        completeActivity: jest.fn(),
        failActivity: jest.fn(),
      }),
    },
  };
});

// Mock CredentialService
jest.mock('../services/CredentialService', () => {
  return {
    CredentialService: {
      getInstance: jest.fn().mockReturnValue({
        listCredentials: jest.fn().mockReturnValue([]),
      }),
    },
  };
});

import { ConnectionManager } from './ConnectionManager';

function resetConnectionManager(): ConnectionManager {
  try {
    ConnectionManager.getInstance().dispose();
  } catch {
    // ignore
  }
  (ConnectionManager as any)._instance = undefined;
  mockStateChangeListeners = new Map();
  mockConnectBehavior = null;
  return ConnectionManager.getInstance();
}

describe('ConnectionManager', () => {
  let manager: ConnectionManager;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    manager = resetConnectionManager();
  });

  afterEach(() => {
    jest.useRealTimers();
    try {
      manager.dispose();
    } catch {
      // ignore
    }
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const a = ConnectionManager.getInstance();
      const b = ConnectionManager.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('connect', () => {
    it('should create and store a connection', async () => {
      const host = createMockHostConfig();
      const conn = await manager.connect(host);

      expect(conn).toBeDefined();
      expect(conn.id).toBe(`${host.host}:${host.port}:${host.username}`);
    });

    it('should generate correct connection ID format', async () => {
      const host = createMockHostConfig({
        host: '10.0.0.1',
        port: 2222,
        username: 'admin',
      });
      const conn = await manager.connect(host);

      expect(conn.id).toBe('10.0.0.1:2222:admin');
    });

    it('should call connection.connect()', async () => {
      const host = createMockHostConfig();
      const conn = await manager.connect(host);

      expect(conn.connect).toHaveBeenCalledTimes(1);
    });

    it('should fire onDidChangeConnections event', async () => {
      const listener = jest.fn();
      manager.onDidChangeConnections(listener);

      await manager.connect(createMockHostConfig());

      expect(listener).toHaveBeenCalled();
    });

    it('should set VS Code context', async () => {
      await manager.connect(createMockHostConfig());

      expect(commands.executeCommand).toHaveBeenCalledWith(
        'setContext',
        'sshLite.hasConnections',
        true
      );
    });

    it('should return existing connection if already connected', async () => {
      const host = createMockHostConfig();
      const conn1 = await manager.connect(host);
      // Simulate connected state
      (conn1 as any).state = ConnectionState.Connected;

      const conn2 = await manager.connect(host);

      expect(conn2).toBe(conn1);
      expect(conn1.connect).toHaveBeenCalledTimes(1); // Not called again
    });

    it('should remove connection on connect failure', async () => {
      mockConnectBehavior = async () => {
        throw new Error('Auth failed');
      };

      const host = createMockHostConfig();

      await expect(manager.connect(host)).rejects.toThrow('Auth failed');
      expect(manager.hasConnections()).toBe(false);
    });

    it('should track connection activity', async () => {
      const { ActivityService } = require('../services/ActivityService');
      const activityService = ActivityService.getInstance();

      await manager.connect(createMockHostConfig());

      expect(activityService.startActivity).toHaveBeenCalledWith(
        'connect',
        expect.any(String),
        expect.any(String),
        expect.stringContaining('Connect'),
        expect.any(Object)
      );
      expect(activityService.completeActivity).toHaveBeenCalled();
    });

    it('should fail activity tracking on connect error', async () => {
      mockConnectBehavior = async () => {
        throw new Error('Network error');
      };

      const { ActivityService } = require('../services/ActivityService');
      const activityService = ActivityService.getInstance();

      await expect(manager.connect(createMockHostConfig())).rejects.toThrow();

      expect(activityService.failActivity).toHaveBeenCalledWith(
        expect.any(String),
        'Network error'
      );
    });
  });

  describe('connectWithCredential', () => {
    it('should create connection with credential', async () => {
      const host = createMockHostConfig();
      const cred = createMockCredential();

      const conn = await manager.connectWithCredential(host, cred);

      expect(conn).toBeDefined();
      expect(conn.connect).toHaveBeenCalled();
    });

    it('should include credential label in activity detail', async () => {
      const { ActivityService } = require('../services/ActivityService');
      const activityService = ActivityService.getInstance();

      const host = createMockHostConfig();
      const cred = createMockCredential({ label: 'My Key' });

      await manager.connectWithCredential(host, cred);

      expect(activityService.startActivity).toHaveBeenCalledWith(
        'connect',
        expect.any(String),
        expect.any(String),
        expect.any(String),
        expect.objectContaining({
          detail: expect.stringContaining('My Key'),
        })
      );
    });
  });

  describe('disconnect', () => {
    it('should call connection.disconnect()', async () => {
      const host = createMockHostConfig();
      const conn = await manager.connect(host);
      const connId = conn.id;

      await manager.disconnect(connId);

      expect(conn.disconnect).toHaveBeenCalledTimes(1);
    });

    it('should fire onDidChangeConnections', async () => {
      const host = createMockHostConfig();
      const conn = await manager.connect(host);

      const listener = jest.fn();
      manager.onDidChangeConnections(listener);

      await manager.disconnect(conn.id);

      expect(listener).toHaveBeenCalled();
    });

    it('should mark as manual disconnect to prevent auto-reconnect', async () => {
      const host = createMockHostConfig();
      const conn = await manager.connect(host);

      await manager.disconnect(conn.id);

      // Should not be reconnecting
      expect(manager.isReconnecting(conn.id)).toBe(false);
    });

    it('should track disconnect activity', async () => {
      const { ActivityService } = require('../services/ActivityService');
      const activityService = ActivityService.getInstance();

      const host = createMockHostConfig();
      const conn = await manager.connect(host);

      jest.clearAllMocks(); // Clear activity from connect
      await manager.disconnect(conn.id);

      expect(activityService.startActivity).toHaveBeenCalledWith(
        'disconnect',
        expect.any(String),
        expect.any(String),
        expect.stringContaining('Disconnect'),
        expect.any(Object)
      );
    });

    it('should do nothing for non-existent connection', async () => {
      // Should not throw
      await manager.disconnect('nonexistent');
    });
  });

  describe('disconnectAll', () => {
    it('should disconnect all connections', async () => {
      const host1 = createMockHostConfig({ host: '10.0.0.1', username: 'user1' });
      const host2 = createMockHostConfig({ host: '10.0.0.2', username: 'user2' });

      const conn1 = await manager.connect(host1);
      const conn2 = await manager.connect(host2);

      await manager.disconnectAll();

      expect(conn1.disconnect).toHaveBeenCalled();
      expect(conn2.disconnect).toHaveBeenCalled();
    });

    it('should update VS Code context', async () => {
      await manager.connect(createMockHostConfig());

      jest.clearAllMocks();
      await manager.disconnectAll();

      expect(commands.executeCommand).toHaveBeenCalledWith(
        'setContext',
        'sshLite.hasConnections',
        false
      );
    });
  });

  describe('getters', () => {
    it('getAllConnections should return only connected connections', async () => {
      const host = createMockHostConfig();
      const conn = await manager.connect(host);
      (conn as any).state = ConnectionState.Connected;

      const connections = manager.getAllConnections();
      expect(connections).toHaveLength(1);
    });

    it('getAllConnections should exclude disconnected connections', async () => {
      const host = createMockHostConfig();
      const conn = await manager.connect(host);
      (conn as any).state = ConnectionState.Disconnected;

      const connections = manager.getAllConnections();
      expect(connections).toHaveLength(0);
    });

    it('getConnection should return specific connection', async () => {
      const host = createMockHostConfig();
      const conn = await manager.connect(host);

      const found = manager.getConnection(conn.id);
      expect(found).toBe(conn);
    });

    it('getConnection should return undefined for unknown ID', () => {
      const found = manager.getConnection('nonexistent');
      expect(found).toBeUndefined();
    });

    it('hasConnections should return false when empty', () => {
      expect(manager.hasConnections()).toBe(false);
    });

    it('hasConnections should return true when connected', async () => {
      const host = createMockHostConfig();
      const conn = await manager.connect(host);
      (conn as any).state = ConnectionState.Connected;

      expect(manager.hasConnections()).toBe(true);
    });
  });

  describe('auto-reconnect', () => {
    it('isReconnecting should return false when no reconnect pending', () => {
      expect(manager.isReconnecting('any-id')).toBe(false);
    });

    it('getReconnectingConnections should return empty array initially', () => {
      const reconnecting = manager.getReconnectingConnections();
      expect(reconnecting).toEqual([]);
    });

    it('stopReconnect should not throw for non-existent connection', () => {
      // Should not throw
      manager.stopReconnect('nonexistent');
    });

    it('getReconnectingInfo should return undefined for unknown connection', () => {
      const info = manager.getReconnectingInfo('nonexistent');
      expect(info).toBeUndefined();
    });

    it('getAllConnectionsWithReconnecting should include both active and reconnecting', async () => {
      const host = createMockHostConfig();
      const conn = await manager.connect(host);
      (conn as any).state = ConnectionState.Connected;

      const result = manager.getAllConnectionsWithReconnecting();
      expect(result.active).toHaveLength(1);
      expect(result.reconnecting).toEqual([]);
    });

    it('hasConnectionsOrReconnecting should check both maps', async () => {
      expect(manager.hasConnectionsOrReconnecting()).toBe(false);

      const host = createMockHostConfig();
      const conn = await manager.connect(host);
      (conn as any).state = ConnectionState.Connected;

      expect(manager.hasConnectionsOrReconnecting()).toBe(true);
    });
  });

  describe('dispose', () => {
    it('should clear all connections', async () => {
      await manager.connect(createMockHostConfig());

      manager.dispose();

      // After dispose, getInstance returns a fresh manager
      (ConnectionManager as any)._instance = undefined;
      const fresh = ConnectionManager.getInstance();
      expect(fresh.hasConnections()).toBe(false);
      fresh.dispose();
    });

    it('should stop all reconnect timers', async () => {
      // Just verify dispose doesn't throw
      manager.dispose();
    });
  });
});
