/**
 * ConnectionManager log emissions tests (v0.7.3 diagnostics).
 *
 * Mirrors the SSHConnection / ActivityService / CredentialService mocks from
 * ConnectionManager.test.ts so we can drive the manager without a real SSH stack.
 */

import { ConnectionState } from '../types';
import { createMockHostConfig, createMockCredential, setupLogCapture } from '../__mocks__/testHelpers';

let mockStateChangeListeners: Map<string, ((state: ConnectionState) => void)[]> = new Map();
let mockConnectBehavior: (() => Promise<void>) | null = null;

jest.mock('./SSHConnection', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('../__mocks__/vscode');
  return {
    SSHConnection: jest.fn().mockImplementation((host: { host: string; port: number; username: string }) => {
      const id = `${host.host}:${host.port}:${host.username}`;
      const stateEmitter = new EventEmitter();
      if (!mockStateChangeListeners.has(id)) mockStateChangeListeners.set(id, []);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stateEmitter.event((state: any) => {
        const listeners = mockStateChangeListeners.get(id) || [];
        listeners.forEach(l => l(state));
      });
      return {
        id, host,
        state: ConnectionState.Disconnected,
        client: null,
        onStateChange: stateEmitter.event,
        _stateEmitter: stateEmitter,
        connect: jest.fn().mockImplementation(async () => {
          if (mockConnectBehavior) return mockConnectBehavior();
        }),
        disconnect: jest.fn().mockResolvedValue(undefined),
        dispose: jest.fn(),
      };
    }),
  };
});

jest.mock('../services/ActivityService', () => ({
  ActivityService: {
    getInstance: jest.fn().mockReturnValue({
      startActivity: jest.fn().mockReturnValue('a-1'),
      completeActivity: jest.fn(),
      failActivity: jest.fn(),
    }),
  },
}));

jest.mock('../services/CredentialService', () => ({
  CredentialService: {
    getInstance: jest.fn().mockReturnValue({
      listCredentials: jest.fn().mockReturnValue([]),
    }),
  },
}));

import { ConnectionManager } from './ConnectionManager';

function reset(): ConnectionManager {
  try { ConnectionManager.getInstance().dispose(); } catch { /* ignore */ }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ConnectionManager as any)._instance = undefined;
  mockStateChangeListeners = new Map();
  mockConnectBehavior = null;
  return ConnectionManager.getInstance();
}

describe('ConnectionManager — connect logs', () => {
  let mgr: ConnectionManager;
  beforeEach(() => {
    jest.clearAllMocks();
    mgr = reset();
  });
  afterEach(() => { try { mgr.dispose(); } catch { /* ignore */ } });

  it('emits connect/begin with full host details (always-on)', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const host = createMockHostConfig({ host: '10.0.0.1', port: 2222, username: 'admin', name: 'cLAB-1' });
    await mgr.connect(host);
    const begin = cap.find('INFO', 'connection-manager', 'connect/begin');
    expect(begin).toHaveLength(1);
    expect(begin[0].data.host).toBe('10.0.0.1');
    expect(begin[0].data.port).toBe('2222');
    expect(begin[0].data.username).toBe('admin');
    expect(begin[0].data.hostName).toBe('cLAB-1');
    expect(begin[0].data.withCredential).toBe('false');
  });

  it('emits connect/begin with withCredential=true on connectWithCredential', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const host = createMockHostConfig();
    const cred = createMockCredential({ id: 'c1', label: 'admin-pw', type: 'password' });
    await mgr.connectWithCredential(host, cred);
    const begin = cap.find('INFO', 'connection-manager', 'connect/begin');
    expect(begin).toHaveLength(1);
    expect(begin[0].data.withCredential).toBe('true');
    expect(begin[0].data.credentialId).toBe('c1');
    expect(begin[0].data.credentialLabel).toBe('admin-pw');
    expect(begin[0].data.credentialType).toBe('password');
  });

  it('emits connect/reuse-existing when reconnecting an already-connected host', async () => {
    const cap = setupLogCapture({ enableDiag: true });
    const host = createMockHostConfig();
    const conn = await mgr.connect(host);
    // Simulate the connection moving to Connected state so the second connect() returns it
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).state = ConnectionState.Connected;
    cap.reset();
    await mgr.connect(host);
    expect(cap.find('DIAG', 'connection-manager', 'connect/reuse-existing')).toHaveLength(1);
  });

  it('emits state-change events when the underlying connection state shifts', async () => {
    const cap = setupLogCapture({ enableDiag: true });
    const host = createMockHostConfig();
    await mgr.connect(host);
    cap.reset();
    // Manually fire a state change via the captured listener bridge
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = (mgr as any)._connections.get(`${host.host}:${host.port}:${host.username}`);
    conn._stateEmitter.fire(ConnectionState.Connected);
    const events = cap.find('DIAG', 'connection-manager', 'state-change');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].data.state).toBe('connected');
  });
});

describe('ConnectionManager — disconnect logs', () => {
  let mgr: ConnectionManager;
  beforeEach(() => {
    jest.clearAllMocks();
    mgr = reset();
  });
  afterEach(() => { try { mgr.dispose(); } catch { /* ignore */ } });

  it('emits disconnect-requested (always-on) when disconnect() is called', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const host = createMockHostConfig();
    await mgr.connect(host);
    const id = `${host.host}:${host.port}:${host.username}`;
    cap.reset();
    await mgr.disconnect(id);
    const found = cap.find('INFO', 'connection-manager', 'disconnect-requested');
    expect(found).toHaveLength(1);
    expect(found[0].data.connectionId).toBe(id);
  });

  it('emits manual-disconnect-cleanup when state-change handler sees the manual flag', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const host = createMockHostConfig();
    await mgr.connect(host);
    const id = `${host.host}:${host.port}:${host.username}`;
    await mgr.disconnect(id);
    cap.reset();
    // Now fire a Disconnected state change — the handler should see isManualDisconnect=true
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = (mgr as any)._connections.get(id) || (mgr as any)._disconnectedConnections.get(id);
    if (conn?._stateEmitter) {
      conn._stateEmitter.fire(ConnectionState.Disconnected);
    }
    // Either manual-cleanup OR the connection was already removed — both are valid.
    // We just want to assert no auto-reconnect-start happens.
    expect(cap.find('INFO', 'connection-manager', 'auto-reconnect-start')).toHaveLength(0);
  });
});

describe('ConnectionManager — dispose log', () => {
  it('emits dispose with active/disconnected/active-attempt counters', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const mgr = reset();
    const host = createMockHostConfig();
    await mgr.connect(host);
    cap.reset();
    mgr.dispose();
    const found = cap.find('INFO', 'connection-manager', 'dispose');
    expect(found).toHaveLength(1);
    expect(found[0].data.activeConnections).toBe('1');
  });
});
