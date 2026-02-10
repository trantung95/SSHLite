/**
 * Shared test helpers and mock factories
 * Used across all test files for consistent mock objects
 */

import { IHostConfig, IRemoteFile, IPortForward, ConnectionState } from '../types';
import { SavedCredential, PinnedFolder } from '../services/CredentialService';

/**
 * Create a mock IHostConfig
 */
export function createMockHostConfig(overrides: Partial<IHostConfig> = {}): IHostConfig {
  return {
    id: 'test-host-1',
    name: 'Test Server',
    host: '192.168.1.100',
    port: 22,
    username: 'testuser',
    source: 'saved',
    ...overrides,
  };
}

/**
 * Create a mock IRemoteFile
 */
export function createMockRemoteFile(name: string, overrides: Partial<IRemoteFile> = {}): IRemoteFile {
  return {
    name,
    path: `/${name}`,
    isDirectory: false,
    size: 1024,
    modifiedTime: Date.now(),
    connectionId: 'test-connection',
    ...overrides,
  };
}

/**
 * Create a mock SavedCredential
 */
export function createMockCredential(overrides: Partial<SavedCredential> = {}): SavedCredential {
  return {
    id: `cred_${Date.now()}_test`,
    label: 'Default',
    type: 'password',
    ...overrides,
  };
}

/**
 * Create a mock PinnedFolder
 */
export function createMockPinnedFolder(overrides: Partial<PinnedFolder> = {}): PinnedFolder {
  return {
    id: `pin_${Date.now()}_test`,
    name: 'Projects',
    remotePath: '/home/user/projects',
    ...overrides,
  };
}

/**
 * Create a mock IPortForward
 */
export function createMockPortForward(overrides: Partial<IPortForward> = {}): IPortForward {
  return {
    id: 'fwd-1',
    connectionId: 'test-connection',
    localPort: 3000,
    remoteHost: 'localhost',
    remotePort: 3000,
    active: true,
    ...overrides,
  };
}

/**
 * Create a mock SSHConnection-like object with all methods mocked
 */
export function createMockConnection(overrides: Partial<{
  id: string;
  host: IHostConfig;
  state: ConnectionState;
}> = {}) {
  const host = overrides.host || createMockHostConfig();
  return {
    id: overrides.id || `${host.host}:${host.port}:${host.username}`,
    host,
    state: overrides.state || ConnectionState.Connected,
    client: null,
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    exec: jest.fn().mockResolvedValue(''),
    shell: jest.fn().mockResolvedValue({}),
    listFiles: jest.fn().mockResolvedValue([]),
    readFile: jest.fn().mockResolvedValue(Buffer.from('')),
    writeFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    stat: jest.fn().mockResolvedValue(createMockRemoteFile('test')),
    forwardPort: jest.fn().mockResolvedValue(undefined),
    stopForward: jest.fn().mockResolvedValue(undefined),
    searchFiles: jest.fn().mockResolvedValue([]),
    listDirectories: jest.fn().mockResolvedValue([]),
    listEntries: jest.fn().mockResolvedValue({ files: [], dirs: [] }),
    onStateChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    dispose: jest.fn(),
  };
}
