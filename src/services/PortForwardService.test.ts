/**
 * PortForwardService tests
 *
 * Tests port forward create/stop/batch operations and persistence
 */

import { IPortForward } from '../types';
import { resetWindowMocks, window } from '../__mocks__/vscode';
import { createMockConnection, createMockHostConfig, createMockPortForward } from '../__mocks__/testHelpers';

// Mock ConnectionManager - declare mocks before jest.mock so they're initialized
// before the module factory runs (jest.mock is hoisted above imports)
var mockGetConnection = jest.fn();
var mockGetAllConnections = jest.fn().mockReturnValue([]);
jest.mock('../connection/ConnectionManager', () => {
  const { EventEmitter } = require('../__mocks__/vscode');
  return {
    ConnectionManager: {
      getInstance: jest.fn().mockImplementation(() => ({
        get getAllConnections() { return mockGetAllConnections; },
        get getConnection() { return mockGetConnection; },
        onDidChangeConnections: new EventEmitter().event,
      })),
    },
  };
});

// Import after mock declarations to avoid temporal dead zone
import { PortForwardService } from './PortForwardService';

// Mock PortForwardTreeProvider
const mockAddForward = jest.fn();
const mockRemoveForward = jest.fn();
const mockGetForwardsForConnection = jest.fn().mockReturnValue([]);
const mockRefresh = jest.fn();

// Mock globalState
const mockGlobalStateStore: Record<string, any> = {};
const mockGlobalState = {
  get: jest.fn((key: string) => mockGlobalStateStore[key]),
  update: jest.fn(async (key: string, value: any) => {
    mockGlobalStateStore[key] = value;
  }),
};
const mockContext = {
  globalState: mockGlobalState,
} as any;

function resetPortForwardService(): PortForwardService {
  (PortForwardService as any)._instance = undefined;
  // Clear stored rules
  delete mockGlobalStateStore['sshLite.savedPortForwards'];
  const service = PortForwardService.getInstance();
  service.setTreeProvider({
    addForward: mockAddForward,
    removeForward: mockRemoveForward,
    getForwardsForConnection: mockGetForwardsForConnection,
    refresh: mockRefresh,
    getTreeItem: jest.fn(),
    getChildren: jest.fn(),
    onDidChangeTreeData: jest.fn(),
    dispose: jest.fn(),
  } as any);
  return service;
}

