/**
 * SSHConnection diagnostic-log tests (v0.7.3).
 *
 * Validates that:
 *  - connect() emits begin + auth-methods immediately (before ssh2 even fires events)
 *  - host config validation emits ssh-connect logs on rejection
 *  - error events propagate through the SSH2 client mock and emit ssh-connect/error
 *  - disconnect/dispose/handleDisconnect emit lifecycle logs
 *  - getSFTP emits sftp/* events
 */

import { ConnectionState } from '../types';
import { createMockHostConfig, setupLogCapture } from '../__mocks__/testHelpers';

// Capture event handlers registered on the ssh2 Client so tests can fire them.
type EvtMap = Record<string, ((arg?: unknown) => void)[]>;
let capturedClientHandlers: EvtMap = {};
let lastConnectArgs: unknown = null;

jest.mock('ssh2', () => ({
  Client: jest.fn().mockImplementation(() => {
    const handlers: EvtMap = {};
    capturedClientHandlers = handlers;
    return {
      on: jest.fn().mockImplementation((evt: string, h: (arg?: unknown) => void) => {
        (handlers[evt] = handlers[evt] || []).push(h);
        return this;
      }),
      connect: jest.fn().mockImplementation((args: unknown) => { lastConnectArgs = args; }),
      end: jest.fn(),
      destroy: jest.fn(),
      sftp: jest.fn(),
    };
  }),
}));

jest.mock('../services/CredentialService', () => ({
  CredentialService: {
    getInstance: jest.fn().mockReturnValue({
      getCredentialPassword: jest.fn().mockResolvedValue(undefined),
      // Return a password so buildAuthConfig() always has at least one auth
      // method. Otherwise — on a machine with no default ~/.ssh/id_* keys and
      // no SSH_AUTH_SOCK (fs is NOT mocked here) — it throws "No authentication
      // method available" before reaching auth-methods / handler registration,
      // making these tests pass or fail by accident of the host's ~/.ssh.
      getOrPrompt: jest.fn().mockResolvedValue('test-password'),
      getCredentialSecret: jest.fn().mockResolvedValue(undefined),
      listCredentials: jest.fn().mockReturnValue([]),
      deleteAll: jest.fn(),
    }),
  },
}));

import { SSHConnection } from './SSHConnection';

beforeEach(() => {
  capturedClientHandlers = {};
  lastConnectArgs = null;
});

/**
 * Flush microtasks until `cond` is true (or maxTicks reached). connect() awaits
 * buildAuthConfig() before it logs `auth-methods` and registers the error/close
 * handlers, and how many microtask ticks that takes depends on the credential
 * path. Poll for the observable effect rather than assuming a fixed tick count
 * (the old `await Promise.resolve()` ×2 was brittle and broke when the auth
 * path gained an await).
 */
async function flushUntil(cond: () => boolean, maxTicks = 100): Promise<void> {
  for (let i = 0; i < maxTicks && !cond(); i++) {
    await Promise.resolve();
  }
}

describe('SSHConnection.connect — begin + auth-methods', () => {
  it('emits connect/begin immediately with full host config (always-on)', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const conn = new SSHConnection(createMockHostConfig({
      host: '10.0.0.1', port: 2222, username: 'admin', name: 'cLAB-1', source: 'saved',
    }));
    // Don't await — connect() will hang waiting for ssh2 'ready' which we never fire.
    // We only need the synchronous logs.
    void conn.connect().catch(() => { /* ignored */ });
    // Yield once so buildAuthConfig() has a chance to run
    await Promise.resolve();
    await Promise.resolve();
    const begin = cap.find('INFO', 'ssh-connect', 'begin');
    expect(begin).toHaveLength(1);
    expect(begin[0].data.host).toBe('10.0.0.1');
    expect(begin[0].data.port).toBe('2222');
    expect(begin[0].data.username).toBe('admin');
    expect(begin[0].data.hostName).toBe('cLAB-1');
    expect(begin[0].data.source).toBe('saved');
    expect(begin[0].data.readyTimeoutMs).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any)._client = null;
    conn.dispose();
  });

  it('emits auth-methods listing the advertised SSH auth methods', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const conn = new SSHConnection(createMockHostConfig());
    void conn.connect().catch(() => { /* ignored */ });
    await flushUntil(() => cap.find('INFO', 'ssh-connect', 'auth-methods').length > 0);
    const auth = cap.find('INFO', 'ssh-connect', 'auth-methods');
    expect(auth).toHaveLength(1);
    // tryKeyboard is always added in the no-credential path
    expect(auth[0].data.tryKeyboard).toBe('true');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any)._client = null;
    conn.dispose();
  });
});

