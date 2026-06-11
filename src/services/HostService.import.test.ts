/**
 * HostService.importSavedHosts tests (issue #11 — Import / Export connections).
 *
 * Verifies the merge vs replace reconciliation used when importing a
 * connections JSON file. Saved hosts live in the `sshLite.hosts` global
 * setting; import must upsert by the same host:port:username key that
 * saveHost()/removeHost() use, and never lose existing hosts on merge.
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

// Make config.update write back to the mock store so reads reflect writes.
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

function savedHostsRaw(): Array<Record<string, unknown>> {
  return workspace.getConfiguration('sshLite').get('hosts', []) as Array<Record<string, unknown>>;
}

describe('HostService.importSavedHosts', () => {
  let service: HostService;

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockConfig();
    enableConfigPersistence();
    service = resetHostService();
  });

  afterEach(() => clearMockConfig());

  const imported = [
    { name: 'Prod', host: '10.0.0.1', port: 22, username: 'admin', privateKeyPath: '~/.ssh/id_rsa', tabLabel: 'PRD' },
    { name: 'Dev', host: '10.0.0.2', port: 2222, username: 'deploy' },
  ];

  describe('replace mode', () => {
    it('overwrites the entire saved-hosts list with the imported set', async () => {
      setMockConfig('sshLite.hosts', [{ name: 'Old', host: '9.9.9.9', username: 'root' }]);

      const result = await service.importSavedHosts(imported, 'replace');

      const stored = savedHostsRaw();
      expect(stored).toHaveLength(2);
      expect(stored.map((h) => h.host)).toEqual(['10.0.0.1', '10.0.0.2']);
      expect(stored.find((h) => h.host === '9.9.9.9')).toBeUndefined();
      expect(result).toEqual({ added: 2, updated: 0 });
    });

    it('only persists whitelisted fields (no extra keys leak through)', async () => {
      const dirty = [{ name: 'X', host: '1.1.1.1', port: 22, username: 'u', secret: 'LEAK', source: 'saved' }];
      await service.importSavedHosts(dirty as any, 'replace');

      const stored = savedHostsRaw();
      expect(stored[0]).toEqual({ name: 'X', host: '1.1.1.1', port: 22, username: 'u' });
      expect((stored[0] as any).secret).toBeUndefined();
      expect((stored[0] as any).source).toBeUndefined();
    });
  });

  describe('merge mode', () => {
    it('keeps existing hosts and appends new ones', async () => {
      setMockConfig('sshLite.hosts', [{ name: 'Keep', host: '8.8.8.8', port: 22, username: 'me' }]);

      const result = await service.importSavedHosts(imported, 'merge');

      const stored = savedHostsRaw();
      expect(stored).toHaveLength(3);
      expect(stored.map((h) => h.host).sort()).toEqual(['10.0.0.1', '10.0.0.2', '8.8.8.8']);
      expect(result).toEqual({ added: 2, updated: 0 });
    });

    it('overwrites a matching host (same host:port:username) instead of duplicating', async () => {
      setMockConfig('sshLite.hosts', [
        { name: 'StaleName', host: '10.0.0.1', port: 22, username: 'admin' },
      ]);

      const result = await service.importSavedHosts(imported, 'merge');

      const stored = savedHostsRaw();
      expect(stored).toHaveLength(2); // updated 10.0.0.1 + added 10.0.0.2
      const prod = stored.find((h) => h.host === '10.0.0.1');
      expect(prod?.name).toBe('Prod');
      expect(prod?.tabLabel).toBe('PRD');
      expect(result).toEqual({ added: 1, updated: 1 });
    });

    it('treats missing port as 22 when matching', async () => {
      setMockConfig('sshLite.hosts', [{ name: 'NoPort', host: '10.0.0.1', username: 'admin' }]);

      await service.importSavedHosts([{ name: 'Prod', host: '10.0.0.1', port: 22, username: 'admin' }], 'merge');

      const stored = savedHostsRaw();
      expect(stored).toHaveLength(1);
      expect(stored[0].name).toBe('Prod');
    });
  });

  describe('validation', () => {
    it('skips entries missing required fields (name/host/username)', async () => {
      const result = await service.importSavedHosts(
        [
          { name: 'Good', host: '1.2.3.4', port: 22, username: 'u' },
          { name: '', host: '5.6.7.8', username: 'u' } as any,
          { name: 'NoHost', host: '', username: 'u' } as any,
        ],
        'replace'
      );

      expect(savedHostsRaw()).toHaveLength(1);
      expect(result).toEqual({ added: 1, updated: 0 });
    });
  });
});
