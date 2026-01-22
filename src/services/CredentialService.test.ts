import {
  workspace,
  window,
  createMockExtensionContext,
  setMockConfig,
  clearMockConfig,
  resetAllMocks,
  SecretStorage,
} from '../__mocks__/vscode';
import { CredentialService, SavedCredential, CredentialType } from './CredentialService';

// Reset singleton between tests
function resetCredentialService(): CredentialService {
  // Access private static field to reset singleton
  (CredentialService as unknown as { _instance: CredentialService | undefined })._instance = undefined;
  return CredentialService.getInstance();
}

describe('CredentialService', () => {
  let credentialService: CredentialService;
  let mockContext: ReturnType<typeof createMockExtensionContext>;

  beforeEach(() => {
    resetAllMocks();
    clearMockConfig();
    mockContext = createMockExtensionContext();
    credentialService = resetCredentialService();
    credentialService.initialize(mockContext as unknown as Parameters<typeof credentialService.initialize>[0]);
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = CredentialService.getInstance();
      const instance2 = CredentialService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('listCredentials', () => {
    it('should return empty array for host with no credentials', () => {
      setMockConfig('sshLite.credentialIndex', {});
      const credentials = credentialService.listCredentials('host1');
      expect(credentials).toEqual([]);
    });

    it('should return credentials for a host', () => {
      const mockCredentials: SavedCredential[] = [
        { id: 'cred1', label: 'Default', type: 'password' },
        { id: 'cred2', label: 'SSH Key', type: 'privateKey', privateKeyPath: '~/.ssh/id_rsa' },
      ];
      setMockConfig('sshLite.credentialIndex', { host1: mockCredentials });

      const credentials = credentialService.listCredentials('host1');
      expect(credentials).toHaveLength(2);
      expect(credentials[0].label).toBe('Default');
      expect(credentials[1].type).toBe('privateKey');
    });
  });

  describe('addCredential', () => {
    it('should add a password credential', async () => {
      setMockConfig('sshLite.credentialIndex', {});

      const credential = await credentialService.addCredential(
        'host1',
        'My Password',
        'password',
        'secret123'
      );

      expect(credential).toBeDefined();
      expect(credential.label).toBe('My Password');
      expect(credential.type).toBe('password');
      expect(credential.id).toMatch(/^cred_\d+_[a-z0-9]+$/);
    });

    it('should add a private key credential', async () => {
      setMockConfig('sshLite.credentialIndex', {});

      const credential = await credentialService.addCredential(
        'host1',
        'My SSH Key',
        'privateKey',
        'passphrase123',
        '~/.ssh/id_rsa'
      );

      expect(credential).toBeDefined();
      expect(credential.label).toBe('My SSH Key');
      expect(credential.type).toBe('privateKey');
      expect(credential.privateKeyPath).toBe('~/.ssh/id_rsa');
    });

    it('should store secret in session credentials', async () => {
      setMockConfig('sshLite.credentialIndex', {});

      const credential = await credentialService.addCredential(
        'host1',
        'Test',
        'password',
        'mypassword'
      );

      const secret = await credentialService.getCredentialSecret('host1', credential.id);
      expect(secret).toBe('mypassword');
    });
  });

  describe('getCredentialSecret', () => {
    it('should return session credential if available', async () => {
      credentialService.setSessionCredential('host1', 'cred1', 'sessionPassword');

      const secret = await credentialService.getCredentialSecret('host1', 'cred1');
      expect(secret).toBe('sessionPassword');
    });

    it('should return undefined if credential not found', async () => {
      const secret = await credentialService.getCredentialSecret('host1', 'nonexistent');
      expect(secret).toBeUndefined();
    });

    it('should check secret storage if session credential not found', async () => {
      // Store directly in secret storage
      await mockContext.secrets.store('sshLite:host1:cred1', 'storedPassword');

      const secret = await credentialService.getCredentialSecret('host1', 'cred1');
      expect(secret).toBe('storedPassword');
    });
  });

  describe('setSessionCredential', () => {
    it('should store credential in session only', async () => {
      credentialService.setSessionCredential('host1', 'cred1', 'tempPassword');

      const secret = await credentialService.getCredentialSecret('host1', 'cred1');
      expect(secret).toBe('tempPassword');
    });
  });

  describe('deleteCredential', () => {
    it('should delete credential from index', async () => {
      const mockCredentials: SavedCredential[] = [
        { id: 'cred1', label: 'Default', type: 'password' },
        { id: 'cred2', label: 'Backup', type: 'password' },
      ];
      setMockConfig('sshLite.credentialIndex', { host1: mockCredentials });

      // Add to session so we can verify deletion
      credentialService.setSessionCredential('host1', 'cred1', 'pass1');

      await credentialService.deleteCredential('host1', 'cred1');

      // Session credential should be cleared
      const secret = await credentialService.getCredentialSecret('host1', 'cred1');
      expect(secret).toBeUndefined();
    });

    it('should clear session credential on delete', async () => {
      credentialService.setSessionCredential('host1', 'cred1', 'password');
      setMockConfig('sshLite.credentialIndex', {
        host1: [{ id: 'cred1', label: 'Default', type: 'password' }]
      });

      await credentialService.deleteCredential('host1', 'cred1');

      const secret = await credentialService.getCredentialSecret('host1', 'cred1');
      expect(secret).toBeUndefined();
    });
  });

  describe('updateCredentialPassword', () => {
    it('should update password in session', async () => {
      credentialService.setSessionCredential('host1', 'cred1', 'oldPassword');

      await credentialService.updateCredentialPassword('host1', 'cred1', 'newPassword');

      const secret = await credentialService.getCredentialSecret('host1', 'cred1');
      expect(secret).toBe('newPassword');
    });

    it('should update password in secret storage', async () => {
      await credentialService.updateCredentialPassword('host1', 'cred1', 'newPassword');

      const storedPassword = await mockContext.secrets.get('sshLite:host1:cred1');
      expect(storedPassword).toBe('newPassword');
    });
  });

  describe('deleteAll', () => {
    it('should delete all credentials for a host', async () => {
      const mockCredentials: SavedCredential[] = [
        { id: 'cred1', label: 'Default', type: 'password' },
        { id: 'cred2', label: 'Backup', type: 'password' },
      ];
      setMockConfig('sshLite.credentialIndex', { host1: mockCredentials });

      // Set session credentials
      credentialService.setSessionCredential('host1', 'cred1', 'pass1');
      credentialService.setSessionCredential('host1', 'cred2', 'pass2');

      await credentialService.deleteAll('host1');

      // Session credentials should be cleared
      expect(await credentialService.getCredentialSecret('host1', 'cred1')).toBeUndefined();
      expect(await credentialService.getCredentialSecret('host1', 'cred2')).toBeUndefined();
    });
  });

  describe('get (legacy)', () => {
    it('should return first password credential', async () => {
      const mockCredentials: SavedCredential[] = [
        { id: 'cred1', label: 'Default', type: 'password' },
      ];
      setMockConfig('sshLite.credentialIndex', { host1: mockCredentials });
      credentialService.setSessionCredential('host1', 'cred1', 'myPassword');

      const password = await credentialService.get('host1', 'password');
      expect(password).toBe('myPassword');
    });

    it('should return undefined if no password credential exists', async () => {
      setMockConfig('sshLite.credentialIndex', { host1: [] });

      const password = await credentialService.get('host1', 'password');
      expect(password).toBeUndefined();
    });
  });

  describe('save (legacy)', () => {
    it('should create new default credential if none exists', async () => {
      setMockConfig('sshLite.credentialIndex', {});

      // The save function should complete without error
      await expect(credentialService.save('host1', 'password', 'newPassword')).resolves.not.toThrow();
    });

    it('should update existing default credential', async () => {
      const mockCredentials: SavedCredential[] = [
        { id: 'cred1', label: 'Default', type: 'password' },
      ];
      setMockConfig('sshLite.credentialIndex', { host1: mockCredentials });

      await credentialService.save('host1', 'password', 'updatedPassword');

      const password = await credentialService.getCredentialSecret('host1', 'cred1');
      expect(password).toBe('updatedPassword');
    });
  });

  describe('getOrPrompt', () => {
    it('should return saved credential without prompting', async () => {
      const mockCredentials: SavedCredential[] = [
        { id: 'cred1', label: 'Default', type: 'password' },
      ];
      setMockConfig('sshLite.credentialIndex', { host1: mockCredentials });
      credentialService.setSessionCredential('host1', 'cred1', 'savedPassword');

      const password = await credentialService.getOrPrompt('host1', 'password', 'Enter password');

      expect(password).toBe('savedPassword');
      expect(window.showInputBox).not.toHaveBeenCalled();
    });

    it('should prompt user if no saved credential', async () => {
      setMockConfig('sshLite.credentialIndex', {});
      (window.showInputBox as jest.Mock).mockResolvedValue('userEnteredPassword');

      const password = await credentialService.getOrPrompt('host1', 'password', 'Enter password');

      expect(password).toBe('userEnteredPassword');
      expect(window.showInputBox).toHaveBeenCalledWith({
        prompt: 'Enter password',
        password: true,
        ignoreFocusOut: true,
      });
    });

    it('should return undefined if user cancels prompt', async () => {
      setMockConfig('sshLite.credentialIndex', {});
      (window.showInputBox as jest.Mock).mockResolvedValue(undefined);

      const password = await credentialService.getOrPrompt('host1', 'password', 'Enter password');

      expect(password).toBeUndefined();
    });
  });
});
