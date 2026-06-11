/**
 * ConnectionPortabilityService tests (issue #11 — Import / Export / Sync).
 *
 * This service is the single source of truth for the connections-export JSON
 * format: it builds the payload (hosts + non-secret credential metadata +
 * pinned folders), validates an imported payload, and applies it (merge vs
 * replace). No secret value (password/passphrase) may ever appear in the
 * exported payload.
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
import { CredentialService } from './CredentialService';
import { ConnectionPortabilityService } from './ConnectionPortabilityService';

function resetSingletons(): ConnectionPortabilityService {
  (HostService as any)._instance = undefined;
  (CredentialService as any)._instance = undefined;
  (ConnectionPortabilityService as any)._instance = undefined;
  return ConnectionPortabilityService.getInstance();
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

describe('ConnectionPortabilityService', () => {
  let service: ConnectionPortabilityService;

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockConfig();
    enableConfigPersistence();
    service = resetSingletons();
  });

  afterEach(() => clearMockConfig());

  describe('buildExportPayload', () => {
    it('produces a versioned envelope with saved hosts and credential metadata', () => {
      setMockConfig('sshLite.hosts', [
        { name: 'Prod', host: '10.0.0.1', port: 22, username: 'admin', privateKeyPath: '~/.ssh/id_rsa', tabLabel: 'PRD' },
      ]);
      setMockConfig('sshLite.credentialIndex', {
        '10.0.0.1:22:admin': [
          { id: 'c1', label: 'Default', type: 'password', pinnedFolders: [{ id: 'p1', name: 'app', remotePath: '/srv/app' }] },
        ],
      });

      const payload = service.buildExportPayload({ extensionVersion: '0.10.0', exportedAt: '2026-06-10T00:00:00.000Z' });

      expect(payload.schema).toBe('sshlite-connections');
      expect(payload.version).toBe(1);
      expect(payload.exportedAt).toBe('2026-06-10T00:00:00.000Z');
      expect(payload.extensionVersion).toBe('0.10.0');
      expect(payload.hosts).toEqual([
        { name: 'Prod', host: '10.0.0.1', port: 22, username: 'admin', privateKeyPath: '~/.ssh/id_rsa', tabLabel: 'PRD' },
      ]);
      expect(payload.credentials['10.0.0.1:22:admin'][0].pinnedFolders?.[0].remotePath).toBe('/srv/app');
    });

    it('preserves the unexpanded ~ key path (portable across machines)', () => {
      setMockConfig('sshLite.hosts', [
        { name: 'H', host: '1.1.1.1', port: 22, username: 'u', privateKeyPath: '~/.ssh/id_ed25519' },
      ]);

      const payload = service.buildExportPayload({ extensionVersion: '0.10.0', exportedAt: 'T' });
      expect(payload.hosts[0].privateKeyPath).toBe('~/.ssh/id_ed25519');
    });

    it('whitelists credential fields and strips any planted secret value', () => {
      setMockConfig('sshLite.hosts', [{ name: 'H', host: '1.1.1.1', port: 22, username: 'u' }]);
      // A malformed index that smuggles a secret value alongside the metadata.
      setMockConfig('sshLite.credentialIndex', {
        '1.1.1.1:22:u': [
          { id: 'c1', label: 'Default', type: 'password', value: 'SUPERSECRET', password: 'p@ss' } as any,
        ],
      });

      const payload = service.buildExportPayload({ extensionVersion: '0.10.0', exportedAt: 'T' });

      // The smuggled secret value must not survive serialization anywhere.
      expect(JSON.stringify(payload)).not.toContain('SUPERSECRET');
      expect(JSON.stringify(payload)).not.toContain('p@ss');
      // Only whitelisted keys remain on the credential object.
      const cred = payload.credentials['1.1.1.1:22:u'][0] as unknown as Record<string, unknown>;
      expect(Object.keys(cred).sort()).toEqual(['id', 'label', 'type']);
    });

    it('returns empty hosts/credentials when nothing is configured', () => {
      const payload = service.buildExportPayload({ extensionVersion: '0.10.0', exportedAt: 'T' });
      expect(payload.hosts).toEqual([]);
      expect(payload.credentials).toEqual({});
    });
  });

  describe('parseAndValidate', () => {
    const valid = JSON.stringify({
      schema: 'sshlite-connections',
      version: 1,
      exportedAt: 'T',
      extensionVersion: '0.10.0',
      hosts: [{ name: 'H', host: '1.1.1.1', port: 22, username: 'u' }],
      credentials: {},
    });

    it('accepts a well-formed payload', () => {
      const payload = service.parseAndValidate(valid);
      expect(payload.hosts).toHaveLength(1);
    });

    it('throws on non-JSON input', () => {
      expect(() => service.parseAndValidate('not json {')).toThrow();
    });

    it('throws when the schema marker is wrong', () => {
      const bad = JSON.stringify({ schema: 'something-else', version: 1, hosts: [] });
      expect(() => service.parseAndValidate(bad)).toThrow(/not.*ssh.*lite|schema|format/i);
    });

    it('throws on an unsupported (newer) version', () => {
      const bad = JSON.stringify({ schema: 'sshlite-connections', version: 99, hosts: [] });
      expect(() => service.parseAndValidate(bad)).toThrow(/version/i);
    });

    it('throws when hosts is not an array', () => {
      const bad = JSON.stringify({ schema: 'sshlite-connections', version: 1, hosts: 'nope' });
      expect(() => service.parseAndValidate(bad)).toThrow(/hosts/i);
    });

    it('tolerates a missing credentials map (defaults to {})', () => {
      const noCreds = JSON.stringify({ schema: 'sshlite-connections', version: 1, hosts: [] });
      const payload = service.parseAndValidate(noCreds);
      expect(payload.credentials).toEqual({});
    });
  });

  describe('applyImport (round-trip)', () => {
    it('replace: imported hosts + credentials fully replace existing data', async () => {
      setMockConfig('sshLite.hosts', [{ name: 'Old', host: '9.9.9.9', port: 22, username: 'root' }]);

      const payload = service.parseAndValidate(
        JSON.stringify({
          schema: 'sshlite-connections',
          version: 1,
          hosts: [{ name: 'New', host: '2.2.2.2', port: 22, username: 'me' }],
          credentials: { '2.2.2.2:22:me': [{ id: 'c1', label: 'Default', type: 'password' }] },
        })
      );

      const result = await service.applyImport(payload, 'replace');

      const hosts = HostService.getInstance().getAllHosts();
      expect(hosts.map((h) => h.host)).toEqual(['2.2.2.2']);
      expect(CredentialService.getInstance().listCredentials('2.2.2.2:22:me')).toHaveLength(1);
      expect(result.hosts).toEqual({ added: 1, updated: 0 });
    });

    it('merge: imported data is added alongside existing connections', async () => {
      setMockConfig('sshLite.hosts', [{ name: 'Keep', host: '8.8.8.8', port: 22, username: 'me' }]);

      const payload = service.parseAndValidate(
        JSON.stringify({
          schema: 'sshlite-connections',
          version: 1,
          hosts: [{ name: 'Add', host: '2.2.2.2', port: 22, username: 'me' }],
          credentials: {},
        })
      );

      await service.applyImport(payload, 'merge');

      const hosts = HostService.getInstance().getAllHosts();
      expect(hosts.map((h) => h.host).sort()).toEqual(['2.2.2.2', '8.8.8.8']);
    });
  });
});
