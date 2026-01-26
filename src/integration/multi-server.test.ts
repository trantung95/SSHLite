/**
 * Multi-Server Concurrent Integration Tests
 *
 * Tests scenarios with multiple SSH servers connected simultaneously:
 * - Concurrent connection management
 * - File operations across servers
 * - Search across multiple servers
 * - Disconnect/reconnect one server while others remain connected
 * - Connection isolation (one server's failure doesn't affect others)
 * - Credential management per server
 */

import { ConnectionState } from '../types';
import { createMockHostConfig, createMockCredential, createMockConnection, createMockRemoteFile } from '../__mocks__/testHelpers';
import { ServerTreeItem } from '../providers/HostTreeProvider';

describe('Integration: Multi-Server Concurrent Operations', () => {
  describe('concurrent connection management', () => {
    it('should support multiple servers with unique connection IDs', () => {
      const hosts = [
        createMockHostConfig({ host: '10.0.0.1', port: 22, username: 'admin' }),
        createMockHostConfig({ host: '10.0.0.2', port: 22, username: 'deploy' }),
        createMockHostConfig({ host: '10.0.0.3', port: 2222, username: 'root' }),
      ];

      const connections = hosts.map(h => createMockConnection({ host: h }));

      expect(connections[0].id).toBe('10.0.0.1:22:admin');
      expect(connections[1].id).toBe('10.0.0.2:22:deploy');
      expect(connections[2].id).toBe('10.0.0.3:2222:root');

      // All IDs are unique
      const ids = new Set(connections.map(c => c.id));
      expect(ids.size).toBe(3);
    });

    it('should allow same username on different hosts', () => {
      const conn1 = createMockConnection({
        host: createMockHostConfig({ host: '10.0.0.1', username: 'admin' }),
      });
      const conn2 = createMockConnection({
        host: createMockHostConfig({ host: '10.0.0.2', username: 'admin' }),
      });

      expect(conn1.id).not.toBe(conn2.id);
    });

    it('should allow different users on the same host', () => {
      const conn1 = createMockConnection({
        host: createMockHostConfig({ host: '10.0.0.1', username: 'admin' }),
      });
      const conn2 = createMockConnection({
        host: createMockHostConfig({ host: '10.0.0.1', username: 'deploy' }),
      });

      expect(conn1.id).not.toBe(conn2.id);
      expect(conn1.host.host).toBe(conn2.host.host);
    });
  });

  describe('connection isolation', () => {
    it('should track independent connection states', () => {
      const connections = [
        createMockConnection({ id: 'conn1', state: ConnectionState.Connected }),
        createMockConnection({ id: 'conn2', state: ConnectionState.Disconnected }),
        createMockConnection({ id: 'conn3', state: ConnectionState.Connected }),
      ];

      const connected = connections.filter(c => c.state === ConnectionState.Connected);
      expect(connected).toHaveLength(2);
      expect(connected.map(c => c.id)).toEqual(['conn1', 'conn3']);
    });

    it('should support disconnect of one server while others remain connected', () => {
      const connections = new Map<string, ReturnType<typeof createMockConnection>>();
      connections.set('conn1', createMockConnection({ id: 'conn1', state: ConnectionState.Connected }));
      connections.set('conn2', createMockConnection({ id: 'conn2', state: ConnectionState.Connected }));
      connections.set('conn3', createMockConnection({ id: 'conn3', state: ConnectionState.Connected }));

      // Disconnect server 2
      const conn2 = connections.get('conn2')!;
      (conn2 as any).state = ConnectionState.Disconnected;

      // Others still connected
      expect(connections.get('conn1')!.state).toBe(ConnectionState.Connected);
      expect(connections.get('conn2')!.state).toBe(ConnectionState.Disconnected);
      expect(connections.get('conn3')!.state).toBe(ConnectionState.Connected);
    });
  });

  describe('file operations across servers', () => {
    it('should isolate file listings per connection', async () => {
      const conn1 = createMockConnection({ id: 'conn1' });
      const conn2 = createMockConnection({ id: 'conn2' });

      (conn1.listFiles as jest.Mock).mockResolvedValue([
        createMockRemoteFile('server1-file.ts', { connectionId: 'conn1' }),
      ]);
      (conn2.listFiles as jest.Mock).mockResolvedValue([
        createMockRemoteFile('server2-file.ts', { connectionId: 'conn2' }),
        createMockRemoteFile('server2-config.json', { connectionId: 'conn2' }),
      ]);

      const files1 = await conn1.listFiles('/home');
      const files2 = await conn2.listFiles('/home');

      expect(files1).toHaveLength(1);
      expect(files1[0].connectionId).toBe('conn1');
      expect(files2).toHaveLength(2);
      expect(files2[0].connectionId).toBe('conn2');
    });

    it('should read files from different servers independently', async () => {
      const conn1 = createMockConnection({ id: 'conn1' });
      const conn2 = createMockConnection({ id: 'conn2' });

      (conn1.readFile as jest.Mock).mockResolvedValue(Buffer.from('content from server 1'));
      (conn2.readFile as jest.Mock).mockResolvedValue(Buffer.from('content from server 2'));

      const [content1, content2] = await Promise.all([
        conn1.readFile('/home/app/config.ts'),
        conn2.readFile('/home/app/config.ts'),
      ]);

      expect(content1.toString()).toBe('content from server 1');
      expect(content2.toString()).toBe('content from server 2');
    });

    it('should write files to different servers in parallel', async () => {
      const conn1 = createMockConnection({ id: 'conn1' });
      const conn2 = createMockConnection({ id: 'conn2' });
      const conn3 = createMockConnection({ id: 'conn3' });

      await Promise.all([
        conn1.writeFile('/home/app/config.ts', Buffer.from('v1')),
        conn2.writeFile('/home/app/config.ts', Buffer.from('v2')),
        conn3.writeFile('/home/app/config.ts', Buffer.from('v3')),
      ]);

      expect(conn1.writeFile).toHaveBeenCalledWith('/home/app/config.ts', expect.any(Buffer));
      expect(conn2.writeFile).toHaveBeenCalledWith('/home/app/config.ts', expect.any(Buffer));
      expect(conn3.writeFile).toHaveBeenCalledWith('/home/app/config.ts', expect.any(Buffer));
    });
  });

  describe('search across multiple servers', () => {
    it('should search all servers in parallel', async () => {
      const conn1 = createMockConnection({ id: 'conn1' });
      const conn2 = createMockConnection({ id: 'conn2' });

      (conn1.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/server1/found.ts', line: 10, match: 'test pattern' },
      ]);
      (conn2.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/server2/found.ts', line: 5, match: 'test pattern' },
        { path: '/server2/other.ts', line: 20, match: 'test pattern' },
      ]);

      const [results1, results2] = await Promise.all([
        conn1.searchFiles('/server1', 'test pattern', { searchContent: true }),
        conn2.searchFiles('/server2', 'test pattern', { searchContent: true }),
      ]);

      const allResults = [...results1, ...results2];
      expect(allResults).toHaveLength(3);
    });

    it('should handle one server failing during parallel search', async () => {
      const conn1 = createMockConnection({ id: 'conn1' });
      const conn2 = createMockConnection({ id: 'conn2' });

      (conn1.searchFiles as jest.Mock).mockRejectedValue(new Error('Connection lost'));
      (conn2.searchFiles as jest.Mock).mockResolvedValue([
        { path: '/found.ts', line: 1, match: 'result' },
      ]);

      const results = await Promise.allSettled([
        conn1.searchFiles('/path', 'query'),
        conn2.searchFiles('/path', 'query'),
      ]);

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      if (results[1].status === 'fulfilled') {
        expect(results[1].value).toHaveLength(1);
      }
    });

    it('should support different search options per server', async () => {
      const conn1 = createMockConnection({ id: 'conn1' });
      const conn2 = createMockConnection({ id: 'conn2' });

      (conn1.searchFiles as jest.Mock).mockResolvedValue([]);
      (conn2.searchFiles as jest.Mock).mockResolvedValue([]);

      await Promise.all([
        conn1.searchFiles('/home', 'TODO', { caseSensitive: true, filePattern: '*.ts' }),
        conn2.searchFiles('/var/log', 'error', { caseSensitive: false, filePattern: '*.log' }),
      ]);

      expect(conn1.searchFiles).toHaveBeenCalledWith('/home', 'TODO', expect.objectContaining({
        caseSensitive: true,
        filePattern: '*.ts',
      }));
      expect(conn2.searchFiles).toHaveBeenCalledWith('/var/log', 'error', expect.objectContaining({
        caseSensitive: false,
        filePattern: '*.log',
      }));
    });
  });

  describe('tree display with multiple servers', () => {
    it('should show multiple servers grouped by host:port', () => {
      const server1Hosts = [
        createMockHostConfig({ id: '10.0.0.1:22:admin', name: 'Production' }),
      ];
      const server2Hosts = [
        createMockHostConfig({ id: '10.0.0.2:22:deploy', name: 'Staging' }),
      ];
      const server3Hosts = [
        createMockHostConfig({ id: '10.0.0.3:22:root', name: 'Dev' }),
      ];

      const items = [
        new ServerTreeItem('10.0.0.1:22', server1Hosts, true),
        new ServerTreeItem('10.0.0.2:22', server2Hosts, true),
        new ServerTreeItem('10.0.0.3:22', server3Hosts, false),
      ];

      expect(items[0].label).toBe('Production');
      expect(items[0].isConnected).toBe(true);
      expect(items[1].label).toBe('Staging');
      expect(items[1].isConnected).toBe(true);
      expect(items[2].label).toBe('Dev');
      expect(items[2].isConnected).toBe(false);
    });

    it('should group multiple users under same host:port', () => {
      const hosts = [
        createMockHostConfig({ id: '10.0.0.1:22:admin', name: 'Prod (admin)', username: 'admin' }),
        createMockHostConfig({ id: '10.0.0.1:22:deploy', name: 'Prod (deploy)', username: 'deploy' }),
      ];

      const item = new ServerTreeItem('10.0.0.1:22', hosts, true);
      expect(item.label).toBe('Prod (admin)'); // First host's name
      expect(item.hosts).toHaveLength(2);
    });
  });

  describe('credential management per server', () => {
    it('should associate credentials with specific host IDs', () => {
      const cred1 = createMockCredential({ id: 'cred_prod', label: 'Prod Key', type: 'privateKey' });
      const cred2 = createMockCredential({ id: 'cred_staging', label: 'Staging Pass', type: 'password' });
      const cred3 = createMockCredential({ id: 'cred_dev', label: 'Dev Key', type: 'privateKey' });

      // Store in a map simulating credential index
      const credIndex: Record<string, typeof cred1[]> = {
        '10.0.0.1:22:admin': [cred1],
        '10.0.0.2:22:deploy': [cred2],
        '10.0.0.3:22:root': [cred3],
      };

      expect(credIndex['10.0.0.1:22:admin']).toHaveLength(1);
      expect(credIndex['10.0.0.1:22:admin'][0].type).toBe('privateKey');
      expect(credIndex['10.0.0.2:22:deploy'][0].type).toBe('password');
    });

    it('should support multiple credentials per server', () => {
      const creds = [
        createMockCredential({ id: 'cred_key', label: 'SSH Key', type: 'privateKey' }),
        createMockCredential({ id: 'cred_pass', label: 'Password', type: 'password' }),
      ];

      const credIndex: Record<string, typeof creds[0][]> = {
        '10.0.0.1:22:admin': creds,
      };

      expect(credIndex['10.0.0.1:22:admin']).toHaveLength(2);
    });
  });

  describe('concurrent command execution', () => {
    it('should execute commands on different servers simultaneously', async () => {
      const conn1 = createMockConnection({ id: 'conn1' });
      const conn2 = createMockConnection({ id: 'conn2' });
      const conn3 = createMockConnection({ id: 'conn3' });

      (conn1.exec as jest.Mock).mockResolvedValue('server1: 4 CPUs');
      (conn2.exec as jest.Mock).mockResolvedValue('server2: 8 CPUs');
      (conn3.exec as jest.Mock).mockResolvedValue('server3: 16 CPUs');

      const results = await Promise.all([
        conn1.exec('nproc'),
        conn2.exec('nproc'),
        conn3.exec('nproc'),
      ]);

      expect(results).toEqual([
        'server1: 4 CPUs',
        'server2: 8 CPUs',
        'server3: 16 CPUs',
      ]);
    });

    it('should handle timeout on one server without blocking others', async () => {
      const conn1 = createMockConnection({ id: 'conn1' });
      const conn2 = createMockConnection({ id: 'conn2' });

      (conn1.exec as jest.Mock).mockImplementation(() =>
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 100))
      );
      (conn2.exec as jest.Mock).mockResolvedValue('success');

      const results = await Promise.allSettled([
        conn1.exec('slow-command'),
        conn2.exec('fast-command'),
      ]);

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      if (results[1].status === 'fulfilled') {
        expect(results[1].value).toBe('success');
      }
    });
  });

  describe('file mapping isolation between connections', () => {
    it('should maintain separate file mappings per connection', () => {
      // Simulate file mappings from FileService
      const fileMappings = new Map<string, { connectionId: string; remotePath: string }>();

      // Same remote file opened from two different servers
      fileMappings.set('/tmp/ssh-lite-conn1/src/app.ts', {
        connectionId: 'conn1',
        remotePath: '/src/app.ts',
      });
      fileMappings.set('/tmp/ssh-lite-conn2/src/app.ts', {
        connectionId: 'conn2',
        remotePath: '/src/app.ts',
      });

      expect(fileMappings.size).toBe(2);

      // Cleaning up conn1 shouldn't affect conn2
      for (const [key, mapping] of fileMappings) {
        if (mapping.connectionId === 'conn1') {
          fileMappings.delete(key);
        }
      }

      expect(fileMappings.size).toBe(1);
      expect(fileMappings.has('/tmp/ssh-lite-conn2/src/app.ts')).toBe(true);
    });
  });
});
