/**
 * HostService endpoint tests (Phase 1 of the connect-time-accounts change).
 *
 * An "endpoint" record is a saved host with isEndpoint:true and no username
 * (stored as ''). It must load (id `host:port:`), survive save dedup, and be
 * removable/renamable by id — without disturbing account records on the same
 * host:port. Malformed records (no username, not an endpoint) are still skipped.
 */

import { setMockConfig, clearMockConfig, workspace } from '../__mocks__/vscode';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue(''),
  statSync: jest.fn().mockReturnValue({ mtimeMs: 1000 }),
  writeFileSync: jest.fn(),
}));

jest.mock('ssh-config', () => ({
  parse: jest.fn().mockImplementation(() => ({
    [Symbol.iterator]: function* () {},
    compute: jest.fn().mockReturnValue({}),
    remove: jest.fn(),
    toString: jest.fn().mockReturnValue(''),
  })),
  DIRECTIVE: 1,
}));

import { HostService } from './HostService';

function resetHostService(): HostService {
  (HostService as any)._instance = undefined;
  return HostService.getInstance();
}

function enableConfigPersistence(): void {
  const origGetConfig = workspace.getConfiguration;
  (workspace as any).getConfiguration = (section?: string) => {
    const config = origGetConfig(section);
    config.update = jest.fn().mockImplementation((key: string, value: unknown) => {
      const fullKey = section ? `${section}.${key}` : key;
      setMockConfig(fullKey, value);
      return Promise.resolve();
    });
    return config;
  };
}

describe('HostService endpoints', () => {
  let service: HostService;

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockConfig();
    enableConfigPersistence();
    service = resetHostService();
  });

  afterEach(() => clearMockConfig());

  it('loads an endpoint record (no username) with id "host:port:"', () => {
    setMockConfig('sshLite.hosts', [
      { name: 'My Server', host: 'srv.com', port: 22, isEndpoint: true },
    ]);
    const hosts = service.getAllHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].isEndpoint).toBe(true);
    expect(hosts[0].username).toBe('');
    expect(hosts[0].id).toBe('srv.com:22:');
    expect(hosts[0].id).not.toContain('undefined');
  });

  it('still skips a malformed record (no username AND not an endpoint)', () => {
    setMockConfig('sshLite.hosts', [
      { name: 'Broken', host: 'bad.com', port: 22 },
      { name: 'Good', host: 'ok.com', port: 22, username: 'alice' },
    ]);
    const hosts = service.getAllHosts();
    expect(hosts.map((h) => h.host)).toEqual(['ok.com']);
  });

  it('removes an endpoint by id without touching an account on the same host:port', async () => {
    setMockConfig('sshLite.hosts', [
      { name: 'Endpoint', host: 'srv.com', port: 22, isEndpoint: true },
      { name: 'Account', host: 'srv.com', port: 22, username: 'alice' },
    ]);
    await service.removeHost('srv.com:22:');
    const hosts = service.getAllHosts();
    expect(hosts.map((h) => h.id)).toEqual(['srv.com:22:alice']);
  });

  it('renames an endpoint by id', async () => {
    setMockConfig('sshLite.hosts', [
      { name: 'Old', host: 'srv.com', port: 22, isEndpoint: true },
    ]);
    await service.renameHost('srv.com:22:', 'New');
    expect(service.getAllHosts()[0].name).toBe('New');
  });

  it('dedups two saves of the same endpoint instead of stacking', async () => {
    await service.saveHost({ name: 'A', host: 'srv.com', port: 22, username: '', isEndpoint: true });
    await service.saveHost({ name: 'A2', host: 'srv.com', port: 22, username: '', isEndpoint: true });
    const hosts = service.getAllHosts();
    expect(hosts).toHaveLength(1);
    expect(hosts[0].name).toBe('A2');
  });

  it('keeps endpoint and account as distinct records on the same host:port', async () => {
    await service.saveHost({ name: 'EP', host: 'srv.com', port: 22, username: '', isEndpoint: true });
    await service.saveHost({ name: 'Acct', host: 'srv.com', port: 22, username: 'alice' });
    const ids = service.getAllHosts().map((h) => h.id).sort();
    expect(ids).toEqual(['srv.com:22:', 'srv.com:22:alice']);
  });
});
