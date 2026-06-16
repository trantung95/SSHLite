/**
 * SSHConnection.buildAuthConfig — auth-method assembly (legacy path).
 *
 * Regression coverage for the UX bug where the plain `sshLite.connect` flow
 * (which reaches buildAuthConfig WITHOUT a SavedCredential) still prompted for
 * a login password even though the host already had a private key configured.
 *
 * Rule under test: only PROMPT for a password when there is no other auth
 * method (no private key, no SSH agent). When a key/agent IS present, a saved
 * password may be attached silently as a fallback, but the user is never asked.
 */

import { createMockHostConfig } from '../__mocks__/testHelpers';

// Mock ssh2 Client to prevent real SSH connections
jest.mock('ssh2', () => ({
  Client: jest.fn().mockImplementation(() => ({
    on: jest.fn().mockReturnThis(),
    connect: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
  })),
}));

// Mock fs so only the explicitly-configured key path "exists".
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
}));

// CredentialService mock. Use `var` (not const/let) so the @swc/jest factory
// can reference these; assign fresh spies per test in beforeEach.
var mockGet: jest.Mock;
var mockGetOrPrompt: jest.Mock;
var mockGetCredentialSecret: jest.Mock;
jest.mock('../services/CredentialService', () => ({
  CredentialService: {
    getInstance: jest.fn(() => ({
      get: mockGet,
      getOrPrompt: mockGetOrPrompt,
      getCredentialSecret: mockGetCredentialSecret,
      listCredentials: jest.fn().mockReturnValue([]),
    })),
  },
}));

// Control encryption detection without the real ssh2 parser (ssh2 is mocked
// above with only Client). Treat a key buffer/string containing "ENCRYPTED" as
// encrypted — matches the fixtures used in the passphrase test below.
jest.mock('./keyEncryption', () => ({
  isPrivateKeyEncrypted: (k: string | Buffer) => Buffer.from(k as Buffer).toString().includes('ENCRYPTED'),
}));

import * as fs from 'fs';
import { SSHConnection } from './SSHConnection';

const KEY_PATH = '/keys/id_test';
const UNENCRYPTED_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';

describe('SSHConnection.buildAuthConfig — password prompt only as last resort', () => {
  let savedAuthSock: string | undefined;

  beforeEach(() => {
    mockGet = jest.fn().mockResolvedValue(undefined);
    mockGetOrPrompt = jest.fn().mockResolvedValue(undefined);
    mockGetCredentialSecret = jest.fn().mockResolvedValue(undefined);

    (fs.existsSync as jest.Mock).mockReset();
    (fs.readFileSync as jest.Mock).mockReset();
    // Only the configured key path exists; default ~/.ssh/* locations do not.
    (fs.existsSync as jest.Mock).mockImplementation((p: string) => String(p).includes('id_test'));
    (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from(UNENCRYPTED_KEY));

    // Isolate from the host machine's SSH agent.
    savedAuthSock = process.env.SSH_AUTH_SOCK;
    delete process.env.SSH_AUTH_SOCK;
  });

  afterEach(() => {
    if (savedAuthSock === undefined) {
      delete process.env.SSH_AUTH_SOCK;
    } else {
      process.env.SSH_AUTH_SOCK = savedAuthSock;
    }
  });

  function buildAuth(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const host = createMockHostConfig({ host: '10.0.0.1', port: 22, username: 'testuser', ...overrides });
    const conn = new SSHConnection(host);
    return (conn as any).buildAuthConfig();
  }

  it('does NOT prompt for a password when a private key is configured', async () => {
    const auth = await buildAuth({ privateKeyPath: KEY_PATH });

    expect(auth.privateKey).toBeInstanceOf(Buffer);
    // The prompting path must never be taken for the login password.
    expect(mockGetOrPrompt).not.toHaveBeenCalledWith('10.0.0.1:22:testuser', 'password', expect.anything());
    expect(auth.password).toBeUndefined();
  });

  it('attaches a previously SAVED password silently (no prompt) when a key is present', async () => {
    mockGet.mockResolvedValue('saved-pw'); // creds.get returns a stored password

    const auth = await buildAuth({ privateKeyPath: KEY_PATH });

    expect(auth.privateKey).toBeInstanceOf(Buffer);
    expect(auth.password).toBe('saved-pw'); // fallback attached
    expect(mockGet).toHaveBeenCalledWith('10.0.0.1:22:testuser', 'password');
    expect(mockGetOrPrompt).not.toHaveBeenCalled(); // never prompted
  });

  it('does NOT prompt for a password when only an SSH agent is available', async () => {
    process.env.SSH_AUTH_SOCK = '/tmp/agent.sock';

    const auth = await buildAuth({ privateKeyPath: undefined });

    expect(auth.agent).toBe('/tmp/agent.sock');
    expect(auth.privateKey).toBeUndefined();
    expect(mockGetOrPrompt).not.toHaveBeenCalled();
  });

  it('DOES prompt for a password when there is no key and no agent', async () => {
    mockGetOrPrompt.mockResolvedValue('typed-pw');

    const auth = await buildAuth({ privateKeyPath: undefined });

    expect(auth.privateKey).toBeUndefined();
    expect(auth.agent).toBeUndefined();
    expect(mockGetOrPrompt).toHaveBeenCalledWith(
      '10.0.0.1:22:testuser',
      'password',
      expect.stringContaining('Password for testuser@10.0.0.1')
    );
    expect(auth.password).toBe('typed-pw');
  });

  it('still prompts for the PASSPHRASE of an encrypted key (unchanged behaviour)', async () => {
    (fs.readFileSync as jest.Mock).mockReturnValue(
      Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\nxyz\n-----END OPENSSH PRIVATE KEY-----')
    );
    mockGetOrPrompt.mockImplementation((_id: string, type: string) =>
      Promise.resolve(type === 'passphrase' ? 'secret-phrase' : undefined)
    );

    const auth = await buildAuth({ privateKeyPath: KEY_PATH });

    expect(auth.passphrase).toBe('secret-phrase');
    // Passphrase prompt is expected; a login-PASSWORD prompt is not.
    expect(mockGetOrPrompt).toHaveBeenCalledWith(
      '10.0.0.1:22:testuser',
      'passphrase',
      expect.stringContaining(KEY_PATH)
    );
    expect(mockGetOrPrompt).not.toHaveBeenCalledWith('10.0.0.1:22:testuser', 'password', expect.anything());
  });
});
