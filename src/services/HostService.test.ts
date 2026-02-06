/**
 * HostService tests
 *
 * Tests host management: loading from config, saving, removing, merging,
 * cache invalidation.
 *
 * File system and SSH config parsing are mocked.
 */

import { setMockConfig, clearMockConfig, workspace } from '../__mocks__/vscode';

// Mock fs and ssh-config
const mockWriteFileSync = jest.fn();
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue(''),
  statSync: jest.fn().mockReturnValue({ mtimeMs: 1000 }),
  writeFileSync: mockWriteFileSync,
}));

const mockRemove = jest.fn();
const mockToString = jest.fn().mockReturnValue('');
jest.mock('ssh-config', () => ({
  parse: jest.fn().mockReturnValue({
    [Symbol.iterator]: function* () {},
    compute: jest.fn().mockReturnValue({}),
    remove: mockRemove,
    toString: mockToString,
  }),
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
    config.update = jest.fn().mockImplementation(
      (key: string, value: unknown, _target: unknown) => {
        const fullKey = section ? `${section}.${key}` : key;
        setMockConfig(fullKey, value);
        return Promise.resolve();
      }
    );
    return config;
  };
}

describe('HostService', () => {
  let service: HostService;

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockConfig();
    enableConfigPersistence();
    service = resetHostService();
  });

  afterEach(() => {
    clearMockConfig();
  });

  describe('getInstance', () => {
    it('should return singleton', () => {
      const a = HostService.getInstance();
      const b = HostService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('getAllHosts', () => {
    it('should return empty array when no hosts configured', () => {
      const hosts = service.getAllHosts();
      expect(hosts).toEqual([]);
    });

    it('should load saved hosts from VS Code settings', () => {
      setMockConfig('sshLite.hosts', [
        { name: 'Server1', host: '10.0.0.1', port: 22, username: 'admin' },
        { name: 'Server2', host: '10.0.0.2', username: 'deploy' },
      ]);

      const hosts = service.getAllHosts();
      expect(hosts).toHaveLength(2);
    });

    it('should generate correct IDs for saved hosts', () => {
      setMockConfig('sshLite.hosts', [
        { name: 'Server1', host: '10.0.0.1', port: 2222, username: 'admin' },
      ]);

      const hosts = service.getAllHosts();
      expect(hosts[0].id).toBe('10.0.0.1:2222:admin');
    });

    it('should default port to 22 when not specified', () => {
      setMockConfig('sshLite.hosts', [
        { name: 'Server1', host: '10.0.0.1', username: 'admin' },
      ]);

      const hosts = service.getAllHosts();
      expect(hosts[0].port).toBe(22);
      expect(hosts[0].id).toBe('10.0.0.1:22:admin');
    });

    it('should sort hosts alphabetically by name', () => {
      setMockConfig('sshLite.hosts', [
        { name: 'Zebra', host: '10.0.0.3', username: 'u' },
        { name: 'Alpha', host: '10.0.0.1', username: 'u' },
        { name: 'Mango', host: '10.0.0.2', username: 'u' },
      ]);

      const hosts = service.getAllHosts();
      expect(hosts.map(h => h.name)).toEqual(['Alpha', 'Mango', 'Zebra']);
    });

    it('should mark saved hosts with source=saved', () => {
      setMockConfig('sshLite.hosts', [
        { name: 'Server1', host: '10.0.0.1', username: 'admin' },
      ]);

      const hosts = service.getAllHosts();
      expect(hosts[0].source).toBe('saved');
    });
  });

  describe('saveHost', () => {
    it('should add a new host to settings', async () => {
      setMockConfig('sshLite.hosts', []);

      await service.saveHost({
        name: 'NewServer',
        host: '10.0.0.5',
        port: 22,
        username: 'newuser',
      });

      // Verify via persisted config value (enableConfigPersistence stores via setMockConfig)
      const hosts = workspace.getConfiguration('sshLite').get('hosts') as any[];
      expect(hosts).toBeDefined();
      expect(hosts.length).toBeGreaterThan(0);
      expect(hosts[0].name).toBe('NewServer');
    });

    it('should update existing host on duplicate', async () => {
      setMockConfig('sshLite.hosts', [
        { name: 'OldName', host: '10.0.0.1', port: 22, username: 'admin' },
      ]);

      await service.saveHost({
        name: 'NewName',
        host: '10.0.0.1',
        port: 22,
        username: 'admin',
      });

      const hosts = workspace.getConfiguration('sshLite').get('hosts') as any[];
      expect(hosts).toHaveLength(1);
      expect(hosts[0].name).toBe('NewName');
    });
  });

  describe('removeHost', () => {
    it('should remove host by ID', async () => {
      setMockConfig('sshLite.hosts', [
        { name: 'Server1', host: '10.0.0.1', port: 22, username: 'admin' },
        { name: 'Server2', host: '10.0.0.2', port: 22, username: 'deploy' },
      ]);

      await service.removeHost('10.0.0.1:22:admin');

      const hosts = workspace.getConfiguration('sshLite').get('hosts') as any[];
      expect(hosts).toHaveLength(1);
      expect(hosts[0].name).toBe('Server2');
    });
  });

  describe('removeHostFromSSHConfig', () => {
    it('should remove Host block and write file', async () => {
      const fs = require('fs');
      fs.readFileSync.mockReturnValue('Host test\n  HostName 1.2.3.4\n');
      mockToString.mockReturnValue('');

      await service.removeHostFromSSHConfig('test');

      expect(mockRemove).toHaveBeenCalledWith({ Host: 'test' });
      expect(mockWriteFileSync).toHaveBeenCalled();
    });
  });

  describe('invalidateCache', () => {
    it('should clear the SSH config cache', () => {
      service.invalidateCache();
      // No error thrown means success
      // The cache is private, but calling invalidateCache ensures next
      // getAllHosts() re-reads the SSH config file
    });
  });
});
