/**
 * Integration tests - Port Forward Persistence Flow
 *
 * Tests the full lifecycle of persistent port forwards:
 * - Save rules on forward creation
 * - Restore rules on connection established
 * - Survive disconnect/reconnect cycles
 * - Tree view merges active + saved items
 * - Delete saved rules permanently
 *
 * All SSH connections are mocked.
 */

import { ConnectionState } from '../types';
import { createMockConnection, createMockHostConfig } from '../__mocks__/testHelpers';
import { window } from '../__mocks__/vscode';

// Mock ConnectionManager
const mockGetConnection = jest.fn();
const mockGetAllConnections = jest.fn().mockReturnValue([]);
jest.mock('../connection/ConnectionManager', () => {
  const { EventEmitter } = require('../__mocks__/vscode');
  return {
    ConnectionManager: {
      getInstance: jest.fn().mockReturnValue({
        getAllConnections: mockGetAllConnections,
        getConnection: mockGetConnection,
        onDidChangeConnections: new EventEmitter().event,
      }),
    },
  };
});

// Mock HostService
const mockGetAllHosts = jest.fn().mockReturnValue([]);
jest.mock('../services/HostService', () => ({
  HostService: {
    getInstance: jest.fn().mockReturnValue({
      getAllHosts: mockGetAllHosts,
    }),
  },
}));

import { PortForwardService } from '../services/PortForwardService';
import { PortForwardTreeProvider, PortForwardTreeItem, SavedForwardTreeItem } from '../providers/PortForwardTreeProvider';

// Mock globalState
const mockGlobalStateStore: Record<string, any> = {};
const mockGlobalState = {
  get: jest.fn((key: string) => mockGlobalStateStore[key]),
  update: jest.fn(async (key: string, value: any) => {
    mockGlobalStateStore[key] = value;
  }),
};
const mockContext = { globalState: mockGlobalState } as any;

