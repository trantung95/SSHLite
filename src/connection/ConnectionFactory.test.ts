import { createConnection } from './ConnectionFactory';
import { SSHConnection } from './SSHConnection';
import { FTPConnection } from './FTPConnection';
import { IHostConfig } from '../types';

jest.mock('../services/CredentialService', () => ({
  CredentialService: { getInstance: jest.fn().mockReturnValue({}) },
}));

function host(overrides: Partial<IHostConfig> = {}): IHostConfig {
  return {
    id: 'h:22:u',
    name: 'h',
    host: 'h',
    port: 22,
    username: 'u',
    source: 'saved',
    ...overrides,
  };
}

describe('ConnectionFactory.createConnection', () => {
  it('returns an SSHConnection when connectionType is absent (backward compat)', () => {
    expect(createConnection(host())).toBeInstanceOf(SSHConnection);
  });

  it("returns an SSHConnection when connectionType is 'ssh'", () => {
    expect(createConnection(host({ connectionType: 'ssh' }))).toBeInstanceOf(SSHConnection);
  });

  it("returns an FTPConnection when connectionType is 'ftp'", () => {
    expect(createConnection(host({ connectionType: 'ftp', port: 21 }))).toBeInstanceOf(FTPConnection);
  });

  it('reports the correct protocol capabilities for each type', () => {
    expect(createConnection(host()).capabilities.type).toBe('ssh');
    expect(createConnection(host()).capabilities.supportsExec).toBe(true);
    const ftp = createConnection(host({ connectionType: 'ftp' }));
    expect(ftp.capabilities.type).toBe('ftp');
    expect(ftp.capabilities.supportsExec).toBe(false);
    expect(ftp.capabilities.supportsServerBackup).toBe(false);
    expect(ftp.capabilities.supportsNativeWatch).toBe(false);
  });
});
