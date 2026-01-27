/**
 * Shared helpers for multi-OS extension logic integration tests.
 * Provides OS server configurations, SSHConnection factory, and cleanup utilities.
 */
import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { IHostConfig, ConnectionState } from '../types';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { SavedCredential, CredentialService } from '../services/CredentialService';

// ---- OS Server Configurations ----

export interface OSServerConfig {
  os: string;
  host: string;
  port: number;
  username: string;
  password: string;
  hostname: string;
  shell: 'bash' | 'ash';
}

export const CI_SERVERS: OSServerConfig[] = [
  { os: 'Alpine 3.19', host: '127.0.0.1', port: 2230, username: 'testuser', password: 'testpass', hostname: 'ci-alpine', shell: 'ash' },
  { os: 'Ubuntu 22.04', host: '127.0.0.1', port: 2231, username: 'testuser', password: 'testpass', hostname: 'ci-ubuntu', shell: 'bash' },
  { os: 'Debian 12', host: '127.0.0.1', port: 2232, username: 'testuser', password: 'testpass', hostname: 'ci-debian', shell: 'bash' },
  { os: 'Fedora 40', host: '127.0.0.1', port: 2233, username: 'testuser', password: 'testpass', hostname: 'ci-fedora', shell: 'bash' },
  { os: 'Rocky Linux 9', host: '127.0.0.1', port: 2234, username: 'testuser', password: 'testpass', hostname: 'ci-rocky', shell: 'bash' },
];

export const ADMIN_CONFIG = { username: 'admin', password: 'adminpass' };

// ---- Test Key Paths ----

const TEST_KEYS_DIR = path.resolve(__dirname, '../../test-docker/test-keys');

export function getTestKeyPath(keyType: 'rsa' | 'ed25519' | 'rsa-encrypted'): string {
  const keyMap: Record<string, string> = {
    'rsa': 'id_rsa_test',
    'ed25519': 'id_ed25519_test',
    'rsa-encrypted': 'id_rsa_encrypted',
  };
  return path.join(TEST_KEYS_DIR, keyMap[keyType]);
}

export function testKeysExist(): boolean {
  return fs.existsSync(path.join(TEST_KEYS_DIR, 'id_rsa_test'));
}

// ---- Known Hosts Mock ----

const knownHostsStore: Record<string, unknown> = {};

function getMockGlobalState(): vscode.Memento {
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      return (knownHostsStore[key] as T) ?? (defaultValue as T);
    },
    update: async (key: string, value: unknown) => {
      knownHostsStore[key] = value;
    },
    keys: () => Object.keys(knownHostsStore),
  } as vscode.Memento;
}

// ---- CredentialService Mock Setup ----

/**
 * Setup CredentialService mock to return passwords and passphrases.
 * Must be called before creating SSHConnection instances.
 */
export function setupCredentialServiceMock(): void {
  // Reset the singleton so our mock takes effect
  (CredentialService as any)._instance = undefined;

  const mockInstance = {
    getCredentialSecret: jest.fn().mockImplementation(
      (_hostId: string, credId: string) => {
        // Return appropriate secret based on credential ID
        if (credId === 'test-password') return Promise.resolve('testpass');
        if (credId === 'admin-password') return Promise.resolve('adminpass');
        if (credId === 'rsa-passphrase') return Promise.resolve('testphrase');
        if (credId === 'wrong-password') return Promise.resolve('wrongpass');
        return Promise.resolve(null);
      }
    ),
    getOrPrompt: jest.fn().mockImplementation(
      (hostId: string, _type: string, _prompt: string) => {
        // Return wrong password for wrong-password test connections
        if (hostId.includes('wrongpass')) return Promise.resolve('wrongpass');
        return Promise.resolve('testpass');
      }
    ),
    deleteAll: jest.fn(),
    listCredentials: jest.fn().mockReturnValue([]),
    updateCredentialPassword: jest.fn().mockResolvedValue(undefined),
    setSessionCredential: jest.fn(),
    initialize: jest.fn(),
  };

  (CredentialService as any)._instance = mockInstance;
}

// ---- Vscode Mock Setup ----

