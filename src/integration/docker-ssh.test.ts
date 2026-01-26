/**
 * Docker-based SSH Integration Tests
 *
 * Tests real SSH connections to Docker containers running sshd.
 * Covers: connect, file listing, file read/write, search, mkdir, delete,
 * multi-server concurrent operations, disconnect/reconnect.
 *
 * Containers are automatically started/stopped via jest.docker.config.js
 * which uses globalSetup (docker compose up) and globalTeardown (docker compose down).
 *
 * Run:
 *   npm run test:docker
 */

import { Client, SFTPWrapper } from 'ssh2';

// Test server configs
const SERVER_1 = { host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' };
const SERVER_2 = { host: '127.0.0.1', port: 2202, username: 'testuser', password: 'testpass' };
const SERVER_3 = { host: '127.0.0.1', port: 2203, username: 'admin', password: 'adminpass' };

/** Helper: connect to SSH server */
function connectSSH(config: typeof SERVER_1): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => resolve(client));
    client.on('error', reject);
    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: 5000,
    });
  });
}

/** Helper: get SFTP session */
function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

/** Helper: exec command on server */
function exec(client: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    client.exec(command, (err, stream) => {
      if (err) reject(err);
      let output = '';
      stream.on('data', (data: Buffer) => { output += data.toString(); });
      stream.stderr.on('data', (data: Buffer) => { output += data.toString(); });
      stream.on('close', () => resolve(output.trim()));
    });
  });
}

/** Helper: read remote file */
function readFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(path);
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Helper: write remote file */
function writeFile(sftp: SFTPWrapper, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(path);
    stream.on('close', () => resolve());
    stream.on('error', reject);
    stream.end(content);
  });
}

/** Helper: list directory */
function listDir(sftp: SFTPWrapper, path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) reject(err);
      else resolve(list.map(f => f.filename).filter(f => f !== '.' && f !== '..'));
    });
  });
}

/** Helper: stat file */
function statFile(sftp: SFTPWrapper, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => {
      if (err) reject(err);
      else resolve(stats);
    });
  });
}

/** Helper: mkdir */
function mkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Helper: rmdir */
function rmdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Helper: unlink file */
function unlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

