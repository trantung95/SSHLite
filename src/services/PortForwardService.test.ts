/**
 * PortForwardService tests
 *
 * Tests port forward create/stop/batch operations and persistence
 */

import { IPortForward } from '../types';
import { window } from '../__mocks__/vscode';
import { createMockConnection, createMockHostConfig, createMockPortForward } from '../__mocks__/testHelpers';

// Mock ConnectionManager - declare mocks before jest.mock so they're initialized
// before the module factory runs (jest.mock is hoisted above imports)
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

    it('should delete saved rule', async () => {
      service.initialize(mockContext);

      const rule = await service.saveRule('host1:22:user', 3000, 'localhost', 3000);
      await service.deleteSavedRule('host1:22:user', rule.id);

      const rules = service.getSavedRules('host1:22:user');
      expect(rules).toHaveLength(0);
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
    it('should activate a saved forward on active connection', async () => {
      service.initialize(mockContext);
      const mockConn = createMockConnection();
      mockGetConnection.mockReturnValue(mockConn);

      const rule = await service.saveRule(mockConn.id, 3000, 'localhost', 3000);
      jest.clearAllMocks();

      await service.activateSavedForward(mockConn.id, rule.id);

      expect(mockConn.forwardPort).toHaveBeenCalledWith(3000, 'localhost', 3000);
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
  });
});
