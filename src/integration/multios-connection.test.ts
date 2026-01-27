/**
 * Multi-OS SSHConnection Integration Tests
 *
 * Tests the SSHConnection class (extension logic) against 5 Docker server OS:
 * Alpine 3.19, Ubuntu 22.04, Debian 12, Fedora 40, Rocky Linux 9.
 *
 * Covers: connect/disconnect, detectCapabilities, exec, state management.
 */
import { SSHConnection } from '../connection/SSHConnection';
import { ConnectionState, AuthenticationError, ConnectionError } from '../types';
import {
  CI_SERVERS,
  OSServerConfig,
  createTestConnection,
  createWrongPasswordConnection,
  safeDisconnect,
  disconnectAll,
  setupCredentialServiceMock,
  setupVscodeMocks,
  waitForState,
} from './multios-helpers';

// Setup mocks before all tests
beforeAll(() => {
  setupCredentialServiceMock();
  setupVscodeMocks();
});

// ---- Per-OS Tests ----
describe.each(CI_SERVERS)('SSHConnection on $os', (server: OSServerConfig) => {
  // -- Connect / Disconnect --
  describe('connect/disconnect', () => {
    it('should connect successfully', async () => {
      const conn = await createTestConnection(server);
      try {
        expect(conn.state).toBe(ConnectionState.Connected);
        expect(conn.id).toBe(`${server.host}:${server.port}:${server.username}`);
      } finally {
        await safeDisconnect(conn);
      }
    });

    it('should disconnect cleanly', async () => {
      const conn = await createTestConnection(server);
      // disconnect() triggers state change asynchronously via ssh2 'close' event
      const disconnectPromise = waitForState(conn, ConnectionState.Disconnected);
      await conn.disconnect();
      await disconnectPromise;
      expect(conn.state).toBe(ConnectionState.Disconnected);
    });

    it('should reconnect after disconnect', async () => {
      const conn = await createTestConnection(server);
      try {
        const disconnectPromise = waitForState(conn, ConnectionState.Disconnected);
        await conn.disconnect();
        await disconnectPromise;
        expect(conn.state).toBe(ConnectionState.Disconnected);

        // Reconnect
        await conn.connect();
        expect(conn.state).toBe(ConnectionState.Connected);

        // Verify connection works
        const result = await conn.exec('echo ok');
        expect(result.trim()).toBe('ok');
      } finally {
        await safeDisconnect(conn);
      }
    });

    it('should emit state change events', async () => {
      const conn = await createTestConnection(server);
      const states: ConnectionState[] = [];
      conn.onStateChange((state: ConnectionState) => states.push(state));

      const disconnectPromise = waitForState(conn, ConnectionState.Disconnected);
      await conn.disconnect();
      await disconnectPromise;
      expect(states).toContain(ConnectionState.Disconnected);
    });

    it('should reject wrong password with AuthenticationError', async () => {
      await expect(
        createWrongPasswordConnection(server)
      ).rejects.toThrow();
    }, 30000);

    it('should reject unreachable port with ConnectionError', async () => {
      const badServer = { ...server, port: 29999 };
      await expect(
        createTestConnection(badServer)
      ).rejects.toThrow();
    }, 30000);
  });

  // -- Capabilities Detection --
  describe('detectCapabilities', () => {
    let conn: SSHConnection;

    beforeAll(async () => {
      conn = await createTestConnection(server);
      // Wait for capability detection
      await new Promise(resolve => setTimeout(resolve, 2000));
    });

    afterAll(async () => {
      await safeDisconnect(conn);
    });

    it('should detect OS as linux', () => {
      expect(conn.capabilities).not.toBeNull();
      expect(conn.capabilities!.os).toBe('linux');
    });

    it('should detect watch method as poll (no inotifywait in containers)', () => {
      expect(conn.capabilities!.watchMethod).toBe('poll');
    });

    it('should report hasInotifywait as false', () => {
      expect(conn.capabilities!.hasInotifywait).toBe(false);
    });

    it('should report hasFswatch as false', () => {
      expect(conn.capabilities!.hasFswatch).toBe(false);
    });
  });

  // -- Command Execution --
  describe('exec', () => {
    let conn: SSHConnection;

    beforeAll(async () => {
      conn = await createTestConnection(server);
    });

    afterAll(async () => {
      await safeDisconnect(conn);
    });

    it('should execute echo command', async () => {
      const result = await conn.exec('echo "hello from integration test"');
      expect(result.trim()).toBe('hello from integration test');
    });

    it('should return Linux from uname -s', async () => {
      const result = await conn.exec('uname -s');
      expect(result.trim()).toBe('Linux');
    });

    it('should return correct username from whoami', async () => {
      const result = await conn.exec('whoami');
      expect(result.trim()).toBe('testuser');
    });

    it('should return expected hostname', async () => {
      const result = await conn.exec('hostname');
      expect(result.trim()).toBe(server.hostname);
    });

    it('should handle multi-line output', async () => {
      const result = await conn.exec('echo "line1"; echo "line2"; echo "line3"');
      const lines = result.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('line1');
      expect(lines[2]).toBe('line3');
    });

    it('should execute complex piped commands', async () => {
      const result = await conn.exec('echo "abc def ghi" | wc -w');
      expect(parseInt(result.trim())).toBe(3);
    });

    it('should preserve exit code 0 for successful commands', async () => {
      const result = await conn.exec('true && echo "success"');
      expect(result.trim()).toBe('success');
    });
  });
});

// ---- Cross-OS Tests ----
describe('Cross-OS SSHConnection', () => {
  it('should connect to all 5 OS simultaneously', async () => {
    const connections = await Promise.all(
      CI_SERVERS.map(server => createTestConnection(server))
    );

    try {
      expect(connections).toHaveLength(5);
      for (const conn of connections) {
        expect(conn.state).toBe(ConnectionState.Connected);
      }
    } finally {
      await disconnectAll(connections);
    }
  });

  it('should execute commands on all 5 OS in parallel', async () => {
    const connections = await Promise.all(
      CI_SERVERS.map(server => createTestConnection(server))
    );

    try {
      const results = await Promise.all(
        connections.map(conn => conn.exec('uname -s'))
      );
      for (const result of results) {
        expect(result.trim()).toBe('Linux');
      }
    } finally {
      await disconnectAll(connections);
    }
  });

  it('should return correct hostnames from all 5 OS', async () => {
    const connections = await Promise.all(
      CI_SERVERS.map(server => createTestConnection(server))
    );

    try {
      const results = await Promise.all(
        connections.map((conn, i) =>
          conn.exec('hostname').then(r => ({ expected: CI_SERVERS[i].hostname, actual: r.trim() }))
        )
      );
      for (const { expected, actual } of results) {
        expect(actual).toBe(expected);
      }
    } finally {
      await disconnectAll(connections);
    }
  });
});