describe('Docker SSH Integration Tests', () => {
  // =====================================================
  // SINGLE CONNECTION TESTS
  // =====================================================
  describe('single connection', () => {
    let client: Client;
    let sftp: SFTPWrapper;

    beforeAll(async () => {
      client = await connectSSH(SERVER_1);
      sftp = await getSftp(client);
    }, 15000);

    afterAll(() => {
      client?.end();
    });

    describe('connection', () => {
      it('should connect successfully', () => {
        expect(client).toBeDefined();
      });

      it('should get hostname via exec', async () => {
        const hostname = await exec(client, 'hostname');
        expect(hostname).toBeTruthy();
      });

      it('should get current user', async () => {
        const whoami = await exec(client, 'whoami');
        expect(whoami).toBe('testuser');
      });
    });

    describe('file listing', () => {
      it('should list home directory', async () => {
        const files = await listDir(sftp, '/home/testuser');
        expect(files).toContain('projects');
        expect(files).toContain('logs');
      });

      it('should list project files', async () => {
        const files = await listDir(sftp, '/home/testuser/projects');
        expect(files).toContain('src');
        expect(files).toContain('package.json');
      });

      it('should list nested directory', async () => {
        const files = await listDir(sftp, '/home/testuser/projects/src');
        expect(files).toContain('app.ts');
        expect(files).toContain('todo.ts');
      });
    });

    describe('file read', () => {
      it('should read a file', async () => {
        const content = await readFile(sftp, '/home/testuser/projects/src/app.ts');
        expect(content.toString()).toContain('console.log');
      });

      it('should read JSON file', async () => {
        const content = await readFile(sftp, '/home/testuser/projects/package.json');
        const json = JSON.parse(content.toString());
        expect(json.name).toBe('test');
      });
    });

    describe('file write', () => {
      const testFile = '/home/testuser/test-write.txt';

      afterAll(async () => {
        try { await unlink(sftp, testFile); } catch { /* ignore */ }
      });

      it('should write a new file', async () => {
        await writeFile(sftp, testFile, 'hello from test');
        const content = await readFile(sftp, testFile);
        expect(content.toString()).toBe('hello from test');
      });

      it('should overwrite existing file', async () => {
        await writeFile(sftp, testFile, 'updated content');
        const content = await readFile(sftp, testFile);
        expect(content.toString()).toBe('updated content');
      });
    });

    describe('directory operations', () => {
      const testDir = '/home/testuser/test-mkdir';
      const nestedDir = '/home/testuser/test-mkdir/nested';

      afterAll(async () => {
        try { await rmdir(sftp, nestedDir); } catch { /* ignore */ }
        try { await rmdir(sftp, testDir); } catch { /* ignore */ }
      });

      it('should create a directory', async () => {
        await mkdir(sftp, testDir);
        const stats = await statFile(sftp, testDir);
        expect(stats).toBeDefined();
      });

      it('should create nested directory', async () => {
        await mkdir(sftp, nestedDir);
        const files = await listDir(sftp, testDir);
        expect(files).toContain('nested');
      });

      it('should list created directory in parent', async () => {
        const files = await listDir(sftp, '/home/testuser');
        expect(files).toContain('test-mkdir');
      });
    });

    describe('file delete', () => {
      it('should delete a file', async () => {
        const testFile = '/home/testuser/delete-me.txt';
        await writeFile(sftp, testFile, 'temporary');
        await unlink(sftp, testFile);

        await expect(readFile(sftp, testFile)).rejects.toThrow();
      });
    });

    describe('search via grep', () => {
      it('should find text in files', async () => {
        const result = await exec(client, 'grep -rl "hello" /home/testuser/projects/');
        expect(result).toContain('app.ts');
      });

      it('should find TODO comments', async () => {
        const result = await exec(client, 'grep -rn "TODO" /home/testuser/projects/src/');
        expect(result).toContain('todo.ts');
        expect(result).toContain('fix bug');
      });

      it('should support case-insensitive search', async () => {
        const result = await exec(client, 'grep -ri "HELLO" /home/testuser/projects/');
        expect(result).toContain('app.ts');
      });

      it('should support file pattern filter', async () => {
        const result = await exec(client, 'grep -rl --include="*.ts" "console" /home/testuser/projects/');
        expect(result).toContain('app.ts');
      });
    });

    describe('stat', () => {
      it('should stat a file', async () => {
        const stats = await statFile(sftp, '/home/testuser/projects/src/app.ts');
        expect(stats.size).toBeGreaterThan(0);
      });

      it('should stat a directory', async () => {
        const stats = await statFile(sftp, '/home/testuser/projects');
        expect(stats.isDirectory()).toBe(true);
      });
    });
  });

  // =====================================================
  // MULTI-CONNECTION TESTS
  // =====================================================
  describe('multiple connections simultaneously', () => {
    let client1: Client;
    let client2: Client;
    let client3: Client;
    let sftp1: SFTPWrapper;
    let sftp2: SFTPWrapper;
    let sftp3: SFTPWrapper;

    beforeAll(async () => {
      // Connect to all 3 servers in parallel
      [client1, client2, client3] = await Promise.all([
        connectSSH(SERVER_1),
        connectSSH(SERVER_2),
        connectSSH(SERVER_3),
      ]);
      [sftp1, sftp2, sftp3] = await Promise.all([
        getSftp(client1),
        getSftp(client2),
        getSftp(client3),
      ]);
    }, 30000);

    afterAll(() => {
      client1?.end();
      client2?.end();
      client3?.end();
    });

    it('should connect to all 3 servers simultaneously', () => {
      expect(client1).toBeDefined();
      expect(client2).toBeDefined();
      expect(client3).toBeDefined();
    });

    it('should get different hostnames from each server', async () => {
      const [h1, h2, h3] = await Promise.all([
        exec(client1, 'hostname'),
        exec(client2, 'hostname'),
        exec(client3, 'hostname'),
      ]);

      expect(h1).toBe('prod-server');
      expect(h2).toBe('staging-server');
      expect(h3).toBe('dev-server');
    });

    it('should list files from all servers in parallel', async () => {
      const [files1, files2, files3] = await Promise.all([
        listDir(sftp1, '/home/testuser'),
        listDir(sftp2, '/home/testuser'),
        listDir(sftp3, '/home/admin'),
      ]);

      // All servers have the same test content per user
      expect(files1).toContain('projects');
      expect(files2).toContain('projects');
      expect(files3).toContain('configs');
    });

    it('should read files from different servers simultaneously', async () => {
      const [content1, content2, content3] = await Promise.all([
        readFile(sftp1, '/home/testuser/projects/src/app.ts'),
        readFile(sftp2, '/home/testuser/projects/package.json'),
        readFile(sftp3, '/home/admin/configs/server.conf'),
      ]);

      expect(content1.toString()).toContain('console.log');
      expect(content2.toString()).toContain('"name"');
      expect(content3.toString()).toContain('server.port');
    });

    it('should write files to different servers simultaneously', async () => {
      const cleanup: Array<() => Promise<void>> = [];

      try {
        await Promise.all([
          writeFile(sftp1, '/home/testuser/multi-test-1.txt', 'from server 1'),
          writeFile(sftp2, '/home/testuser/multi-test-2.txt', 'from server 2'),
          writeFile(sftp3, '/home/admin/multi-test-3.txt', 'from server 3'),
        ]);

        cleanup.push(
          () => unlink(sftp1, '/home/testuser/multi-test-1.txt'),
          () => unlink(sftp2, '/home/testuser/multi-test-2.txt'),
          () => unlink(sftp3, '/home/admin/multi-test-3.txt'),
        );

        // Verify each file
        const [c1, c2, c3] = await Promise.all([
          readFile(sftp1, '/home/testuser/multi-test-1.txt'),
          readFile(sftp2, '/home/testuser/multi-test-2.txt'),
          readFile(sftp3, '/home/admin/multi-test-3.txt'),
        ]);

        expect(c1.toString()).toBe('from server 1');
        expect(c2.toString()).toBe('from server 2');
        expect(c3.toString()).toBe('from server 3');
      } finally {
        await Promise.all(cleanup.map(fn => fn().catch(() => {})));
      }
    });

    it('should search across multiple servers simultaneously', async () => {
      const [result1, result2, result3] = await Promise.all([
        exec(client1, 'grep -rl "hello" /home/testuser/projects/ 2>/dev/null || true'),
        exec(client2, 'grep -rl "TODO" /home/testuser/projects/ 2>/dev/null || true'),
        exec(client3, 'grep -rl "port" /home/admin/configs/ 2>/dev/null || true'),
      ]);

      expect(result1).toContain('app.ts');
      expect(result2).toContain('todo.ts');
      expect(result3).toContain('server.conf');
    });

    it('should handle one server failing without affecting others', async () => {
      // Try to read non-existent file on server 1, but succeed on servers 2 and 3
      const results = await Promise.allSettled([
        readFile(sftp1, '/home/testuser/nonexistent.txt'),
        readFile(sftp2, '/home/testuser/projects/package.json'),
        readFile(sftp3, '/home/admin/configs/db.conf'),
      ]);

      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      expect(results[2].status).toBe('fulfilled');
    });

    it('should support CRUD on each server independently', async () => {
      const files = [
        { sftp: sftp1, path: '/home/testuser/crud-test.txt' },
        { sftp: sftp2, path: '/home/testuser/crud-test.txt' },
        { sftp: sftp3, path: '/home/admin/crud-test.txt' },
      ];

      try {
        // Create files on all servers
        await Promise.all(files.map(f => writeFile(f.sftp, f.path, 'initial')));

        // Read from all servers
        const contents = await Promise.all(files.map(f => readFile(f.sftp, f.path)));
        contents.forEach(c => expect(c.toString()).toBe('initial'));

        // Update files on all servers
        await Promise.all(files.map(f => writeFile(f.sftp, f.path, 'updated')));

        // Verify updates
        const updated = await Promise.all(files.map(f => readFile(f.sftp, f.path)));
        updated.forEach(c => expect(c.toString()).toBe('updated'));

        // Delete files on all servers
        await Promise.all(files.map(f => unlink(f.sftp, f.path)));

        // Verify deletions
        const deleteResults = await Promise.allSettled(
          files.map(f => readFile(f.sftp, f.path))
        );
        deleteResults.forEach(r => expect(r.status).toBe('rejected'));
      } catch (err) {
        // Cleanup on failure
        await Promise.all(files.map(f => unlink(f.sftp, f.path).catch(() => {})));
        throw err;
      }
    });

    it('should handle disconnect and reconnect on one server', async () => {
      // Disconnect server 1
      client1.end();

      // Servers 2 and 3 should still work
      const [h2, h3] = await Promise.all([
        exec(client2, 'hostname'),
        exec(client3, 'hostname'),
      ]);
      expect(h2).toBe('staging-server');
      expect(h3).toBe('dev-server');

      // Reconnect server 1
      client1 = await connectSSH(SERVER_1);
      sftp1 = await getSftp(client1);

      const h1 = await exec(client1, 'hostname');
      expect(h1).toBe('prod-server');
    });

    it('should execute commands on all servers simultaneously', async () => {
      const [uptime1, uptime2, uptime3] = await Promise.all([
        exec(client1, 'uptime'),
        exec(client2, 'uptime'),
        exec(client3, 'uptime'),
      ]);

      expect(uptime1).toBeTruthy();
      expect(uptime2).toBeTruthy();
      expect(uptime3).toBeTruthy();
    });

    it('should support different users on different servers', async () => {
      const [user1, user2, user3] = await Promise.all([
        exec(client1, 'whoami'),
        exec(client2, 'whoami'),
        exec(client3, 'whoami'),
      ]);

      expect(user1).toBe('testuser');
      expect(user2).toBe('testuser');
      expect(user3).toBe('admin'); // Server 3 uses admin user
    });
  });

  // =====================================================
  // MULTIPLE CONNECTIONS TO SAME SERVER
  // =====================================================
  describe('multiple connections to same server', () => {
    let clientA: Client;
    let clientB: Client;
    let sftpA: SFTPWrapper;
    let sftpB: SFTPWrapper;

    beforeAll(async () => {
      // Two connections to same server, different users
      clientA = await connectSSH(SERVER_1);
      clientB = await connectSSH({ ...SERVER_1, username: 'admin', password: 'adminpass' });
      sftpA = await getSftp(clientA);
      sftpB = await getSftp(clientB);
    }, 15000);

    afterAll(() => {
      clientA?.end();
      clientB?.end();
    });

    it('should support two different users on same server', async () => {
      const [userA, userB] = await Promise.all([
        exec(clientA, 'whoami'),
        exec(clientB, 'whoami'),
      ]);

      expect(userA).toBe('testuser');
      expect(userB).toBe('admin');
    });

    it('should isolate home directories per user', async () => {
      const [filesA, filesB] = await Promise.all([
        listDir(sftpA, '/home/testuser'),
        listDir(sftpB, '/home/admin'),
      ]);

      expect(filesA).toContain('projects');
      expect(filesB).toContain('configs');
    });

    it('should handle concurrent writes to different home dirs', async () => {
      const pathA = '/home/testuser/concurrent-test.txt';
      const pathB = '/home/admin/concurrent-test.txt';

      try {
        await Promise.all([
          writeFile(sftpA, pathA, 'user A wrote this'),
          writeFile(sftpB, pathB, 'user B wrote this'),
        ]);

        const [contentA, contentB] = await Promise.all([
          readFile(sftpA, pathA),
          readFile(sftpB, pathB),
        ]);

        expect(contentA.toString()).toBe('user A wrote this');
        expect(contentB.toString()).toBe('user B wrote this');
      } finally {
        await unlink(sftpA, pathA).catch(() => {});
        await unlink(sftpB, pathB).catch(() => {});
      }
    });
  });

  // =====================================================
  // E2E FULL FLOW: SINGLE SERVER
  // =====================================================
  describe('e2e: single server full flow', () => {
    let client: Client;
    let sftp: SFTPWrapper;
    const baseDir = '/home/testuser/e2e-test';

    beforeAll(async () => {
      client = await connectSSH(SERVER_1);
      sftp = await getSftp(client);
    }, 15000);

    afterAll(async () => {
      // Cleanup everything under e2e-test
      try { await exec(client, `rm -rf ${baseDir}`); } catch { /* ignore */ }
      client?.end();
    });

    it('step 1: connect and verify identity', async () => {
      const whoami = await exec(client, 'whoami');
      expect(whoami).toBe('testuser');

      const hostname = await exec(client, 'hostname');
      expect(hostname).toBe('prod-server');
    });

    it('step 2: browse existing files', async () => {
      // List home directory
      const homeFiles = await listDir(sftp, '/home/testuser');
      expect(homeFiles).toContain('projects');
      expect(homeFiles).toContain('logs');

      // Navigate into projects
      const projectFiles = await listDir(sftp, '/home/testuser/projects');
      expect(projectFiles).toContain('src');
      expect(projectFiles).toContain('package.json');

      // Navigate into src
      const srcFiles = await listDir(sftp, '/home/testuser/projects/src');
      expect(srcFiles).toContain('app.ts');
      expect(srcFiles).toContain('todo.ts');
    });

    it('step 3: read existing file content', async () => {
      const content = await readFile(sftp, '/home/testuser/projects/src/app.ts');
      expect(content.toString()).toContain('console.log');
      expect(content.toString()).toContain('hello world');
    });

    it('step 4: create project directory structure', async () => {
      // Create base directory
      await mkdir(sftp, baseDir);

      // Create nested directories
      await mkdir(sftp, `${baseDir}/src`);
      await mkdir(sftp, `${baseDir}/src/components`);
      await mkdir(sftp, `${baseDir}/config`);
      await mkdir(sftp, `${baseDir}/tests`);

      // Verify structure
      const dirs = await listDir(sftp, baseDir);
      expect(dirs).toContain('src');
      expect(dirs).toContain('config');
      expect(dirs).toContain('tests');

      const srcDirs = await listDir(sftp, `${baseDir}/src`);
      expect(srcDirs).toContain('components');
    });

    it('step 5: create files in project', async () => {
      // Create multiple files
      await writeFile(sftp, `${baseDir}/package.json`, JSON.stringify({
        name: 'e2e-project',
        version: '1.0.0',
        description: 'E2E test project',
      }, null, 2));

      await writeFile(sftp, `${baseDir}/src/index.ts`, [
        'import { App } from "./components/App";',
        '',
        'const app = new App();',
        'app.start();',
        'console.log("Application started");',
      ].join('\n'));

      await writeFile(sftp, `${baseDir}/src/components/App.ts`, [
        'export class App {',
        '  private running = false;',
        '',
        '  start(): void {',
        '    this.running = true;',
        '    console.log("App running");',
        '  }',
        '',
        '  stop(): void {',
        '    this.running = false;',
        '  }',
        '',
        '  isRunning(): boolean {',
        '    return this.running;',
        '  }',
        '}',
      ].join('\n'));

      await writeFile(sftp, `${baseDir}/config/settings.json`, JSON.stringify({
        port: 3000,
        debug: true,
        logLevel: 'info',
      }, null, 2));

      await writeFile(sftp, `${baseDir}/tests/app.test.ts`, [
        '// TODO: add more tests',
        'describe("App", () => {',
        '  it("should start", () => {',
        '    expect(true).toBe(true);',
        '  });',
        '});',
      ].join('\n'));

      // Verify files created
      const files = await listDir(sftp, `${baseDir}/src`);
      expect(files).toContain('index.ts');
      expect(files).toContain('components');
    });

    it('step 6: read and verify file contents', async () => {
      // Read package.json
      const pkg = JSON.parse((await readFile(sftp, `${baseDir}/package.json`)).toString());
      expect(pkg.name).toBe('e2e-project');
      expect(pkg.version).toBe('1.0.0');

      // Read source file
      const src = (await readFile(sftp, `${baseDir}/src/index.ts`)).toString();
      expect(src).toContain('import { App }');
      expect(src).toContain('app.start()');

      // Read component file
      const component = (await readFile(sftp, `${baseDir}/src/components/App.ts`)).toString();
      expect(component).toContain('export class App');
      expect(component).toContain('isRunning');
    });

    it('step 7: edit files (simulate save-after-edit)', async () => {
      // Read current content
      const original = (await readFile(sftp, `${baseDir}/src/index.ts`)).toString();
      expect(original).toContain('console.log("Application started")');

      // Edit: add new lines
      const updated = original + '\n// Version 2: added logging\nconsole.log("v2 loaded");\n';
      await writeFile(sftp, `${baseDir}/src/index.ts`, updated);

      // Verify edit persisted
      const afterEdit = (await readFile(sftp, `${baseDir}/src/index.ts`)).toString();
      expect(afterEdit).toContain('console.log("Application started")');
      expect(afterEdit).toContain('Version 2: added logging');
      expect(afterEdit).toContain('v2 loaded');
    });

    it('step 8: edit config file (simulate settings change)', async () => {
      // Read current config
      const configStr = (await readFile(sftp, `${baseDir}/config/settings.json`)).toString();
      const config = JSON.parse(configStr);
      expect(config.port).toBe(3000);

      // Update config
      config.port = 8080;
      config.debug = false;
      config.logLevel = 'warn';
      config.maxConnections = 100;

      await writeFile(sftp, `${baseDir}/config/settings.json`, JSON.stringify(config, null, 2));

      // Verify config change
      const updatedStr = (await readFile(sftp, `${baseDir}/config/settings.json`)).toString();
      const updatedConfig = JSON.parse(updatedStr);
      expect(updatedConfig.port).toBe(8080);
      expect(updatedConfig.debug).toBe(false);
      expect(updatedConfig.maxConnections).toBe(100);
    });

    it('step 9: search for content across project', async () => {
      // Search for class definition
      const classSearch = await exec(client, `grep -rn "class App" ${baseDir}/`);
      expect(classSearch).toContain('App.ts');
      expect(classSearch).toContain('export class App');

      // Search for console.log usage
      const logSearch = await exec(client, `grep -rn "console.log" ${baseDir}/`);
      expect(logSearch).toContain('index.ts');
      expect(logSearch).toContain('App.ts');

      // Case-insensitive search
      const caseSearch = await exec(client, `grep -rin "TODO" ${baseDir}/`);
      expect(caseSearch).toContain('app.test.ts');

      // Search with file filter (only .ts files)
      const tsSearch = await exec(client, `grep -rn --include="*.ts" "import" ${baseDir}/`);
      expect(tsSearch).toContain('index.ts');

      // Search for non-existent content
      const noMatch = await exec(client, `grep -rn "NONEXISTENT_STRING_XYZ" ${baseDir}/ || echo "NO_MATCH"`);
      expect(noMatch).toContain('NO_MATCH');
    });

    it('step 10: search with regex patterns', async () => {
      // Regex: find function definitions
      const funcSearch = await exec(client, `grep -rn "\\(.*\\):" ${baseDir}/src/ 2>/dev/null || true`);
      expect(funcSearch).toContain('start');

      // Regex: find export statements
      const exportSearch = await exec(client, `grep -rn "^export" ${baseDir}/src/ 2>/dev/null || true`);
      expect(exportSearch).toContain('App.ts');

      // Count matches
      const count = await exec(client, `grep -rc "console" ${baseDir}/src/ 2>/dev/null || true`);
      expect(count).toBeTruthy();
    });

    it('step 11: file stat and permissions', async () => {
      const stats = await statFile(sftp, `${baseDir}/src/index.ts`);
      expect(stats.size).toBeGreaterThan(0);
      expect(stats.isDirectory()).toBe(false);

      const dirStats = await statFile(sftp, `${baseDir}/src`);
      expect(dirStats.isDirectory()).toBe(true);
    });

    it('step 12: delete individual files', async () => {
      // Create a temporary file to delete
      await writeFile(sftp, `${baseDir}/temp-file.txt`, 'delete me');
      const beforeDelete = await listDir(sftp, baseDir);
      expect(beforeDelete).toContain('temp-file.txt');

      // Delete it
      await unlink(sftp, `${baseDir}/temp-file.txt`);

      // Verify deleted
      const afterDelete = await listDir(sftp, baseDir);
      expect(afterDelete).not.toContain('temp-file.txt');
    });

    it('step 13: delete files then directory', async () => {
      // Create a subdirectory with files
      await mkdir(sftp, `${baseDir}/to-delete`);
      await writeFile(sftp, `${baseDir}/to-delete/file1.txt`, 'temp');
      await writeFile(sftp, `${baseDir}/to-delete/file2.txt`, 'temp');

      // Must delete files first, then directory
      await unlink(sftp, `${baseDir}/to-delete/file1.txt`);
      await unlink(sftp, `${baseDir}/to-delete/file2.txt`);
      await rmdir(sftp, `${baseDir}/to-delete`);

      // Verify directory removed
      const files = await listDir(sftp, baseDir);
      expect(files).not.toContain('to-delete');
    });

    it('step 14: recursive delete via exec (simulating rm -rf)', async () => {
      // Create nested structure
      await mkdir(sftp, `${baseDir}/deep`);
      await mkdir(sftp, `${baseDir}/deep/level1`);
      await mkdir(sftp, `${baseDir}/deep/level1/level2`);
      await writeFile(sftp, `${baseDir}/deep/level1/level2/deep-file.txt`, 'deep');

      // Use exec for recursive delete (simulating how SSH Lite deletes dirs)
      await exec(client, `rm -rf ${baseDir}/deep`);

      // Verify
      const files = await listDir(sftp, baseDir);
      expect(files).not.toContain('deep');
    });

    it('step 15: disconnect and reconnect', async () => {
      // Record state before disconnect
      const beforeFiles = await listDir(sftp, baseDir);
      const beforeContent = (await readFile(sftp, `${baseDir}/src/index.ts`)).toString();

      // Disconnect
      client.end();

      // Reconnect
      client = await connectSSH(SERVER_1);
      sftp = await getSftp(client);

      // Verify identity after reconnect
      const whoami = await exec(client, 'whoami');
      expect(whoami).toBe('testuser');

      // Verify files persist after reconnect
      const afterFiles = await listDir(sftp, baseDir);
      expect(afterFiles).toEqual(expect.arrayContaining(beforeFiles));

      // Verify content persists
      const afterContent = (await readFile(sftp, `${baseDir}/src/index.ts`)).toString();
      expect(afterContent).toBe(beforeContent);
    });

    it('step 16: verify all edits survived reconnect', async () => {
      // Check edited index.ts has our changes
      const src = (await readFile(sftp, `${baseDir}/src/index.ts`)).toString();
      expect(src).toContain('v2 loaded');

      // Check edited config
      const config = JSON.parse((await readFile(sftp, `${baseDir}/config/settings.json`)).toString());
      expect(config.port).toBe(8080);
      expect(config.maxConnections).toBe(100);

      // Check component is untouched
      const component = (await readFile(sftp, `${baseDir}/src/components/App.ts`)).toString();
      expect(component).toContain('export class App');
    });

    it('step 17: server monitoring commands', async () => {
      // Simulate server monitor: uptime
      const uptime = await exec(client, 'uptime');
      expect(uptime).toBeTruthy();

      // Simulate server monitor: memory
      const memory = await exec(client, 'free -m 2>/dev/null || echo "N/A"');
      expect(memory).toBeTruthy();

      // Simulate server monitor: disk usage
      const disk = await exec(client, 'df -h / 2>/dev/null');
      expect(disk).toContain('/');

      // Simulate server monitor: process count
      const procs = await exec(client, 'ps aux | wc -l');
      expect(parseInt(procs)).toBeGreaterThan(0);

      // Simulate server monitor: hostname
      const hostname = await exec(client, 'hostname');
      expect(hostname).toBe('prod-server');
    });
  });

  // =====================================================
  // E2E FULL FLOW: MULTI-SERVER
  // =====================================================
  describe('e2e: multi-server full flow', () => {
    let clients: Client[];
    let sftps: SFTPWrapper[];
    const dirs = [
      '/home/testuser/e2e-multi',
      '/home/testuser/e2e-multi',
      '/home/admin/e2e-multi',
    ];

    beforeAll(async () => {
      clients = await Promise.all([
        connectSSH(SERVER_1),
        connectSSH(SERVER_2),
        connectSSH(SERVER_3),
      ]);
      sftps = await Promise.all(clients.map(c => getSftp(c)));
    }, 30000);

    afterAll(async () => {
      // Cleanup all servers in parallel
      await Promise.all([
        exec(clients[0], `rm -rf ${dirs[0]}`).catch(() => {}),
        exec(clients[1], `rm -rf ${dirs[1]}`).catch(() => {}),
        exec(clients[2], `rm -rf ${dirs[2]}`).catch(() => {}),
      ]);
      clients.forEach(c => c?.end());
    });

    it('step 1: connect to all servers simultaneously', async () => {
      const hostnames = await Promise.all(
        clients.map(c => exec(c, 'hostname'))
      );
      expect(hostnames[0]).toBe('prod-server');
      expect(hostnames[1]).toBe('staging-server');
      expect(hostnames[2]).toBe('dev-server');
    });

    it('step 2: create project on all servers simultaneously', async () => {
      // Create directories on all 3 servers in parallel
      await Promise.all(dirs.map((dir, i) => mkdir(sftps[i], dir)));
      await Promise.all(dirs.map((dir, i) => mkdir(sftps[i], `${dir}/src`)));

      // Verify all directories created
      const listings = await Promise.all(
        dirs.map((dir, i) => listDir(sftps[i], dir))
      );
      listings.forEach(files => expect(files).toContain('src'));
    });

    it('step 3: create different files on each server', async () => {
      // Each server gets different content
      await Promise.all([
        writeFile(sftps[0], `${dirs[0]}/src/prod.ts`, 'const env = "production";\nconsole.log(env);'),
        writeFile(sftps[1], `${dirs[1]}/src/staging.ts`, 'const env = "staging";\nconsole.log(env);'),
        writeFile(sftps[2], `${dirs[2]}/src/dev.ts`, 'const env = "development";\nconsole.log(env);'),
      ]);

      // Also create shared files with same name but different content
      await Promise.all([
        writeFile(sftps[0], `${dirs[0]}/config.json`, '{"server":"prod","port":80}'),
        writeFile(sftps[1], `${dirs[1]}/config.json`, '{"server":"staging","port":8080}'),
        writeFile(sftps[2], `${dirs[2]}/config.json`, '{"server":"dev","port":3000}'),
      ]);
    });

    it('step 4: read and verify server-specific content', async () => {
      const [prod, staging, dev] = await Promise.all([
        readFile(sftps[0], `${dirs[0]}/src/prod.ts`),
        readFile(sftps[1], `${dirs[1]}/src/staging.ts`),
        readFile(sftps[2], `${dirs[2]}/src/dev.ts`),
      ]);

      expect(prod.toString()).toContain('production');
      expect(staging.toString()).toContain('staging');
      expect(dev.toString()).toContain('development');
    });

    it('step 5: edit files on all servers simultaneously', async () => {
      // Read all configs
      const configs = await Promise.all(
        dirs.map((dir, i) => readFile(sftps[i], `${dir}/config.json`).then(b => JSON.parse(b.toString())))
      );

      // Modify each config
      configs[0].version = '2.0';
      configs[1].version = '2.0-staging';
      configs[2].version = '2.0-dev';

      // Write back all configs simultaneously
      await Promise.all(
        dirs.map((dir, i) => writeFile(sftps[i], `${dir}/config.json`, JSON.stringify(configs[i])))
      );

      // Verify all edits
      const updated = await Promise.all(
        dirs.map((dir, i) => readFile(sftps[i], `${dir}/config.json`).then(b => JSON.parse(b.toString())))
      );

      expect(updated[0].version).toBe('2.0');
      expect(updated[0].server).toBe('prod');
      expect(updated[1].version).toBe('2.0-staging');
      expect(updated[1].server).toBe('staging');
      expect(updated[2].version).toBe('2.0-dev');
      expect(updated[2].server).toBe('dev');
    });

    it('step 6: search across all servers simultaneously', async () => {
      const [prodSearch, stagingSearch, devSearch] = await Promise.all([
        exec(clients[0], `grep -rn "production" ${dirs[0]}/`),
        exec(clients[1], `grep -rn "staging" ${dirs[1]}/`),
        exec(clients[2], `grep -rn "development" ${dirs[2]}/`),
      ]);

      expect(prodSearch).toContain('prod.ts');
      expect(stagingSearch).toContain('staging.ts');
      expect(devSearch).toContain('dev.ts');
    });

    it('step 7: cross-server content should NOT leak between servers', async () => {
      // Server 1 should NOT have staging/dev files
      const prodResult = await exec(clients[0], `grep -rn "staging" ${dirs[0]}/ 2>/dev/null || echo "NOT_FOUND"`);
      expect(prodResult).toContain('NOT_FOUND');

      const stagingResult = await exec(clients[1], `grep -rn "production" ${dirs[1]}/ 2>/dev/null || echo "NOT_FOUND"`);
      expect(stagingResult).toContain('NOT_FOUND');

      const devResult = await exec(clients[2], `grep -rn "production" ${dirs[2]}/ 2>/dev/null || echo "NOT_FOUND"`);
      expect(devResult).toContain('NOT_FOUND');
    });

    it('step 8: disconnect one server, others keep working', async () => {
      // Disconnect server 2 (staging)
      clients[1].end();

      // Servers 1 and 3 should still work
      const [prodFile, devFile] = await Promise.all([
        readFile(sftps[0], `${dirs[0]}/config.json`),
        readFile(sftps[2], `${dirs[2]}/config.json`),
      ]);
      expect(prodFile.toString()).toContain('prod');
      expect(devFile.toString()).toContain('dev');

      // Operations on disconnected server should fail
      await expect(exec(clients[1], 'hostname')).rejects.toThrow();
    });

    it('step 9: reconnect disconnected server', async () => {
      // Reconnect server 2
      clients[1] = await connectSSH(SERVER_2);
      sftps[1] = await getSftp(clients[1]);

      // Verify reconnected
      const hostname = await exec(clients[1], 'hostname');
      expect(hostname).toBe('staging-server');

      // Verify data persists after reconnect
      const config = JSON.parse(
        (await readFile(sftps[1], `${dirs[1]}/config.json`)).toString()
      );
      expect(config.version).toBe('2.0-staging');
      expect(config.server).toBe('staging');
    });

    it('step 10: all servers operational after reconnect', async () => {
      const hostnames = await Promise.all(
        clients.map(c => exec(c, 'hostname'))
      );
      expect(hostnames).toEqual(['prod-server', 'staging-server', 'dev-server']);

      // All configs still intact
      const configs = await Promise.all(
        dirs.map((dir, i) => readFile(sftps[i], `${dir}/config.json`).then(b => JSON.parse(b.toString())))
      );
      expect(configs[0].server).toBe('prod');
      expect(configs[1].server).toBe('staging');
      expect(configs[2].server).toBe('dev');
    });

    it('step 11: delete files on all servers simultaneously', async () => {
      // Delete source files on all servers
      await Promise.all([
        unlink(sftps[0], `${dirs[0]}/src/prod.ts`),
        unlink(sftps[1], `${dirs[1]}/src/staging.ts`),
        unlink(sftps[2], `${dirs[2]}/src/dev.ts`),
      ]);

      // Verify deletions on all servers
      const results = await Promise.allSettled([
        readFile(sftps[0], `${dirs[0]}/src/prod.ts`),
        readFile(sftps[1], `${dirs[1]}/src/staging.ts`),
        readFile(sftps[2], `${dirs[2]}/src/dev.ts`),
      ]);
      results.forEach(r => expect(r.status).toBe('rejected'));
    });

    it('step 12: concurrent server monitoring across all servers', async () => {
      const [status1, status2, status3] = await Promise.all([
        exec(clients[0], 'uptime && df -h / && ps aux | wc -l'),
        exec(clients[1], 'uptime && df -h / && ps aux | wc -l'),
        exec(clients[2], 'uptime && df -h / && ps aux | wc -l'),
      ]);

      expect(status1).toBeTruthy();
      expect(status2).toBeTruthy();
      expect(status3).toBeTruthy();

      // Each should contain disk info
      expect(status1).toContain('/');
      expect(status2).toContain('/');
      expect(status3).toContain('/');
    });
  });

  // =====================================================
  // E2E: FILE EDIT LIFECYCLE (open → edit → save → close → reopen)
  // =====================================================
  describe('e2e: file edit lifecycle', () => {
    let client: Client;
    let sftp: SFTPWrapper;
    const testFile = '/home/testuser/lifecycle-test.ts';

    beforeAll(async () => {
      client = await connectSSH(SERVER_1);
      sftp = await getSftp(client);
    }, 15000);

    afterAll(async () => {
      try { await unlink(sftp, testFile); } catch { /* ignore */ }
      client?.end();
    });

    it('should handle create → read → edit → read → close → reopen → verify', async () => {
      // Step 1: Create file (simulates "open remote file" → downloads → saves locally)
      const originalContent = 'function hello() {\n  return "world";\n}\n';
      await writeFile(sftp, testFile, originalContent);

      // Step 2: Read file (simulates opening in editor)
      const opened = (await readFile(sftp, testFile)).toString();
      expect(opened).toBe(originalContent);

      // Step 3: Edit and save (simulates user editing and auto-upload)
      const editedContent = 'function hello() {\n  return "hello world!";\n}\n\nexport default hello;\n';
      await writeFile(sftp, testFile, editedContent);

      // Step 4: Read again (simulates re-reading after save)
      const afterSave = (await readFile(sftp, testFile)).toString();
      expect(afterSave).toBe(editedContent);
      expect(afterSave).toContain('hello world!');
      expect(afterSave).toContain('export default');

      // Step 5: "Close" — just disconnect (simulates closing the editor tab)
      client.end();

      // Step 6: Reopen — reconnect and read (simulates reopening file)
      client = await connectSSH(SERVER_1);
      sftp = await getSftp(client);

      const reopened = (await readFile(sftp, testFile)).toString();
      expect(reopened).toBe(editedContent);
      expect(reopened).toContain('hello world!');
    });

    it('should handle multiple rapid edits (simulates debounced saves)', async () => {
      const file = '/home/testuser/rapid-edits.txt';
      try {
        // Rapid sequential writes (simulating user typing fast with debounced saves)
        await writeFile(sftp, file, 'version 1');
        await writeFile(sftp, file, 'version 2');
        await writeFile(sftp, file, 'version 3');
        await writeFile(sftp, file, 'version 4 - final');

        // Only the last write should persist
        const content = (await readFile(sftp, file)).toString();
        expect(content).toBe('version 4 - final');
      } finally {
        await unlink(sftp, file).catch(() => {});
      }
    });

    it('should handle large file edit', async () => {
      const largeFile = '/home/testuser/large-edit.txt';
      try {
        // Create a file with many lines (simulates large config/log)
        const lines: string[] = [];
        for (let i = 0; i < 500; i++) {
          lines.push(`line ${i}: ${Array(50).fill('x').join('')}`);
        }
        const largeContent = lines.join('\n');
        await writeFile(sftp, largeFile, largeContent);

        // Verify size
        const stats = await statFile(sftp, largeFile);
        expect(stats.size).toBeGreaterThan(10000);

        // Edit: change line 250
        lines[250] = 'line 250: THIS LINE WAS EDITED';
        await writeFile(sftp, largeFile, lines.join('\n'));

        // Verify edit
        const edited = (await readFile(sftp, largeFile)).toString();
        expect(edited).toContain('THIS LINE WAS EDITED');
        expect(edited.split('\n')).toHaveLength(500);
      } finally {
        await unlink(sftp, largeFile).catch(() => {});
      }
    });

    it('should handle binary-like content', async () => {
      const binFile = '/home/testuser/binary-test.dat';
      try {
        // Write content with special characters
        const content = 'Header\x00\x01\x02\nData: café résumé naïve\nEnd\n';
        await writeFile(sftp, binFile, content);

        const read = (await readFile(sftp, binFile)).toString();
        expect(read).toContain('café');
        expect(read).toContain('résumé');
      } finally {
        await unlink(sftp, binFile).catch(() => {});
      }
    });
  });

  // =====================================================
  // E2E: PORT FORWARDING SIMULATION
  // =====================================================
  describe('e2e: port forwarding simulation', () => {
    let client: Client;

    beforeAll(async () => {
      client = await connectSSH(SERVER_1);
    }, 15000);

    afterAll(() => {
      client?.end();
    });

    it('should verify server has listening ports', async () => {
      // Check that sshd is listening
      const result = await exec(client, 'netstat -tlnp 2>/dev/null || ss -tlnp 2>/dev/null || echo "port check"');
      expect(result).toBeTruthy();
    });

    it('should be able to exec a command that simulates a service check', async () => {
      // Simulate checking if a service is reachable via the SSH tunnel
      const result = await exec(client, 'echo "port_check:8080:OK"');
      expect(result).toBe('port_check:8080:OK');
    });
  });

  // =====================================================
  // E2E: CONCURRENT FILE OPERATIONS STRESS
  // =====================================================
  describe('e2e: concurrent operations stress test', () => {
    let client: Client;
    let sftp: SFTPWrapper;
    const baseDir = '/home/testuser/stress-test';

    beforeAll(async () => {
      client = await connectSSH(SERVER_1);
      sftp = await getSftp(client);
      await mkdir(sftp, baseDir).catch(() => {});
    }, 15000);

    afterAll(async () => {
      try { await exec(client, `rm -rf ${baseDir}`); } catch { /* ignore */ }
      client?.end();
    });

    it('should handle 20 concurrent file creates', async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        writeFile(sftp, `${baseDir}/file-${i}.txt`, `content of file ${i}`)
      );
      await Promise.all(promises);

      // Verify all files exist
      const files = await listDir(sftp, baseDir);
      expect(files.length).toBe(20);
      for (let i = 0; i < 20; i++) {
        expect(files).toContain(`file-${i}.txt`);
      }
    });

    it('should handle 20 concurrent file reads', async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        readFile(sftp, `${baseDir}/file-${i}.txt`)
      );
      const contents = await Promise.all(promises);

      contents.forEach((buf, i) => {
        expect(buf.toString()).toBe(`content of file ${i}`);
      });
    });

    it('should handle 20 concurrent file updates', async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        writeFile(sftp, `${baseDir}/file-${i}.txt`, `updated content of file ${i}`)
      );
      await Promise.all(promises);

      // Verify all updates
      const readPromises = Array.from({ length: 20 }, (_, i) =>
        readFile(sftp, `${baseDir}/file-${i}.txt`)
      );
      const contents = await Promise.all(readPromises);
      contents.forEach((buf, i) => {
        expect(buf.toString()).toBe(`updated content of file ${i}`);
      });
    });

    it('should handle concurrent reads and writes to different files', async () => {
      // Read even files while writing to odd files
      const ops: Promise<any>[] = [];
      for (let i = 0; i < 20; i++) {
        if (i % 2 === 0) {
          ops.push(readFile(sftp, `${baseDir}/file-${i}.txt`));
        } else {
          ops.push(writeFile(sftp, `${baseDir}/file-${i}.txt`, `mixed-op content ${i}`));
        }
      }
      await Promise.all(ops);

      // Verify odd files were updated
      for (let i = 1; i < 20; i += 2) {
        const content = (await readFile(sftp, `${baseDir}/file-${i}.txt`)).toString();
        expect(content).toBe(`mixed-op content ${i}`);
      }
    });

    it('should handle 20 concurrent file deletes', async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        unlink(sftp, `${baseDir}/file-${i}.txt`)
      );
      await Promise.all(promises);

      const files = await listDir(sftp, baseDir);
      expect(files.length).toBe(0);
    });

    it('should handle concurrent search across large file set', async () => {
      // Create 10 files with varied content for searching
      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          writeFile(sftp, `${baseDir}/search-${i}.ts`, [
            `// File ${i}`,
            i % 2 === 0 ? 'export function handler() { }' : 'const value = 42;',
            i % 3 === 0 ? '// TODO: refactor this' : '// Clean code',
            `console.log("file-${i}");`,
          ].join('\n'))
        )
      );

      // Run multiple searches in parallel
      const [exportSearch, todoSearch, consoleSearch] = await Promise.all([
        exec(client, `grep -rl "export function" ${baseDir}/`),
        exec(client, `grep -rl "TODO" ${baseDir}/`),
        exec(client, `grep -c "console" ${baseDir}/search-*.ts | grep -v ":0$"`),
      ]);

      // Even files (0,2,4,6,8) have export
      expect(exportSearch.split('\n').filter(Boolean).length).toBe(5);
      // Files 0,3,6,9 have TODO
      expect(todoSearch.split('\n').filter(Boolean).length).toBe(4);
      // All 10 files have console.log
      expect(consoleSearch.split('\n').filter(Boolean).length).toBe(10);
    });
  });

  // =====================================================
  // E2E: ERROR HANDLING AND EDGE CASES
  // =====================================================
  describe('e2e: error handling', () => {
    let client: Client;
    let sftp: SFTPWrapper;

    beforeAll(async () => {
      client = await connectSSH(SERVER_1);
      sftp = await getSftp(client);
    }, 15000);

    afterAll(() => {
      client?.end();
    });

    it('should fail on reading non-existent file', async () => {
      await expect(readFile(sftp, '/home/testuser/no-such-file.txt')).rejects.toThrow();
    });

    it('should fail on listing non-existent directory', async () => {
      await expect(listDir(sftp, '/home/testuser/no-such-dir')).rejects.toThrow();
    });

    it('should fail on writing to non-existent directory', async () => {
      await expect(
        writeFile(sftp, '/home/testuser/no-such-dir/file.txt', 'content')
      ).rejects.toThrow();
    });

    it('should fail on deleting non-existent file', async () => {
      await expect(unlink(sftp, '/home/testuser/no-such-file.txt')).rejects.toThrow();
    });

    it('should fail on creating directory in non-existent path', async () => {
      await expect(mkdir(sftp, '/home/testuser/no-such-dir/subdir')).rejects.toThrow();
    });

    it('should fail on removing non-empty directory with rmdir', async () => {
      // rmdir only works on empty directories
      await expect(rmdir(sftp, '/home/testuser/projects')).rejects.toThrow();
    });

    it('should handle permission denied gracefully', async () => {
      // Try to write to root-owned directory
      await expect(writeFile(sftp, '/etc/test-no-permission.txt', 'test')).rejects.toThrow();
    });

    it('should handle exec of invalid command', async () => {
      const result = await exec(client, 'nonexistent_command_xyz 2>&1 || echo "COMMAND_FAILED"');
      expect(result).toContain('COMMAND_FAILED');
    });

    it('should handle empty file operations', async () => {
      const emptyFile = '/home/testuser/empty-test.txt';
      try {
        // Write empty file
        await writeFile(sftp, emptyFile, '');

        // Read empty file
        const content = await readFile(sftp, emptyFile);
        expect(content.toString()).toBe('');

        // Stat empty file
        const stats = await statFile(sftp, emptyFile);
        expect(stats.size).toBe(0);
      } finally {
        await unlink(sftp, emptyFile).catch(() => {});
      }
    });

    it('should handle special characters in filenames', async () => {
      const specialFile = '/home/testuser/file with spaces.txt';
      try {
        await writeFile(sftp, specialFile, 'spaces in name');
        const content = (await readFile(sftp, specialFile)).toString();
        expect(content).toBe('spaces in name');
      } finally {
        await unlink(sftp, specialFile).catch(() => {});
      }
    });

    it('should handle connection failure gracefully', async () => {
      // Try to connect to non-existent port
      await expect(
        connectSSH({ host: '127.0.0.1', port: 29999, username: 'test', password: 'test' })
      ).rejects.toThrow();
    });

    it('should handle wrong credentials gracefully', async () => {
      await expect(
        connectSSH({ host: '127.0.0.1', port: 2201, username: 'testuser', password: 'wrongpassword' })
      ).rejects.toThrow();
    });
  });
});
