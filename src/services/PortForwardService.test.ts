/**
 * PortForwardService tests
 *
 * Tests port forward create/stop/batch operations
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

function resetPortForwardService(): PortForwardService {
  (PortForwardService as any)._instance = undefined;
  const service = PortForwardService.getInstance();
  service.setTreeProvider({
    addForward: mockAddForward,
    removeForward: mockRemoveForward,
    getForwardsForConnection: mockGetForwardsForConnection,
    refresh: jest.fn(),
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
  });

  describe('stopAllForwardsForConnection', () => {
    it('should stop all forwards for a connection', async () => {
      const mockConn = createMockConnection();
      mockGetConnection.mockReturnValue(mockConn);

      const forwards: IPortForward[] = [
        createMockPortForward({ connectionId: mockConn.id, localPort: 3000 }),
        createMockPortForward({ connectionId: mockConn.id, localPort: 8080 }),
        createMockPortForward({ connectionId: mockConn.id, localPort: 5432 }),
      ];
      mockGetForwardsForConnection.mockReturnValue(forwards);

      await service.stopAllForwardsForConnection(mockConn.id);

      expect(mockConn.stopForward).toHaveBeenCalledTimes(3);
      expect(mockRemoveForward).toHaveBeenCalledTimes(3);
    });

    it('should do nothing if no tree provider', async () => {
      (PortForwardService as any)._instance = undefined;
      const freshService = PortForwardService.getInstance();
      // No tree provider set

      // Should not throw
      await freshService.stopAllForwardsForConnection('conn1');
    });

    it('should do nothing if connection not found', async () => {
      mockGetConnection.mockReturnValue(undefined);
      mockGetForwardsForConnection.mockReturnValue([
        createMockPortForward({ localPort: 3000 }),
      ]);

      await service.stopAllForwardsForConnection('disconnected');

      expect(mockRemoveForward).not.toHaveBeenCalled();
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
