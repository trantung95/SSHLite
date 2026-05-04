/**
 * PortForwardService log tests (v0.7.3 diagnostics)
 */

import { createMockConnection, createMockPortForward, setupLogCapture } from '../__mocks__/testHelpers';

// Same mock pattern as PortForwardService.test.ts to avoid temporal dead zone.
// eslint-disable-next-line no-var
var mockGetConnection = jest.fn();
// eslint-disable-next-line no-var
var mockGetAllConnections = jest.fn().mockReturnValue([]);
jest.mock('../connection/ConnectionManager', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
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

import { PortForwardService } from './PortForwardService';

// Mock tree provider stub
const stubTree = {
  addForward: jest.fn(),
  removeForward: jest.fn(),
  getForwardsForConnection: jest.fn().mockReturnValue([]),
  refresh: jest.fn(),
  getTreeItem: jest.fn(),
  getChildren: jest.fn(),
  onDidChangeTreeData: jest.fn(),
  dispose: jest.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function reset(): PortForwardService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (PortForwardService as any)._instance = undefined;
  const svc = PortForwardService.getInstance();
  svc.setTreeProvider(stubTree);
  return svc;
}

describe('PortForwardService — diagnostic logs', () => {
  let svc: PortForwardService;
  beforeEach(() => {
    jest.clearAllMocks();
    svc = reset();
  });

  it('emits create/begin and create/success on success (always-on)', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection({ id: 'host:22:user' }) as any;
    conn.forwardPort = jest.fn().mockResolvedValue(undefined);
    await svc.forwardPort(conn, 8080, 'localhost', 9090);
    const begin = cap.find('INFO', 'port-forward', 'create/begin');
    expect(begin).toHaveLength(1);
    expect(begin[0].data.connectionId).toBe('host:22:user');
    expect(begin[0].data.localPort).toBe('8080');
    expect(begin[0].data.remoteHost).toBe('localhost');
    expect(begin[0].data.remotePort).toBe('9090');
    const success = cap.find('INFO', 'port-forward', 'create/success');
    expect(success).toHaveLength(1);
    expect(success[0].data.localPort).toBe('8080');
  });

  it('emits create/failed (always-on) when underlying forward rejects', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn.forwardPort = jest.fn().mockRejectedValue(new Error('EADDRINUSE'));
    await svc.forwardPort(conn, 8080, 'localhost', 9090);
    const failed = cap.find('INFO', 'port-forward', 'create/failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data.errorMessage).toBe('EADDRINUSE');
    expect(cap.find('INFO', 'port-forward', 'create/success')).toHaveLength(0);
  });

  it('emits stop/begin and stop/success when stopForward succeeds', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection({ id: 'host:22:user' }) as any;
    conn.stopForward = jest.fn().mockResolvedValue(undefined);
    mockGetConnection.mockReturnValue(conn);
    const fwd = createMockPortForward({ connectionId: 'host:22:user', localPort: 8080 });
    await svc.stopForward(fwd);
    expect(cap.find('INFO', 'port-forward', 'stop/begin')).toHaveLength(1);
    expect(cap.find('INFO', 'port-forward', 'stop/success')).toHaveLength(1);
  });

  it('emits stop/failed (always-on) when stopForward rejects', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn.stopForward = jest.fn().mockRejectedValue(new Error('not listening'));
    mockGetConnection.mockReturnValue(conn);
    const fwd = createMockPortForward();
    await svc.stopForward(fwd);
    const failed = cap.find('INFO', 'port-forward', 'stop/failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data.errorMessage).toBe('not listening');
  });
});