describe('PortForwardService', () => {
  let service: PortForwardService;

  beforeEach(() => {
    jest.clearAllMocks();
    resetWindowMocks();
    service = resetPortForwardService();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const a = PortForwardService.getInstance();
      const b = PortForwardService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('forwardPort', () => {
    it('should call connection.forwardPort with correct args', async () => {
      const mockConn = createMockConnection();

      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000);

      expect(mockConn.forwardPort).toHaveBeenCalledWith(3000, 'localhost', 3000);
    });

    it('should add forward to tree provider', async () => {
      const mockConn = createMockConnection();

      await service.forwardPort(mockConn as any, 8080, 'localhost', 80);

      expect(mockAddForward).toHaveBeenCalledWith(mockConn.id, 8080, 'localhost', 80);
    });

    it('should show success status bar message', async () => {
      const mockConn = createMockConnection();

      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000);

      expect(window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('Port forward'),
        5000
      );
    });

    it('should show error message on failure', async () => {
      const mockConn = createMockConnection();
      (mockConn.forwardPort as jest.Mock).mockRejectedValue(new Error('Address in use'));

      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Address in use')
      );
    });

    it('should not add to tree on failure', async () => {
      const mockConn = createMockConnection();
      (mockConn.forwardPort as jest.Mock).mockRejectedValue(new Error('Failed'));

      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000);

      expect(mockAddForward).not.toHaveBeenCalled();
    });

    it('uses connection recovery for an interactive connection failure', async () => {
      const mockConn = createMockConnection();
      (mockConn.forwardPort as jest.Mock).mockRejectedValue(new Error('Not connected'));

      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000, {
        interactiveCreate: true,
      });

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Create port forward failed: Not connected. Check the connection and try again.',
        'Retry'
      );
    });

    it('removes a partially added tree row before offering Retry', async () => {
      const mockConn = createMockConnection();
      const treeRows = new Set<string>();
      const partialTreeProvider = {
        addForward: jest.fn((connectionId: string, localPort: number) => {
          treeRows.add(`${connectionId}:${localPort}`);
          throw new Error('Tree refresh failed');
        }),
        removeForward: jest.fn((localPort: number, connectionId: string) => {
          treeRows.delete(`${connectionId}:${localPort}`);
        }),
      };
      service.setTreeProvider(partialTreeProvider as any);

      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000, {
        interactiveCreate: true,
      });

      expect(treeRows.size).toBe(0);
      expect(mockConn.stopForward).toHaveBeenCalledWith(3000);
      expect(partialTreeProvider.removeForward).toHaveBeenCalledWith(3000, mockConn.id);
      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Create port forward failed: Tree refresh failed. Refresh the Port Forwards view and try again.',
        'Retry'
      );
    });

    it('should auto-save rule on success', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();

      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000);

      const rules = service.getSavedRules(mockConn.id);
      expect(rules).toHaveLength(1);
      expect(rules[0].localPort).toBe(3000);
      expect(rules[0].remoteHost).toBe('localhost');
      expect(rules[0].remotePort).toBe(3000);
    });

    it('should not save rule on failure', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      (mockConn.forwardPort as jest.Mock).mockRejectedValue(new Error('Failed'));

      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000);

      const rules = service.getSavedRules(mockConn.id);
      expect(rules).toHaveLength(0);
    });

    it('rolls back an active listener before offering Retry when persistence fails', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      mockGlobalState.update.mockRejectedValueOnce(new Error('Storage unavailable'));

      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000, {
        interactiveCreate: true,
      });

      expect(mockConn.stopForward).toHaveBeenCalledWith(3000);
      expect(mockRemoveForward).toHaveBeenCalledWith(3000, mockConn.id);
      expect(service.getSavedRules(mockConn.id)).toHaveLength(0);
      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Create port forward failed: Storage unavailable. Check storage access and try again.',
        'Retry'
      );
    });

    it('does not offer Retry when a failed save cannot roll back the listener', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      (mockConn.stopForward as jest.Mock).mockRejectedValueOnce(new Error('Listener still active'));
      mockGlobalState.update.mockRejectedValueOnce(new Error('Storage unavailable'));

      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000, {
        interactiveCreate: true,
      });

      expect(mockRemoveForward).not.toHaveBeenCalled();
      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Create port forward failed: Storage unavailable. Stop the active port forward before trying again.'
      );
    });
  });

  describe('stopForward', () => {
    it('should call connection.stopForward', async () => {
      const mockConn = createMockConnection();
      mockGetConnection.mockReturnValue(mockConn);

      const forward = createMockPortForward({
        connectionId: mockConn.id,
        localPort: 3000,
      });

      await service.stopForward(forward);

      expect(mockConn.stopForward).toHaveBeenCalledWith(3000);
    });

    it('should remove forward from tree provider', async () => {
      const mockConn = createMockConnection();
      mockGetConnection.mockReturnValue(mockConn);

      const forward = createMockPortForward({
        connectionId: mockConn.id,
        localPort: 8080,
      });

      await service.stopForward(forward);

      expect(mockRemoveForward).toHaveBeenCalledWith(8080, mockConn.id);
    });

    it('should show warning if connection no longer active', async () => {
      mockGetConnection.mockReturnValue(undefined);

      const forward = createMockPortForward({ connectionId: 'disconnected' });

      await service.stopForward(forward);

      expect(window.showWarningMessage).toHaveBeenCalledWith('Connection no longer active');
    });

    it('should show error on stopForward failure', async () => {
      const mockConn = createMockConnection();
      (mockConn.stopForward as jest.Mock).mockRejectedValue(new Error('Cannot stop'));
      mockGetConnection.mockReturnValue(mockConn);

      const forward = createMockPortForward({ connectionId: mockConn.id });

      await service.stopForward(forward);

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        expect.stringContaining('Cannot stop')
      );
    });

    it('should show status bar message on success', async () => {
      const mockConn = createMockConnection();
      mockGetConnection.mockReturnValue(mockConn);

      const forward = createMockPortForward({
        connectionId: mockConn.id,
        localPort: 5432,
      });

      await service.stopForward(forward);

      expect(window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('5432'),
        3000
      );
    });

    it('should keep saved rule after stopping', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      mockGetConnection.mockReturnValue(mockConn);

      // Create forward (auto-saves rule)
      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000);

      // Stop it
      const forward = createMockPortForward({
        connectionId: mockConn.id,
        localPort: 3000,
      });
      await service.stopForward(forward);

      // Saved rule should still exist
      const rules = service.getSavedRules(mockConn.id);
      expect(rules).toHaveLength(1);
    });
  });

  describe('deactivateAllForwardsForConnection', () => {
    it('should stop all forwards for a connection', async () => {
      const mockConn = createMockConnection();
      mockGetConnection.mockReturnValue(mockConn);

      const forwards: IPortForward[] = [
        createMockPortForward({ connectionId: mockConn.id, localPort: 3000 }),
        createMockPortForward({ connectionId: mockConn.id, localPort: 8080 }),
        createMockPortForward({ connectionId: mockConn.id, localPort: 5432 }),
      ];
      mockGetForwardsForConnection.mockReturnValue(forwards);

      await service.deactivateAllForwardsForConnection(mockConn.id);

      expect(mockConn.stopForward).toHaveBeenCalledTimes(3);
      expect(mockRemoveForward).toHaveBeenCalledTimes(3);
    });

    it('should do nothing if no tree provider', async () => {
      (PortForwardService as any)._instance = undefined;
      const freshService = PortForwardService.getInstance();
      // No tree provider set

      // Should not throw
      await freshService.deactivateAllForwardsForConnection('conn1');
    });

    it('should handle missing connection gracefully', async () => {
      mockGetConnection.mockReturnValue(undefined);
      const forwards: IPortForward[] = [
        createMockPortForward({ connectionId: 'dead', localPort: 3000 }),
      ];
      mockGetForwardsForConnection.mockReturnValue(forwards);

      // Should not throw, should still remove from tree
      await service.deactivateAllForwardsForConnection('dead');
      expect(mockRemoveForward).toHaveBeenCalledTimes(1);
    });

    it('should keep saved rules after deactivation', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      mockGetConnection.mockReturnValue(mockConn);

      // Create a forward (auto-saves)
      await service.forwardPort(mockConn as any, 3000, 'localhost', 3000);

      const forwards: IPortForward[] = [
        createMockPortForward({ connectionId: mockConn.id, localPort: 3000 }),
      ];
      mockGetForwardsForConnection.mockReturnValue(forwards);

      await service.deactivateAllForwardsForConnection(mockConn.id);

      // Saved rule should persist
      const rules = service.getSavedRules(mockConn.id);
      expect(rules).toHaveLength(1);
    });
  });

  describe('persistence', () => {
    it('does not remove a current lifecycle tree row when a queued create is cancelled after reactivation', async () => {
      let releaseBlockingWrite!: () => void;
      let markBlockingWriteStarted!: () => void;
      let markOldRowAdded!: () => void;
      const blockingWriteGate = new Promise<void>((resolve) => {
        releaseBlockingWrite = resolve;
      });
      const blockingWriteStarted = new Promise<void>((resolve) => {
        markBlockingWriteStarted = resolve;
      });
      const oldRowAdded = new Promise<void>((resolve) => {
        markOldRowAdded = resolve;
      });
      const oldContext = {
        globalState: {
          get: jest.fn(),
          update: jest.fn(async () => {
            markBlockingWriteStarted();
            await blockingWriteGate;
          }),
        },
      } as any;
      const newContext = {
        globalState: {
          get: jest.fn(),
          update: jest.fn(async () => undefined),
        },
      } as any;
      const oldProvider = {
        addForward: jest.fn(() => markOldRowAdded()),
        removeForward: jest.fn(),
      };
      const currentRows = new Set<string>();
      const currentProvider = {
        addForward: jest.fn((connectionId: string, localPort: number) => {
          currentRows.add(`${connectionId}:${localPort}`);
        }),
        removeForward: jest.fn((localPort: number, connectionId: string) => {
          currentRows.delete(`${connectionId}:${localPort}`);
        }),
      };
      const connection = createMockConnection();

      service.initialize(oldContext);
      service.setTreeProvider(oldProvider as any);
      const blockingWrite = service.saveRule('blocking:22:user', 9000, 'localhost', 9000);
      await blockingWriteStarted;
      const oldCreate = service.forwardPort(connection as any, 3000, 'localhost', 3000);
      await oldRowAdded;

      service.dispose();
      service.initialize(newContext);
      service.setTreeProvider(currentProvider as any);
      currentProvider.addForward(connection.id, 3000);

      releaseBlockingWrite();
      await blockingWrite;
      await oldCreate;

      expect(currentRows).toContain(`${connection.id}:3000`);
      expect(currentProvider.removeForward).not.toHaveBeenCalled();
    });

    it('keeps a disposed lifecycle write from overwriting reactivated state', async () => {
      let releaseOldWrite!: () => void;
      let markOldWriteStarted!: () => void;
      const oldWriteGate = new Promise<void>((resolve) => {
        releaseOldWrite = resolve;
      });
      const oldWriteStarted = new Promise<void>((resolve) => {
        markOldWriteStarted = resolve;
      });
      const oldStore: Record<string, any> = {};
      const oldGlobalState = {
        get: jest.fn((key: string) => oldStore[key]),
        update: jest.fn(async (key: string, value: any) => {
          markOldWriteStarted();
          await oldWriteGate;
          oldStore[key] = value;
        }),
      };
      const reactivatedStore: Record<string, any> = {
        'sshLite.savedPortForwards': {
          'reactivated:22:user': [
            { id: 'existing', localPort: 4000, remoteHost: 'localhost', remotePort: 4000 },
          ],
        },
      };
      const reactivatedGlobalState = {
        get: jest.fn((key: string) => reactivatedStore[key]),
        update: jest.fn(async (key: string, value: any) => {
          reactivatedStore[key] = value;
        }),
      };

      service.initialize({ globalState: oldGlobalState } as any);
      const oldWrite = service.saveRule('old:22:user', 3000, 'localhost', 3000);
      await oldWriteStarted;

      service.dispose();
      service.initialize({ globalState: reactivatedGlobalState } as any);
      const reactivatedWrite = service.saveRule('reactivated:22:user', 5000, 'localhost', 5000);
      await Promise.resolve();

      const reactivatedWritesBeforeRelease = reactivatedGlobalState.update.mock.calls.length;

      releaseOldWrite();
      await oldWrite;
      await reactivatedWrite;

      expect(reactivatedWritesBeforeRelease).toBe(0);
      expect(service.getHostIdsWithSavedRules()).toEqual(['reactivated:22:user']);
      expect(service.getSavedRules('reactivated:22:user')).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'existing', localPort: 4000 }),
        expect.objectContaining({ localPort: 5000 }),
      ]));
      expect(reactivatedStore['sshLite.savedPortForwards']).toEqual(
        expect.objectContaining({
          'reactivated:22:user': expect.arrayContaining([
            expect.objectContaining({ id: 'existing', localPort: 4000 }),
            expect.objectContaining({ localPort: 5000 }),
          ]),
        })
      );
    });

    it('should initialize and load saved rules from globalState', () => {
      const existingRules = {
        'host1:22:user': [
          { id: 'pf_1', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 },
        ],
      };
      mockGlobalStateStore['sshLite.savedPortForwards'] = existingRules;

      service.initialize(mockContext);

      const rules = service.getSavedRules('host1:22:user');
      expect(rules).toHaveLength(1);
      expect(rules[0].localPort).toBe(3000);
    });

    it('should handle empty globalState gracefully', () => {
      service.initialize(mockContext);

      const rules = service.getSavedRules('nonexistent');
      expect(rules).toEqual([]);
    });

    it('should save rule to globalState', async () => {
      service.initialize(mockContext);

      await service.saveRule('host1:22:user', 3000, 'localhost', 3000);

      expect(mockGlobalState.update).toHaveBeenCalledWith(
        'sshLite.savedPortForwards',
        expect.objectContaining({
          'host1:22:user': expect.arrayContaining([
            expect.objectContaining({ localPort: 3000 }),
          ]),
        })
      );
    });

    it('should deduplicate saved rules', async () => {
      service.initialize(mockContext);

      await service.saveRule('host1:22:user', 3000, 'localhost', 3000);
      await service.saveRule('host1:22:user', 3000, 'localhost', 3000);

      const rules = service.getSavedRules('host1:22:user');
      expect(rules).toHaveLength(1);
    });

    it('should allow different rules for same host', async () => {
      service.initialize(mockContext);

      await service.saveRule('host1:22:user', 3000, 'localhost', 3000);
      await service.saveRule('host1:22:user', 8080, 'localhost', 80);

      const rules = service.getSavedRules('host1:22:user');
      expect(rules).toHaveLength(2);
    });

    it('preserves concurrent saved-rule writes', async () => {
      service.initialize(mockContext);

      await Promise.all([
        service.saveRule('host1:22:user', 3000, 'localhost', 3000),
        service.saveRule('host1:22:user', 8080, 'database.internal', 5432),
      ]);

      expect(service.getSavedRules('host1:22:user')).toEqual(expect.arrayContaining([
        expect.objectContaining({ localPort: 3000, remoteHost: 'localhost', remotePort: 3000 }),
        expect.objectContaining({ localPort: 8080, remoteHost: 'database.internal', remotePort: 5432 }),
      ]));
      expect(service.getSavedRules('host1:22:user')).toHaveLength(2);
    });

    it('should delete saved rule', async () => {
      service.initialize(mockContext);

      const rule = await service.saveRule('host1:22:user', 3000, 'localhost', 3000);
      await service.deleteSavedRule('host1:22:user', rule.id);

      const rules = service.getSavedRules('host1:22:user');
      expect(rules).toHaveLength(0);
    });

    it('keeps the saved rule when persistence rejects deletion', async () => {
      service.initialize(mockContext);
      const rule = await service.saveRule('host1:22:user', 3000, 'localhost', 3000);
      mockRefresh.mockClear();
      mockGlobalState.update.mockRejectedValueOnce(new Error('Storage unavailable'));

      await expect(service.deleteSavedRule('host1:22:user', rule.id)).rejects.toThrow(
        'Storage unavailable'
      );

      expect(service.getSavedRules('host1:22:user')).toEqual([rule]);
      expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('clears a restore failure when its saved rule is deleted', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      const rule = await service.saveRule(mockConn.id, 3000, 'localhost', 3000);
      (mockConn.forwardPort as jest.Mock).mockRejectedValueOnce(new Error('Address already in use'));
      await service.restoreForwardsForConnection(mockConn as any);
      expect(service.getRestoreFailure(mockConn.id, rule.id)).toBe('Address already in use');

      await service.deleteSavedRule(mockConn.id, rule.id);

      expect(service.getRestoreFailure(mockConn.id, rule.id)).toBeUndefined();
    });

    it('should refresh tree after deleting rule', async () => {
      service.initialize(mockContext);

      const rule = await service.saveRule('host1:22:user', 3000, 'localhost', 3000);
      mockRefresh.mockClear();
      await service.deleteSavedRule('host1:22:user', rule.id);

      expect(mockRefresh).toHaveBeenCalled();
    });

    it('should clean up host entry when last rule deleted', async () => {
      service.initialize(mockContext);

      const rule = await service.saveRule('host1:22:user', 3000, 'localhost', 3000);
      await service.deleteSavedRule('host1:22:user', rule.id);

      expect(service.getHostIdsWithSavedRules()).not.toContain('host1:22:user');
    });

    it('should return all hostIds with saved rules', async () => {
      service.initialize(mockContext);

      await service.saveRule('host1:22:user', 3000, 'localhost', 3000);
      await service.saveRule('host2:22:admin', 8080, 'localhost', 80);

      const hostIds = service.getHostIdsWithSavedRules();
      expect(hostIds).toContain('host1:22:user');
      expect(hostIds).toContain('host2:22:admin');
    });
  });

  describe('restoreForwardsForConnection', () => {
    it('should restore saved forwards on connect', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();

      // Save a rule
      await service.saveRule(mockConn.id, 3000, 'localhost', 3000);
      jest.clearAllMocks();

      // Restore
      await service.restoreForwardsForConnection(mockConn as any);

      expect(mockConn.forwardPort).toHaveBeenCalledWith(3000, 'localhost', 3000);
      expect(mockAddForward).toHaveBeenCalledWith(mockConn.id, 3000, 'localhost', 3000);
    });

    it('should restore multiple forwards', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();

      await service.saveRule(mockConn.id, 3000, 'localhost', 3000);
      await service.saveRule(mockConn.id, 8080, 'localhost', 80);
      jest.clearAllMocks();

      await service.restoreForwardsForConnection(mockConn as any);

      expect(mockConn.forwardPort).toHaveBeenCalledTimes(2);
    });

    it('should handle partial failures gracefully', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      // First call succeeds, second fails
      (mockConn.forwardPort as jest.Mock)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Address in use'));

      await service.saveRule(mockConn.id, 3000, 'localhost', 3000);
      await service.saveRule(mockConn.id, 8080, 'localhost', 80);
      jest.clearAllMocks();

      await service.restoreForwardsForConnection(mockConn as any);

      // First forward should be added to tree, second should not
      expect(mockAddForward).toHaveBeenCalledTimes(1);
      expect(mockAddForward).toHaveBeenCalledWith(mockConn.id, 3000, 'localhost', 3000);
    });

    it('keeps a failed restored rule visible with the reason', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      const rule = await service.saveRule(mockConn.id, 8080, 'localhost', 3000);
      (mockConn.forwardPort as jest.Mock).mockRejectedValueOnce(new Error('Address already in use'));
      jest.clearAllMocks();

      await service.restoreForwardsForConnection(mockConn as any);

      expect(service.getRestoreFailure(mockConn.id, rule.id)).toBe('Address already in use');
      expect(mockRefresh).toHaveBeenCalled();
    });

    it('clears a previous restore failure after the rule restores successfully', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      const rule = await service.saveRule(mockConn.id, 8080, 'localhost', 3000);
      (mockConn.forwardPort as jest.Mock)
        .mockRejectedValueOnce(new Error('Address already in use'))
        .mockResolvedValueOnce(undefined);

      await service.restoreForwardsForConnection(mockConn as any);
      expect(service.getRestoreFailure(mockConn.id, rule.id)).toBe('Address already in use');

      await service.restoreForwardsForConnection(mockConn as any);

      expect(service.getRestoreFailure(mockConn.id, rule.id)).toBeUndefined();
    });

    it('does not persist restore failures across service instances', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      const rule = await service.saveRule(mockConn.id, 8080, 'localhost', 3000);
      (mockConn.forwardPort as jest.Mock).mockRejectedValueOnce(new Error('Address already in use'));
      await service.restoreForwardsForConnection(mockConn as any);
      expect(service.getRestoreFailure(mockConn.id, rule.id)).toBe('Address already in use');

      (PortForwardService as any)._instance = undefined;
      const freshService = PortForwardService.getInstance();
      freshService.initialize(mockContext);

      expect(freshService.getSavedRules(mockConn.id)).toHaveLength(1);
      expect(freshService.getRestoreFailure(mockConn.id, rule.id)).toBeUndefined();
    });

    it('keeps IPv6 host and colon-bearing legacy rule restore failures distinct', async () => {
      const firstHostId = '::1:22:a';
      const secondHostId = '::1:22:a:23:b';
      const firstRule = { id: '23:b:c', localPort: 3000, remoteHost: 'localhost', remotePort: 3000 };
      const secondRule = { id: 'c', localPort: 4000, remoteHost: 'localhost', remotePort: 4000 };
      mockGlobalStateStore['sshLite.savedPortForwards'] = {
        [firstHostId]: [firstRule],
        [secondHostId]: [secondRule],
      };
      service.initialize(mockContext);
      const firstConnection = createMockConnection({ id: firstHostId });
      const secondConnection = createMockConnection({ id: secondHostId });
      (firstConnection.forwardPort as jest.Mock).mockRejectedValueOnce(new Error('First failure'));
      (secondConnection.forwardPort as jest.Mock).mockRejectedValueOnce(new Error('Second failure'));

      await service.restoreForwardsForConnection(firstConnection as any);
      await service.restoreForwardsForConnection(secondConnection as any);

      expect(service.getRestoreFailure(firstHostId, firstRule.id)).toBe('First failure');
      expect(service.getRestoreFailure(secondHostId, secondRule.id)).toBe('Second failure');
    });

    it('clears runtime state and stale references across dispose and reactivation', async () => {
      service.initialize(mockContext);
      const connection = createMockConnection();
      const rule = await service.saveRule(connection.id, 8080, 'localhost', 3000);
      (connection.forwardPort as jest.Mock).mockRejectedValueOnce(new Error('Address already in use'));
      await service.restoreForwardsForConnection(connection as any);
      expect(service.getRestoreFailure(connection.id, rule.id)).toBe('Address already in use');

      mockRefresh.mockClear();
      mockGlobalState.update.mockClear();
      service.dispose();
      await service.deleteSavedRule(connection.id, rule.id);

      expect(service.getRestoreFailure(connection.id, rule.id)).toBeUndefined();
      expect(mockRefresh).not.toHaveBeenCalled();
      expect(mockGlobalState.update).not.toHaveBeenCalled();

      service.initialize(mockContext);
      expect(service.getSavedRules(connection.id)).toHaveLength(1);
      expect(service.getRestoreFailure(connection.id, rule.id)).toBeUndefined();
    });

    it('should do nothing when no saved rules', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();

      await service.restoreForwardsForConnection(mockConn as any);

      expect(mockConn.forwardPort).not.toHaveBeenCalled();
    });

    it('should show status message on restore', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();

      await service.saveRule(mockConn.id, 3000, 'localhost', 3000);
      jest.clearAllMocks();

      await service.restoreForwardsForConnection(mockConn as any);

      expect(window.setStatusBarMessage).toHaveBeenCalledWith(
        expect.stringContaining('Restored 1 port forward'),
        5000
      );
    });
  });

  describe('activateSavedForward', () => {
    it('warns instead of activating a same-id connection without port forwarding', async () => {
      service.initialize(mockContext);
      const unavailableConnection = createMockConnection({ id: 'shared:21:user' });
      unavailableConnection.capabilities.supportsPortForward = false;
      mockGetConnection.mockReturnValue(unavailableConnection);
      const rule = await service.saveRule(unavailableConnection.id, 3000, 'localhost', 3000);
      jest.clearAllMocks();

      await expect(
        service.activateSavedForward(unavailableConnection.id, rule.id)
      ).resolves.toBeUndefined();

      expect(unavailableConnection.forwardPort).not.toHaveBeenCalled();
      expect(window.showWarningMessage).toHaveBeenCalledWith(
        'Port forwarding is unavailable for this connection. Connect using Secure Shell (SSH) to start this saved rule.'
      );
    });

    it('should activate a saved forward on active connection', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      mockGetConnection.mockReturnValue(mockConn);

      const rule = await service.saveRule(mockConn.id, 3000, 'localhost', 3000);
      jest.clearAllMocks();

      await service.activateSavedForward(mockConn.id, rule.id);

      expect(mockConn.forwardPort).toHaveBeenCalledWith(3000, 'localhost', 3000);
    });

    it('clears a restore failure after manual activation succeeds', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      mockGetConnection.mockReturnValue(mockConn);
      const rule = await service.saveRule(mockConn.id, 3000, 'localhost', 3000);
      (mockConn.forwardPort as jest.Mock)
        .mockRejectedValueOnce(new Error('Address already in use'))
        .mockResolvedValueOnce(undefined);
      await service.restoreForwardsForConnection(mockConn as any);
      expect(service.getRestoreFailure(mockConn.id, rule.id)).toBe('Address already in use');

      await service.activateSavedForward(mockConn.id, rule.id);

      expect(service.getRestoreFailure(mockConn.id, rule.id)).toBeUndefined();
    });

    it('should show warning if rule not found', async () => {
      service.initialize(mockContext);

      await service.activateSavedForward('host1:22:user', 'nonexistent');

      expect(window.showWarningMessage).toHaveBeenCalledWith('Saved forward rule not found');
    });

    it('should show warning if no active connection', async () => {
      service.initialize(mockContext);
      mockGetConnection.mockReturnValue(undefined);

      const rule = await service.saveRule('host1:22:user', 3000, 'localhost', 3000);

      await service.activateSavedForward('host1:22:user', rule.id);

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('No active connection')
      );
    });
  });

  describe('promptForwardPort', () => {
    it('should show warning if no connections', async () => {
      mockGetAllConnections.mockReturnValue([]);

      await service.promptForwardPort();

      expect(window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('No active SSH connections')
      );
    });

    it('should show quick pick to select connection', async () => {
      const mockConn = createMockConnection();
      mockGetAllConnections.mockReturnValue([mockConn]);
      (window.showQuickPick as jest.Mock).mockResolvedValue(undefined); // User cancels

      await service.promptForwardPort();

      expect(window.showQuickPick).toHaveBeenCalled();
    });

    it('labels Step 1 and describes each active server', async () => {
      const connected = createMockConnection({
        id: 'connected',
        host: createMockHostConfig({
          name: 'Connected Server',
          host: 'connected.example.com',
          port: 2222,
          username: 'alice',
        }),
      });
      mockGetAllConnections.mockReturnValue([connected]);
      (window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

      await service.promptForwardPort();

      const [items, options] = (window.showQuickPick as jest.Mock).mock.calls[0];
      expect(options.title).toBe('Create Port Forward — Step 1 of 3');
      expect(items.map((item: any) => item.label)).toEqual(['Connected Server']);
      expect(items[0].description).toBe('alice@connected.example.com · port 2222');
    });

    it('should cancel if user dismisses connection picker', async () => {
      const mockConn = createMockConnection();
      mockGetAllConnections.mockReturnValue([mockConn]);
      (window.showQuickPick as jest.Mock).mockResolvedValue(undefined);

      await service.promptForwardPort();

      // Should not proceed to port input
      expect(window.showInputBox).not.toHaveBeenCalled();
    });

    it('should prompt for local port after connection selection', async () => {
      const mockConn = createMockConnection();
      mockGetAllConnections.mockReturnValue([mockConn]);
      (window.showQuickPick as jest.Mock).mockResolvedValue({
        connection: mockConn,
      });
      (window.showInputBox as jest.Mock).mockResolvedValue(undefined); // User cancels

      await service.promptForwardPort();

      expect(window.showInputBox).toHaveBeenCalled();
    });

    it('uses destination inputs in Step 2 and local port in Step 3', async () => {
      const mockConn = createMockConnection();
      (mockConn as any).getActiveForwards = jest.fn().mockReturnValue([8080]);
      mockGetAllConnections.mockReturnValue([mockConn]);
      (window.showQuickPick as jest.Mock).mockResolvedValue({ connection: mockConn });
      (window.showInputBox as jest.Mock)
        .mockResolvedValueOnce('3000')
        .mockResolvedValueOnce('db.internal')
        .mockResolvedValueOnce('8081');

      await service.promptForwardPort();

      const inputCalls = (window.showInputBox as jest.Mock).mock.calls;
      expect(inputCalls[0][0]).toEqual(expect.objectContaining({
        title: 'Create Port Forward — Step 2 of 3',
        prompt: 'Enter the service port on the destination host',
      }));
      expect(inputCalls[1][0]).toEqual(expect.objectContaining({
        title: 'Create Port Forward — Step 2 of 3',
        prompt: 'Enter the destination host. localhost means the SSH server itself',
        value: 'localhost',
      }));
      expect(inputCalls[2][0]).toEqual(expect.objectContaining({
        title: 'Create Port Forward — Step 3 of 3',
        prompt: 'Enter the listening port on this computer',
        value: '3000',
      }));
      expect(inputCalls[2][0].validateInput('8080')).toBe(
        'Local port 8080 is already forwarded'
      );
      expect(mockConn.forwardPort).toHaveBeenCalledWith(8081, 'db.internal', 3000);
    });

    it('validates local ports used by another active connection', async () => {
      const selected = createMockConnection({ id: 'selected' });
      const other = createMockConnection({ id: 'other' });
      (selected as any).getActiveForwards = jest.fn().mockReturnValue([]);
      (other as any).getActiveForwards = jest.fn().mockReturnValue([9000]);
      mockGetAllConnections.mockReturnValue([selected, other]);
      (window.showQuickPick as jest.Mock).mockResolvedValue({ connection: selected });
      (window.showInputBox as jest.Mock)
        .mockResolvedValueOnce('3000')
        .mockResolvedValueOnce('localhost')
        .mockResolvedValueOnce(undefined);

      await service.promptForwardPort();

      const localOptions = (window.showInputBox as jest.Mock).mock.calls[2][0];
      expect(localOptions.validateInput('9000')).toBe('Local port 9000 is already forwarded');
    });

    it('shows route and saved-rule confirmation after creation', async () => {
      const mockConn = createMockConnection();
      (mockConn as any).getActiveForwards = jest.fn().mockReturnValue([]);
      mockGetAllConnections.mockReturnValue([mockConn]);
      (window.showQuickPick as jest.Mock).mockResolvedValue({ connection: mockConn });
      (window.showInputBox as jest.Mock)
        .mockResolvedValueOnce('3000')
        .mockResolvedValueOnce('localhost')
        .mockResolvedValueOnce('8080');

      await service.promptForwardPort();

      expect(window.setStatusBarMessage).toHaveBeenCalledWith(
        '$(check) Port forward created and saved: localhost:8080 → localhost:3000',
        5000
      );
    });

    it('explains creation failure and offers a safe retry', async () => {
      const mockConn = createMockConnection();
      (mockConn as any).getActiveForwards = jest.fn().mockReturnValue([]);
      (mockConn.forwardPort as jest.Mock).mockRejectedValueOnce(new Error('Address already in use'));
      mockGetAllConnections.mockReturnValue([mockConn]);
      (window.showQuickPick as jest.Mock)
        .mockResolvedValueOnce({ connection: mockConn })
        .mockResolvedValueOnce(undefined);
      (window.showInputBox as jest.Mock)
        .mockResolvedValueOnce('3000')
        .mockResolvedValueOnce('localhost')
        .mockResolvedValueOnce('8080');
      (window.showErrorMessage as jest.Mock).mockResolvedValue('Retry');

      await service.promptForwardPort();

      expect(window.showErrorMessage).toHaveBeenCalledWith(
        'Create port forward failed: Address already in use. Choose another local port and try again.',
        'Retry'
      );
      expect(window.showQuickPick).toHaveBeenCalledTimes(2);
    });
  });
});