describe('SSHConnection.connect — error / close events', () => {
  it('emits ssh-connect/error with errorMessage when ssh2 fires an error', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const conn = new SSHConnection(createMockHostConfig());
    const p = conn.connect().catch(() => { /* expected */ });
    await flushUntil(() => !!capturedClientHandlers['error']?.length);
    // Fire an authentication-style error so the connect promise rejects
    capturedClientHandlers['error']?.[0]?.(Object.assign(new Error('Permission denied'), { level: 'client-authentication', code: 'AUTH_ERR' }));
    await p;
    const err = cap.find('INFO', 'ssh-connect', 'error');
    expect(err).toHaveLength(1);
    expect(err[0].data.errorMessage).toBe('Permission denied');
    expect(err[0].data.level).toBe('client-authentication');
    expect(err[0].data.code).toBe('AUTH_ERR');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any)._client = null;
    conn.dispose();
  });

  it('emits close (always-on) when ssh2 fires close after ready', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const conn = new SSHConnection(createMockHostConfig());
    void conn.connect().catch(() => { /* ignored */ });
    await flushUntil(() => !!capturedClientHandlers['close']?.length);
    cap.reset();
    capturedClientHandlers['close']?.[0]?.();
    expect(cap.find('INFO', 'ssh-connect', 'close')).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any)._client = null;
    conn.dispose();
  });
});

describe('SSHConnection.disconnect / dispose — logs', () => {
  it('emits disconnect/begin with state snapshot', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const conn = new SSHConnection(createMockHostConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any)._client = null; // skip real client.end()
    await conn.disconnect();
    const found = cap.find('INFO', 'ssh-connect', 'disconnect/begin');
    expect(found).toHaveLength(1);
    expect(found[0].data.hasSftp).toBe('false');
    expect(found[0].data.portForwardCount).toBe('0');
    expect(found[0].data.currentState).toBe('disconnected');
  });

  it('emits dispose (always-on)', () => {
    const cap = setupLogCapture({ enableDiag: false });
    const conn = new SSHConnection(createMockHostConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any)._client = null;
    conn.dispose();
    expect(cap.find('INFO', 'ssh-connect', 'dispose')).toHaveLength(1);
  });

  it('emits handleDisconnect with watcher/forward counts when state already at Connected', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const conn = new SSHConnection(createMockHostConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).state = ConnectionState.Connected;
    cap.reset();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any).handleDisconnect();
    const found = cap.find('INFO', 'ssh-connect', 'handleDisconnect');
    expect(found).toHaveLength(1);
    expect(found[0].data.previousState).toBe('connected');
  });
});

describe('SSHConnection.getSFTP — logs', () => {
  it('emits sftp/not-connected (always-on) when called while disconnected', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    const conn = new SSHConnection(createMockHostConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((conn as any).getSFTP()).rejects.toThrow('Not connected');
    const found = cap.find('INFO', 'ssh-connect', 'sftp/not-connected');
    expect(found).toHaveLength(1);
    expect(found[0].data.hasClient).toBe('false');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (conn as any)._client = null;
    conn.dispose();
  });
});
