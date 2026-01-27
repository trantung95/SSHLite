/**
 * Multi-OS CommandGuard Integration Tests
 *
 * Tests the CommandGuard wrapper class against 5 Docker server OS.
 * CommandGuard wraps SSHConnection methods with activity tracking.
 * Verifies that tracked operations succeed and activities are recorded.
 */
import { SSHConnection } from '../connection/SSHConnection';
import { CommandGuard } from '../services/CommandGuard';
import { ActivityService } from '../services/ActivityService';
import { IRemoteFile } from '../types';
import {
  CI_SERVERS,
  OSServerConfig,
  createTestConnection,
  safeDisconnect,
  disconnectAll,
  setupCredentialServiceMock,
  setupVscodeMocks,
} from './multios-helpers';

beforeAll(() => {
  setupCredentialServiceMock();
  setupVscodeMocks();
  // Reset singletons
  (CommandGuard as any)._instance = undefined;
  (ActivityService as any)._instance = undefined;
});

// ---- Per-OS CommandGuard Tests ----
describe.each(CI_SERVERS)('CommandGuard on $os', (server: OSServerConfig) => {
  let conn: SSHConnection;
  let guard: CommandGuard;
  const testDir = `/home/testuser/guard-test-${server.hostname}`;

  beforeAll(async () => {
    conn = await createTestConnection(server);
    guard = CommandGuard.getInstance();
    // Create test directory
    try {
      await conn.exec(`rm -rf ${testDir}`);
    } catch { /* ignore */ }
    await conn.mkdir(testDir);
  });

  afterAll(async () => {
    try {
      await conn.exec(`rm -rf ${testDir}`);
    } catch { /* ignore */ }
    await safeDisconnect(conn);
  });

  describe('exec', () => {
    it('should execute command and return result', async () => {
      const result = await guard.exec(conn, 'echo "guard test"');
      expect(result.trim()).toBe('guard test');
    });

    it('should execute complex command', async () => {
      const result = await guard.exec(conn, 'uname -s && hostname');
      expect(result).toContain('Linux');
      expect(result).toContain(server.hostname);
    });
  });

  describe('readFile', () => {
    it('should read file and return Buffer', async () => {
      const content = await guard.readFile(conn, '/home/testuser/projects/src/app.ts');
      expect(content).toBeInstanceOf(Buffer);
      expect(content.toString()).toContain('console.log');
    });
  });

  describe('writeFile', () => {
    it('should write file successfully', async () => {
      await guard.writeFile(conn, `${testDir}/guard-write.txt`, 'guard content');
      const content = await conn.readFile(`${testDir}/guard-write.txt`);
      expect(content.toString()).toBe('guard content');
    });

    it('should write Buffer content', async () => {
      const buf = Buffer.from('buffer guard content');
      await guard.writeFile(conn, `${testDir}/guard-buf.txt`, buf);
      const content = await conn.readFile(`${testDir}/guard-buf.txt`);
      expect(content.toString()).toBe('buffer guard content');
    });
  });

  describe('listFiles', () => {
    it('should list directory and return IRemoteFile[]', async () => {
      const files = await guard.listFiles(conn, '/home/testuser/projects');
      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBeGreaterThan(0);
      const names = files.map((f: IRemoteFile) => f.name);
      expect(names).toContain('package.json');
    });
  });

  describe('searchFiles', () => {
    beforeAll(async () => {
      const searchDir = `${testDir}/search`;
      await conn.mkdir(searchDir);
      await conn.writeFile(`${searchDir}/data.ts`, Buffer.from('const value = "findme";'));
      await conn.writeFile(`${searchDir}/other.js`, Buffer.from('const other = "findme";'));
    });

    it('should search content and return results', async () => {
      const results = await guard.searchFiles(conn, `${testDir}/search`, 'findme', {
        searchContent: true,
      });
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should search filenames and return results', async () => {
      const results = await guard.searchFiles(conn, `${testDir}/search`, 'data', {
        searchContent: false,
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      expect(results.some(r => r.path.includes('data.ts'))).toBe(true);
    });
  });

  describe('activity tracking', () => {
    it('should track exec as activity', async () => {
      const activityService = ActivityService.getInstance();
      const beforeCount = activityService.getAllActivities().length;

      await guard.exec(conn, 'echo "tracked"', {
        description: 'Test tracked command',
      });

      const afterCount = activityService.getAllActivities().length;
      expect(afterCount).toBeGreaterThan(beforeCount);
    });
  });
});

// ---- Cross-OS CommandGuard Tests ----
describe('Cross-OS CommandGuard', () => {
  it('should execute commands on all 5 OS via guard', async () => {
    const connections = await Promise.all(
      CI_SERVERS.map(server => createTestConnection(server))
    );
    const guard = CommandGuard.getInstance();

    try {
      const results = await Promise.all(
        connections.map(conn => guard.exec(conn, 'hostname'))
      );
      for (let i = 0; i < 5; i++) {
        expect(results[i].trim()).toBe(CI_SERVERS[i].hostname);
      }
    } finally {
      await disconnectAll(connections);
    }
  });

  it('should list files on all 5 OS via guard', async () => {
    const connections = await Promise.all(
      CI_SERVERS.map(server => createTestConnection(server))
    );
    const guard = CommandGuard.getInstance();

    try {
      const fileLists = await Promise.all(
        connections.map(conn => guard.listFiles(conn, '/home/testuser'))
      );
      for (const files of fileLists) {
        expect(files.length).toBeGreaterThan(0);
      }
    } finally {
      await disconnectAll(connections);
    }
  });
});
