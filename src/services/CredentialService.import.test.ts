/**
 * CredentialService.importCredentialMetadata tests (issue #11).
 *
 * Import restores NON-SECRET credential metadata (label, type, key path) and
 * pinned folders into the `sshLite.credentialIndex` setting. It must NEVER
 * write to SecretStorage — passwords/passphrases stay out of the export file,
 * and a missing password simply prompts on the next connect.
 */

import {
  workspace,
  setMockConfig,
  clearMockConfig,
  resetAllMocks,
  createMockExtensionContext,
} from '../__mocks__/vscode';
import { CredentialService, SavedCredential } from './CredentialService';

function resetCredentialService(): CredentialService {
  (CredentialService as unknown as { _instance: CredentialService | undefined })._instance = undefined;
  return CredentialService.getInstance();
}

// Make config.update write back so listCredentials reflects the import.
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

describe('CredentialService.importCredentialMetadata', () => {
  let service: CredentialService;
  let mockContext: ReturnType<typeof createMockExtensionContext>;
  let storeSpy: jest.SpyInstance;

  beforeEach(() => {
    resetAllMocks();
    clearMockConfig();
    enableConfigPersistence();
    mockContext = createMockExtensionContext();
    service = resetCredentialService();
    service.initialize(mockContext as unknown as Parameters<typeof service.initialize>[0]);
    storeSpy = jest.spyOn(mockContext.secrets, 'store');
  });

  afterEach(() => clearMockConfig());

  const incoming: SavedCredential[] = [
    {
      id: 'cred_a',
      label: 'Default',
      type: 'password',
      pinnedFolders: [{ id: 'pin_a', name: 'app', remotePath: '/var/www/app' }],
    },
    { id: 'cred_b', label: 'Deploy Key', type: 'privateKey', privateKeyPath: '~/.ssh/deploy' },
  ];

  it('NEVER writes to SecretStorage', async () => {
    await service.importCredentialMetadata('h1:22:u', incoming, 'merge');
    expect(storeSpy).not.toHaveBeenCalled();
  });

  describe('replace mode', () => {
    it('overwrites all credentials for the host with the imported set', async () => {
      setMockConfig('sshLite.credentialIndex', {
        'h1:22:u': [{ id: 'old', label: 'Old', type: 'password' }],
      });

      await service.importCredentialMetadata('h1:22:u', incoming, 'replace');

      const creds = service.listCredentials('h1:22:u');
      expect(creds.map((c) => c.label)).toEqual(['Default', 'Deploy Key']);
      expect(creds.find((c) => c.label === 'Old')).toBeUndefined();
      expect(service.getPinnedFolders('h1:22:u', 'cred_a')).toEqual([
        { id: 'pin_a', name: 'app', remotePath: '/var/www/app' },
      ]);
    });

    it('leaves credentials for other hosts untouched', async () => {
      setMockConfig('sshLite.credentialIndex', {
        'other:22:u': [{ id: 'x', label: 'Keep', type: 'password' }],
      });

      await service.importCredentialMetadata('h1:22:u', incoming, 'replace');

      expect(service.listCredentials('other:22:u')).toHaveLength(1);
      expect(service.listCredentials('h1:22:u')).toHaveLength(2);
    });
  });

  describe('merge mode', () => {
    it('appends new credentials and keeps existing ones', async () => {
      setMockConfig('sshLite.credentialIndex', {
        'h1:22:u': [{ id: 'existing', label: 'Existing', type: 'password' }],
      });

      await service.importCredentialMetadata('h1:22:u', incoming, 'merge');

      const creds = service.listCredentials('h1:22:u');
      expect(creds.map((c) => c.label).sort()).toEqual(['Default', 'Deploy Key', 'Existing']);
    });

    it('updates a credential with the same id and merges pinned folders by remotePath', async () => {
      setMockConfig('sshLite.credentialIndex', {
        'h1:22:u': [
          {
            id: 'cred_a',
            label: 'Stale',
            type: 'password',
            pinnedFolders: [{ id: 'old_pin', name: 'logs', remotePath: '/var/log' }],
          },
        ],
      });

      await service.importCredentialMetadata('h1:22:u', incoming, 'merge');

      const creds = service.listCredentials('h1:22:u');
      const credA = creds.find((c) => c.id === 'cred_a');
      expect(credA?.label).toBe('Default'); // updated
      const paths = (credA?.pinnedFolders || []).map((p) => p.remotePath).sort();
      expect(paths).toEqual(['/var/log', '/var/www/app']); // existing kept + imported added
    });

    it('does not duplicate a pinned folder that already exists (same remotePath)', async () => {
      setMockConfig('sshLite.credentialIndex', {
        'h1:22:u': [
          {
            id: 'cred_a',
            label: 'Default',
            type: 'password',
            pinnedFolders: [{ id: 'p1', name: 'app', remotePath: '/var/www/app' }],
          },
        ],
      });

      await service.importCredentialMetadata('h1:22:u', incoming, 'merge');

      const credA = service.listCredentials('h1:22:u').find((c) => c.id === 'cred_a');
      expect(credA?.pinnedFolders).toHaveLength(1);
    });
  });

  describe('hardening', () => {
    it('drops credentials whose type is not a known CredentialType', async () => {
      const crafted = [
        { id: 'ok', label: 'Good', type: 'password' as const },
        { id: 'evil', label: 'Bad', type: '../../etc/passwd' },
        { id: 'ok2', label: 'Key', type: 'privateKey' as const, privateKeyPath: '~/.ssh/x' },
      ];

      await service.importCredentialMetadata('h1:22:u', crafted as any, 'replace');

      const creds = service.listCredentials('h1:22:u');
      expect(creds.map((c) => c.label).sort()).toEqual(['Good', 'Key']);
      expect(creds.find((c) => c.type === '../../etc/passwd' as any)).toBeUndefined();
    });
  });

  describe('id generation', () => {
    it('generates ids for imported credentials and pinned folders that lack one', async () => {
      const noIds = [
        { label: 'NoId', type: 'password' as const, pinnedFolders: [{ name: 'p', remotePath: '/p' }] },
      ];

      await service.importCredentialMetadata('h1:22:u', noIds as any, 'replace');

      const cred = service.listCredentials('h1:22:u')[0];
      expect(cred.id).toMatch(/^cred_/);
      expect(cred.pinnedFolders?.[0].id).toMatch(/^pin_/);
    });
  });
});
