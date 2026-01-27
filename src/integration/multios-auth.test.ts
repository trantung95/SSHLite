/**
 * Multi-OS Authentication Integration Tests
 *
 * Tests all authentication methods (password, RSA key, Ed25519 key,
 * encrypted key, keyboard-interactive) against 5 Docker server OS.
 */
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { ConnectionState, AuthenticationError } from '../types';
import * as vscode from 'vscode';
import {
  CI_SERVERS,
  OSServerConfig,
  createTestConnection,
  createWrongPasswordConnection,
  safeDisconnect,
  setupCredentialServiceMock,
  setupVscodeMocks,
  testKeysExist,
  getTestKeyPath,
  ADMIN_CONFIG,
} from './multios-helpers';

// Setup mocks before all tests
beforeAll(() => {
  setupCredentialServiceMock();
  setupVscodeMocks();
});

// ---- Per-OS Authentication Tests ----
describe.each(CI_SERVERS)('Authentication on $os', (server: OSServerConfig) => {
  // -- Password Auth --
  describe('password auth', () => {
    it('should connect with password credential', async () => {
      const conn = await createTestConnection(server, 'password');
      try {
        expect(conn.state).toBe(ConnectionState.Connected);
        const result = await conn.exec('whoami');
        expect(result.trim()).toBe('testuser');
      } finally {
        await safeDisconnect(conn);
      }
    });

    it('should reject wrong password', async () => {
      await expect(
        createWrongPasswordConnection(server)
      ).rejects.toThrow();
    }, 30000);

    it('should connect admin user with password', async () => {
      const conn = await createTestConnection(server, 'password', {
        username: ADMIN_CONFIG.username,
        password: ADMIN_CONFIG.password,
      });
      try {
        expect(conn.state).toBe(ConnectionState.Connected);
        const result = await conn.exec('whoami');
        expect(result.trim()).toBe('admin');
      } finally {
        await safeDisconnect(conn);
      }
    });
  });

  // -- RSA Key Auth --
  describe('RSA key auth', () => {
    const shouldRun = testKeysExist();

    (shouldRun ? it : it.skip)('should connect with RSA private key', async () => {
      const conn = await createTestConnection(server, 'rsa');
      try {
        expect(conn.state).toBe(ConnectionState.Connected);
        const result = await conn.exec('whoami');
        expect(result.trim()).toBe('testuser');
      } finally {
        await safeDisconnect(conn);
      }
    });
  });

  // -- Ed25519 Key Auth --
  describe('Ed25519 key auth', () => {
    const shouldRun = testKeysExist();

    (shouldRun ? it : it.skip)('should connect with Ed25519 key', async () => {
      const conn = await createTestConnection(server, 'ed25519');
      try {
        expect(conn.state).toBe(ConnectionState.Connected);
        const result = await conn.exec('whoami');
        expect(result.trim()).toBe('testuser');
      } finally {
        await safeDisconnect(conn);
      }
    });
  });

  // -- Encrypted Key Auth --
  describe('encrypted key auth', () => {
    const shouldRun = testKeysExist();

    (shouldRun ? it : it.skip)('should connect with encrypted RSA key + passphrase', async () => {
      const conn = await createTestConnection(server, 'rsa-encrypted');
      try {
        expect(conn.state).toBe(ConnectionState.Connected);
        const result = await conn.exec('whoami');
        expect(result.trim()).toBe('testuser');
      } finally {
        await safeDisconnect(conn);
      }
    });
  });

  // -- Host Key Verification --
  describe('host key verification', () => {
    it('should auto-accept new host key and connect', async () => {
      // The mock auto-accepts via showInformationMessage -> 'Yes, Connect'
      const conn = await createTestConnection(server);
      try {
        expect(conn.state).toBe(ConnectionState.Connected);
      } finally {
        await safeDisconnect(conn);
      }
    });

    it('should recognize known host on second connection', async () => {
      // First connection saves the host key
      const conn1 = await createTestConnection(server);
      await safeDisconnect(conn1);

      // Second connection should recognize it
      const conn2 = await createTestConnection(server);
      try {
        expect(conn2.state).toBe(ConnectionState.Connected);
      } finally {
        await safeDisconnect(conn2);
      }
    });
  });
});

// ---- Cross-OS Auth Tests ----
describe('Cross-OS authentication', () => {
  it('should connect to all 5 OS with password auth simultaneously', async () => {
    const connections = await Promise.all(
      CI_SERVERS.map(server => createTestConnection(server, 'password'))
    );
    try {
      for (const conn of connections) {
        expect(conn.state).toBe(ConnectionState.Connected);
      }
    } finally {
      await Promise.allSettled(connections.map(c => safeDisconnect(c)));
    }
  });

  (testKeysExist() ? it : it.skip)('should connect to all 5 OS with RSA key simultaneously', async () => {
    const connections = await Promise.all(
      CI_SERVERS.map(server => createTestConnection(server, 'rsa'))
    );
    try {
      for (const conn of connections) {
        expect(conn.state).toBe(ConnectionState.Connected);
      }
    } finally {
      await Promise.allSettled(connections.map(c => safeDisconnect(c)));
    }
  });

  it('should connect admin to all 5 OS simultaneously', async () => {
    const connections = await Promise.all(
      CI_SERVERS.map(server =>
        createTestConnection(server, 'password', {
          username: ADMIN_CONFIG.username,
          password: ADMIN_CONFIG.password,
        })
      )
    );
    try {
      const results = await Promise.all(
        connections.map(c => c.exec('whoami'))
      );
      for (const result of results) {
        expect(result.trim()).toBe('admin');
      }
    } finally {
      await Promise.allSettled(connections.map(c => safeDisconnect(c)));
    }
  });
});