describe('Integration: Port Forward Persistence Flow', () => {
  let service: PortForwardService;
  let treeProvider: PortForwardTreeProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    delete mockGlobalStateStore['sshLite.savedPortForwards'];
    mockGetAllConnections.mockReturnValue([]);
    mockGetConnection.mockReturnValue(undefined);
    mockGetAllHosts.mockReturnValue([]);

    // Fresh service + tree provider
    (PortForwardService as any)._instance = undefined;
    service = PortForwardService.getInstance();
    service.initialize(mockContext);
    treeProvider = new PortForwardTreeProvider();
    service.setTreeProvider(treeProvider);
  });

  afterEach(() => {
    treeProvider.dispose();
  });

  describe('full create → disconnect → reconnect → restore cycle', () => {
    it('should persist rules across simulated session restart', async () => {
      // Use production-style host.id matching connectionId
      const host = createMockHostConfig({ id: '10.0.0.1:22:admin' });
      const conn = createMockConnection({ host });

      // Phase 1: Create port forwards on active connection
      mockGetAllConnections.mockReturnValue([conn]);
      mockGetConnection.mockReturnValue(conn);

      await service.forwardPort(conn as any, 3000, 'localhost', 3000);
      await service.forwardPort(conn as any, 8080, 'localhost', 80);

      // Verify: 2 active forwards + 2 saved rules
      expect(treeProvider.getForwardsForConnection(conn.id)).toHaveLength(2);
      expect(service.getSavedRules(conn.id)).toHaveLength(2);

      // Phase 2: Simulate disconnect (deactivate, don't delete)
      await service.deactivateAllForwardsForConnection(conn.id);
      expect(treeProvider.getForwardsForConnection(conn.id)).toHaveLength(0);
      expect(service.getSavedRules(conn.id)).toHaveLength(2); // Rules persist!

      // Phase 3: Simulate session restart (new service instance, same globalState)
      (PortForwardService as any)._instance = undefined;
      const freshService = PortForwardService.getInstance();
      freshService.initialize(mockContext);
      freshService.setTreeProvider(treeProvider);

      // Verify: rules survived restart
      expect(freshService.getSavedRules(conn.id)).toHaveLength(2);

      // Phase 4: Simulate reconnect → restore
      jest.clearAllMocks();
      await freshService.restoreForwardsForConnection(conn as any);

      // Verify: both forwards restored
      expect(conn.forwardPort).toHaveBeenCalledTimes(2);
      expect(conn.forwardPort).toHaveBeenCalledWith(3000, 'localhost', 3000);
      expect(conn.forwardPort).toHaveBeenCalledWith(8080, 'localhost', 80);
    });
  });

  describe('tree view shows correct items through lifecycle', () => {
    it('should show active items during connection, dimmed items after disconnect', async () => {
      const host = createMockHostConfig({ id: '10.0.0.1:22:admin' });
      const conn = createMockConnection({ host });

      mockGetAllConnections.mockReturnValue([conn]);
      mockGetConnection.mockReturnValue(conn);
      mockGetAllHosts.mockReturnValue([host]);

      // Create forward → tree shows active item
      await service.forwardPort(conn as any, 3000, 'localhost', 3000);

      let children = await treeProvider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(PortForwardTreeItem);

      // Deactivate → tree shows saved (dimmed) item
      await service.deactivateAllForwardsForConnection(conn.id);
      mockGetAllConnections.mockReturnValue([]); // No active connections

      children = await treeProvider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(SavedForwardTreeItem);

      // Reconnect and restore → tree shows active item again
      mockGetAllConnections.mockReturnValue([conn]);
      await service.restoreForwardsForConnection(conn as any);

      children = await treeProvider.getChildren();
      expect(children).toHaveLength(1);
      expect(children[0]).toBeInstanceOf(PortForwardTreeItem);
    });
  });

  describe('multi-server isolation', () => {
    it('should restore only the correct server rules', async () => {
      const host1 = createMockHostConfig({ id: '10.0.0.1:22:admin', host: '10.0.0.1' });
      const host2 = createMockHostConfig({ id: '10.0.0.2:22:deploy', host: '10.0.0.2' });
      const conn1 = createMockConnection({ host: host1 });
      const conn2 = createMockConnection({ host: host2 });

      // Create forwards on both servers
      await service.forwardPort(conn1 as any, 3000, 'localhost', 3000);
      await service.forwardPort(conn2 as any, 8080, 'localhost', 80);

      // Restore only server 1
      jest.clearAllMocks();
      await service.restoreForwardsForConnection(conn1 as any);

      // Only server 1's forward should be restored
      expect(conn1.forwardPort).toHaveBeenCalledTimes(1);
      expect(conn1.forwardPort).toHaveBeenCalledWith(3000, 'localhost', 3000);
      expect(conn2.forwardPort).not.toHaveBeenCalled();
    });
  });

  describe('delete saved rule permanently', () => {
    it('should remove rule so it is not restored on next connect', async () => {
      const host = createMockHostConfig({ id: '10.0.0.1:22:admin' });
      const conn = createMockConnection({ host: host });

      // Create and save
      await service.forwardPort(conn as any, 3000, 'localhost', 3000);
      const rules = service.getSavedRules(conn.id);
      expect(rules).toHaveLength(1);

      // Delete
      await service.deleteSavedRule(conn.id, rules[0].id);
      expect(service.getSavedRules(conn.id)).toHaveLength(0);

      // Restore should do nothing
      jest.clearAllMocks();
      await service.restoreForwardsForConnection(conn as any);
      expect(conn.forwardPort).not.toHaveBeenCalled();
    });
  });

  describe('activate saved forward manually', () => {
    it('should activate a saved rule on active connection', async () => {
      const host = createMockHostConfig({ id: '10.0.0.1:22:admin' });
      const conn = createMockConnection({ host: host });
      mockGetConnection.mockReturnValue(conn);

      // Save a rule manually
      const rule = await service.saveRule(conn.id, 5432, 'localhost', 5432);
      jest.clearAllMocks();

      // Activate it
      await service.activateSavedForward(conn.id, rule.id);

      expect(conn.forwardPort).toHaveBeenCalledWith(5432, 'localhost', 5432);
    });

    it('should show warning when activating without connection', async () => {
      mockGetConnection.mockReturnValue(undefined);

      const rule = await service.saveRule('offline:22:user', 5432, 'localhost', 5432);
      await service.activateSavedForward('offline:22:user', rule.id);

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('No active connection')
      );
    });
  });

  describe('partial restore failure', () => {
    it('should restore successful rules and skip failed ones', async () => {
      const host = createMockHostConfig({ id: '10.0.0.1:22:admin' });
      const conn = createMockConnection({ host: host });

      // Save two rules
      await service.saveRule(conn.id, 3000, 'localhost', 3000);
      await service.saveRule(conn.id, 8080, 'localhost', 80);

      // Port 3000 succeeds, port 8080 fails (e.g., EADDRINUSE)
      jest.clearAllMocks();
      (conn.forwardPort as jest.Mock)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('EADDRINUSE'));

      await service.restoreForwardsForConnection(conn as any);

      // First should be added to tree, second should not
      expect(treeProvider.getForwardsForConnection(conn.id)).toHaveLength(1);
      expect(treeProvider.getForwardsForConnection(conn.id)[0].localPort).toBe(3000);

      // Both rules should still be saved (failure doesn't delete)
      expect(service.getSavedRules(conn.id)).toHaveLength(2);
    });
  });
});