/**
 * Setup vscode mocks needed for SSHConnection to work.
 * Auto-accepts host keys, provides default config values.
 */
export function setupVscodeMocks(): void {
  // Setup globalState for known hosts storage
  setGlobalState(getMockGlobalState());

  // Auto-accept host keys
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');

  // Auto-accept password save prompt
  (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('No, use only for this session');
}

// ---- SSHConnection Factory ----

export type AuthType = 'password' | 'rsa' | 'ed25519' | 'rsa-encrypted';

/**
 * Create a real SSHConnection that connects to a Docker container.
 * Handles all mocking needed for host key verification and credentials.
 */
export async function createTestConnection(
  server: OSServerConfig,
  authType: AuthType = 'password',
  options?: { username?: string; password?: string }
): Promise<SSHConnection> {
  const username = options?.username || server.username;
  const password = options?.password || server.password;

  const hostConfig: IHostConfig = {
    id: `ci-${server.hostname}-${username}`,
    name: `CI ${server.os}`,
    host: server.host,
    port: server.port,
    username,
    source: 'saved',
  };

  let credential: SavedCredential | undefined;

  switch (authType) {
    case 'password':
      credential = {
        id: username === 'admin' ? 'admin-password' : 'test-password',
        label: `${username} Password`,
        type: 'password',
      };
      break;
    case 'rsa':
      credential = {
        id: 'rsa-key',
        label: 'RSA Key',
        type: 'privateKey',
        privateKeyPath: getTestKeyPath('rsa'),
      };
      break;
    case 'ed25519':
      credential = {
        id: 'ed25519-key',
        label: 'Ed25519 Key',
        type: 'privateKey',
        privateKeyPath: getTestKeyPath('ed25519'),
      };
      break;
    case 'rsa-encrypted':
      credential = {
        id: 'rsa-passphrase',
        label: 'Encrypted RSA Key',
        type: 'privateKey',
        privateKeyPath: getTestKeyPath('rsa-encrypted'),
      };
      break;
  }

  const conn = new SSHConnection(hostConfig, credential);
  await conn.connect();

  // Wait briefly for capability detection to run in background
  await new Promise(resolve => setTimeout(resolve, 1000));

  return conn;
}

/**
 * Disconnect and clean up a connection, ignoring errors.
 */
export async function safeDisconnect(conn: SSHConnection | null): Promise<void> {
  if (!conn) return;
  try {
    await conn.disconnect();
  } catch {
    // Ignore disconnect errors in cleanup
  }
}

/**
 * Disconnect all connections in array, ignoring errors.
 */
export async function disconnectAll(connections: (SSHConnection | null)[]): Promise<void> {
  await Promise.allSettled(connections.map(c => safeDisconnect(c)));
}

/**
 * Wait for a connection to reach a specific state.
 * SSHConnection.disconnect() triggers state change asynchronously
 * via the ssh2 'close' event, so we need to wait for it.
 */
export async function waitForState(
  conn: SSHConnection,
  targetState: ConnectionState,
  timeoutMs = 5000,
): Promise<void> {
  if (conn.state === targetState) return;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      reject(new Error(`Timed out waiting for state ${targetState}, current: ${conn.state}`));
    }, timeoutMs);
    const disposable = conn.onStateChange((state: ConnectionState) => {
      if (state === targetState) {
        clearTimeout(timer);
        disposable.dispose();
        resolve();
      }
    });
  });
}

/**
 * Create a connection that will fail due to wrong password.
 * Both password auth and keyboard-interactive fallback will use 'wrongpass'.
 */
export function createWrongPasswordConnection(
  server: OSServerConfig,
): Promise<SSHConnection> {
  const hostConfig: IHostConfig = {
    id: `ci-${server.hostname}-wrongpass`,
    name: `CI ${server.os}`,
    host: server.host,
    port: server.port,
    username: server.username,
    source: 'saved',
  };

  const credential: SavedCredential = {
    id: 'wrong-password',
    label: 'Wrong Password',
    type: 'password',
  };

  const conn = new SSHConnection(hostConfig, credential);
  return conn.connect().then(() => conn);
}
