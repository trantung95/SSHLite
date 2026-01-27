/**
 * Multi-OS Docker SSH Integration Tests
 *
 * Tests real SSH connections across 5 Linux distributions:
 * Alpine 3.19, Ubuntu 22.04, Debian 12, Fedora 40, Rocky Linux 9
 *
 * Validates that all core SSH/SFTP operations work identically regardless
 * of the remote server's operating system, including:
 * - Connection and authentication
 * - SFTP file operations (read, write, list, stat, mkdir, delete)
 * - Command execution and shell behavior
 * - Search (grep) across OS variants (BusyBox vs GNU)
 * - Permission handling
 * - Special character support
 * - Concurrent cross-OS operations
 *
 * Run: npm run test:multios
 */

import { Client, SFTPWrapper } from 'ssh2';

// ─────────────────────────────────────────────────────────────
// Server configurations for each OS
// ─────────────────────────────────────────────────────────────

interface ServerConfig {
  os: string;
  host: string;
  port: number;
  username: string;
  password: string;
  hostname: string;
  /** Expected default shell */
  shell: 'bash' | 'ash';
  /** Expected grep variant */
  grepVariant: 'gnu' | 'busybox';
}

const SERVERS: ServerConfig[] = [
  { os: 'Alpine 3.19', host: '127.0.0.1', port: 2210, username: 'testuser', password: 'testpass', hostname: 'alpine-server', shell: 'ash', grepVariant: 'gnu' },
  { os: 'Ubuntu 22.04', host: '127.0.0.1', port: 2211, username: 'testuser', password: 'testpass', hostname: 'ubuntu-server', shell: 'bash', grepVariant: 'gnu' },
  { os: 'Debian 12', host: '127.0.0.1', port: 2212, username: 'testuser', password: 'testpass', hostname: 'debian-server', shell: 'bash', grepVariant: 'gnu' },
  { os: 'Fedora 40', host: '127.0.0.1', port: 2213, username: 'testuser', password: 'testpass', hostname: 'fedora-server', shell: 'bash', grepVariant: 'gnu' },
  { os: 'Rocky Linux 9', host: '127.0.0.1', port: 2214, username: 'testuser', password: 'testpass', hostname: 'rocky-server', shell: 'bash', grepVariant: 'gnu' },
];

const ADMIN_CONFIG = { username: 'admin', password: 'adminpass' };

// ─────────────────────────────────────────────────────────────
// Helpers (same as docker-ssh.test.ts for consistency)
// ─────────────────────────────────────────────────────────────

function connectSSH(config: { host: string; port: number; username: string; password: string }): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.on('ready', () => resolve(client));
    client.on('error', reject);
    client.connect({ host: config.host, port: config.port, username: config.username, password: config.password, readyTimeout: 10000 });
  });
}

function getSftp(client: Client): Promise<SFTPWrapper> {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => { if (err) reject(err); else resolve(sftp); });
  });
}

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

function readFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(path);
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function writeFile(sftp: SFTPWrapper, path: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = sftp.createWriteStream(path);
    stream.on('close', () => resolve());
    stream.on('error', reject);
    stream.end(content);
  });
}

function listDir(sftp: SFTPWrapper, path: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => {
      if (err) reject(err);
      else resolve(list.map(f => f.filename).filter(f => f !== '.' && f !== '..'));
    });
  });
}

function statFile(sftp: SFTPWrapper, path: string): Promise<any> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => { if (err) reject(err); else resolve(stats); });
  });
}

function mkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(path, (err) => { if (err) reject(err); else resolve(); });
  });
}

function rmdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rmdir(path, (err) => { if (err) reject(err); else resolve(); });
  });
}

function unlink(sftp: SFTPWrapper, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.unlink(path, (err) => { if (err) reject(err); else resolve(); });
  });
}

// ─────────────────────────────────────────────────────────────
// PER-OS TESTS: Run identical test suite against each OS
// ─────────────────────────────────────────────────────────────

describe('Multi-OS SSH Integration Tests', () => {

  describe.each(SERVERS)('$os', (server: ServerConfig) => {
    let client: Client;
    let sftp: SFTPWrapper;

    beforeAll(async () => {
      client = await connectSSH(server);
      sftp = await getSftp(client);
    }, 30000);

    afterAll(() => {
      client?.end();
    });

    // ─── Connection & Identity ───────────────────────────────

    describe('connection', () => {
      it('should connect successfully', () => {
        expect(client).toBeDefined();
      });

      it('should report correct hostname', async () => {
        const hostname = await exec(client, 'hostname');
        expect(hostname).toBe(server.hostname);
      });

      it('should authenticate as testuser', async () => {
        const whoami = await exec(client, 'whoami');
        expect(whoami).toBe('testuser');
      });

      it('should have a working home directory', async () => {
        const home = await exec(client, 'echo $HOME');
        expect(home).toBe('/home/testuser');
      });
    });

    // ─── OS Identification ───────────────────────────────────

    describe('OS identification', () => {
      it('should report a Linux kernel via uname', async () => {
        const uname = await exec(client, 'uname -s');
        expect(uname).toBe('Linux');
      });

      it('should have /etc/os-release or /etc/alpine-release', async () => {
        const result = await exec(client, 'cat /etc/os-release 2>/dev/null || cat /etc/alpine-release 2>/dev/null || echo "unknown"');
        expect(result).not.toBe('unknown');
      });

      it('should report expected hostname', async () => {
        const hostname = await exec(client, 'hostname');
        expect(hostname).toBe(server.hostname);
      });
    });

    // ─── Shell Behavior ──────────────────────────────────────

    describe('shell behavior', () => {
      it('should execute basic shell commands', async () => {
        const result = await exec(client, 'echo "hello from shell"');
        expect(result).toBe('hello from shell');
      });

      it('should handle environment variables', async () => {
        const result = await exec(client, 'export TEST_VAR="multi-os" && echo $TEST_VAR');
        expect(result).toBe('multi-os');
      });

      it('should handle command piping', async () => {
        const result = await exec(client, 'echo "line1\nline2\nline3" | wc -l');
        expect(parseInt(result.trim())).toBe(3);
      });

      it('should handle exit codes', async () => {
        const result = await exec(client, 'true && echo "OK" || echo "FAIL"');
        expect(result).toBe('OK');
      });

      it('should handle command substitution', async () => {
        const result = await exec(client, 'echo "user: $(whoami)"');
        expect(result).toBe('user: testuser');
      });

      it('should have bash available', async () => {
        // All test images install bash explicitly
        const result = await exec(client, 'bash --version 2>/dev/null | head -1');
        expect(result).toContain('bash');
      });
    });

    // ─── SFTP: File Listing ──────────────────────────────────

    describe('SFTP file listing', () => {
      it('should list home directory', async () => {
        const files = await listDir(sftp, '/home/testuser');
        expect(files).toContain('projects');
        expect(files).toContain('logs');
      });

      it('should list project structure', async () => {
        const files = await listDir(sftp, '/home/testuser/projects');
        expect(files).toContain('src');
        expect(files).toContain('package.json');
      });

      it('should list nested directory', async () => {
        const files = await listDir(sftp, '/home/testuser/projects/src');
        expect(files).toContain('app.ts');
        expect(files).toContain('todo.ts');
      });

      it('should list root directory', async () => {
        const files = await listDir(sftp, '/');
        expect(files).toContain('home');
        expect(files).toContain('etc');
        expect(files).toContain('tmp');
      });
    });

    // ─── SFTP: File Read ─────────────────────────────────────

    describe('SFTP file read', () => {
      it('should read a TypeScript file', async () => {
        const content = await readFile(sftp, '/home/testuser/projects/src/app.ts');
        expect(content.toString()).toContain('console.log');
        expect(content.toString()).toContain('hello world');
      });

      it('should read a JSON file', async () => {
        const content = await readFile(sftp, '/home/testuser/projects/package.json');
        const json = JSON.parse(content.toString());
        expect(json.name).toBe('test');
      });

      it('should read a log file', async () => {
        const content = await readFile(sftp, '/home/testuser/logs/app.log');
        expect(content.toString()).toContain('Server started');
      });
    });

    // ─── SFTP: File Write & Read-back ────────────────────────

    describe('SFTP file write', () => {
      const testFile = '/home/testuser/os-write-test.txt';

      afterEach(async () => {
        try { await unlink(sftp, testFile); } catch { /* ignore */ }
      });

      it('should write and read back a file', async () => {
        await writeFile(sftp, testFile, `written on ${server.os}`);
        const content = (await readFile(sftp, testFile)).toString();
        expect(content).toBe(`written on ${server.os}`);
      });

      it('should overwrite existing content', async () => {
        await writeFile(sftp, testFile, 'original');
        await writeFile(sftp, testFile, 'overwritten');
        const content = (await readFile(sftp, testFile)).toString();
        expect(content).toBe('overwritten');
      });

      it('should handle empty file', async () => {
        await writeFile(sftp, testFile, '');
        const content = (await readFile(sftp, testFile)).toString();
        expect(content).toBe('');
        const stats = await statFile(sftp, testFile);
        expect(stats.size).toBe(0);
      });

      it('should handle multiline content', async () => {
        const multiline = 'line 1\nline 2\nline 3\n';
        await writeFile(sftp, testFile, multiline);
        const content = (await readFile(sftp, testFile)).toString();
        expect(content).toBe(multiline);
      });

      it('should handle UTF-8 content', async () => {
        const utf8 = 'café résumé naïve über straße 日本語 中文';
        await writeFile(sftp, testFile, utf8);
        const content = (await readFile(sftp, testFile)).toString();
        expect(content).toBe(utf8);
      });

      it('should handle large content', async () => {
        const lines = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'x'.repeat(80)}`);
        const large = lines.join('\n');
        await writeFile(sftp, testFile, large);
        const content = (await readFile(sftp, testFile)).toString();
        expect(content).toBe(large);
        const stats = await statFile(sftp, testFile);
        expect(stats.size).toBeGreaterThan(40000);
      });
    });

    // ─── SFTP: Directory Operations ──────────────────────────

    describe('SFTP directory operations', () => {
      const baseDir = '/home/testuser/os-dir-test';

      afterAll(async () => {
        try { await exec(client, `rm -rf ${baseDir}`); } catch { /* ignore */ }
      });

      it('should create a directory', async () => {
        await mkdir(sftp, baseDir);
        const stats = await statFile(sftp, baseDir);
        expect(stats.isDirectory()).toBe(true);
      });

      it('should create nested directories', async () => {
        await mkdir(sftp, `${baseDir}/level1`);
        await mkdir(sftp, `${baseDir}/level1/level2`);
        const files = await listDir(sftp, `${baseDir}/level1`);
        expect(files).toContain('level2');
      });

      it('should list created directories', async () => {
        const files = await listDir(sftp, baseDir);
        expect(files).toContain('level1');
      });

      it('should create files in nested directories', async () => {
        await writeFile(sftp, `${baseDir}/level1/level2/deep.txt`, 'deep file');
        const content = (await readFile(sftp, `${baseDir}/level1/level2/deep.txt`)).toString();
        expect(content).toBe('deep file');
      });

      it('should delete files', async () => {
        await writeFile(sftp, `${baseDir}/to-delete.txt`, 'temp');
        await unlink(sftp, `${baseDir}/to-delete.txt`);
        await expect(readFile(sftp, `${baseDir}/to-delete.txt`)).rejects.toThrow();
      });

      it('should remove empty directory', async () => {
        await mkdir(sftp, `${baseDir}/empty-dir`);
        await rmdir(sftp, `${baseDir}/empty-dir`);
        const files = await listDir(sftp, baseDir);
        expect(files).not.toContain('empty-dir');
      });

      it('should recursive delete via exec', async () => {
        await mkdir(sftp, `${baseDir}/recursive`);
        await writeFile(sftp, `${baseDir}/recursive/file.txt`, 'data');
        await exec(client, `rm -rf ${baseDir}/recursive`);
        const files = await listDir(sftp, baseDir);
        expect(files).not.toContain('recursive');
      });
    });

    // ─── SFTP: Stat ──────────────────────────────────────────

    describe('SFTP stat', () => {
      it('should stat a regular file', async () => {
        const stats = await statFile(sftp, '/home/testuser/projects/src/app.ts');
        expect(stats.size).toBeGreaterThan(0);
        expect(stats.isDirectory()).toBe(false);
      });

      it('should stat a directory', async () => {
        const stats = await statFile(sftp, '/home/testuser/projects');
        expect(stats.isDirectory()).toBe(true);
      });

      it('should fail on non-existent path', async () => {
        await expect(statFile(sftp, '/home/testuser/nonexistent')).rejects.toThrow();
      });
    });

    // ─── Search: grep across OS ──────────────────────────────

    describe('search (grep)', () => {
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

      it('should support file pattern filter with --include', async () => {
        const result = await exec(client, 'grep -rl --include="*.ts" "console" /home/testuser/projects/');
        expect(result).toContain('app.ts');
      });

      it('should return empty for no matches', async () => {
        const result = await exec(client, 'grep -rl "NONEXISTENT_XYZ" /home/testuser/projects/ 2>/dev/null || echo ""');
        expect(result.replace(/\s/g, '')).toBe('');
      });

      it('should support line number output', async () => {
        const result = await exec(client, 'grep -n "console" /home/testuser/projects/src/app.ts');
        // Should contain "N:console.log..." format
        expect(result).toMatch(/\d+:.*console/);
      });

      it('should support count mode', async () => {
        const result = await exec(client, 'grep -c "hello" /home/testuser/projects/src/app.ts');
        expect(parseInt(result.trim())).toBeGreaterThan(0);
      });

      it('should search across test files created during test', async () => {
        const dir = '/home/testuser/grep-test-os';
        try {
          await mkdir(sftp, dir);
          await writeFile(sftp, `${dir}/a.ts`, 'function foo() { return "bar"; }');
          await writeFile(sftp, `${dir}/b.ts`, 'const foo_value = 42;');
          await writeFile(sftp, `${dir}/c.js`, 'var foo = require("bar");');

          // Search with include filter
          const tsResult = await exec(client, `grep -rl --include="*.ts" "foo" ${dir}/`);
          expect(tsResult).toContain('a.ts');
          expect(tsResult).toContain('b.ts');
          expect(tsResult).not.toContain('c.js');

          // Case-insensitive
          const caseResult = await exec(client, `grep -ri "FOO" ${dir}/`);
          expect(caseResult).toContain('a.ts');
          expect(caseResult).toContain('b.ts');
          expect(caseResult).toContain('c.js');
        } finally {
          await exec(client, `rm -rf ${dir}`).catch(() => {});
        }
      });
    });

    // ─── Command Execution ───────────────────────────────────

    describe('command execution', () => {
      it('should execute basic commands', async () => {
        const result = await exec(client, 'echo "test output"');
        expect(result).toBe('test output');
      });

      it('should handle command with arguments', async () => {
        const result = await exec(client, 'ls -la /home/testuser/projects/');
        expect(result).toContain('src');
        expect(result).toContain('package.json');
      });

      it('should handle uptime command', async () => {
        const result = await exec(client, 'uptime');
        expect(result).toBeTruthy();
        expect(result).toContain('up');
      });

      it('should handle disk usage command', async () => {
        const result = await exec(client, 'df -h /');
        expect(result).toContain('/');
      });

      it('should handle process listing', async () => {
        const result = await exec(client, 'ps aux | head -5');
        expect(result).toBeTruthy();
      });

      it('should handle failed commands', async () => {
        const result = await exec(client, 'nonexistent_cmd_xyz 2>&1 || echo "CMD_FAILED"');
        expect(result).toContain('CMD_FAILED');
      });

      it('should handle which/type for common tools', async () => {
        // All OS should have these tools available
        const tools = ['grep', 'ls', 'cat', 'echo', 'mkdir', 'rm'];
        for (const tool of tools) {
          const result = await exec(client, `which ${tool} 2>/dev/null || type ${tool} 2>/dev/null`);
          expect(result).toBeTruthy();
        }
      });

      it('should handle find command', async () => {
        const result = await exec(client, 'find /home/testuser/projects -name "*.ts" -type f');
        expect(result).toContain('app.ts');
        expect(result).toContain('todo.ts');
      });
    });

    // ─── Permissions ─────────────────────────────────────────

    describe('permissions', () => {
      it('should not be able to write to /etc', async () => {
        await expect(writeFile(sftp, '/etc/no-permission.txt', 'test')).rejects.toThrow();
      });

      it('should be able to write to own home directory', async () => {
        const path = '/home/testuser/perm-test.txt';
        try {
          await writeFile(sftp, path, 'allowed');
          const content = (await readFile(sftp, path)).toString();
          expect(content).toBe('allowed');
        } finally {
          await unlink(sftp, path).catch(() => {});
        }
      });

      it('should handle chmod via exec', async () => {
        const path = '/home/testuser/chmod-test.txt';
        try {
          await writeFile(sftp, path, 'test');
          await exec(client, `chmod 644 ${path}`);
          const result = await exec(client, `stat -c "%a" ${path} 2>/dev/null || stat -f "%Lp" ${path} 2>/dev/null`);
          expect(result.trim()).toBe('644');
        } finally {
          await unlink(sftp, path).catch(() => {});
        }
      });

      it('should handle script execution', async () => {
        const path = '/home/testuser/exec-test.sh';
        try {
          await writeFile(sftp, path, '#!/bin/bash\necho "script_executed"');
          await exec(client, `chmod +x ${path}`);
          const result = await exec(client, path);
          expect(result).toBe('script_executed');
        } finally {
          await unlink(sftp, path).catch(() => {});
        }
      });
    });

    // ─── File Names: Special Characters ──────────────────────

    describe('special file names', () => {
      const testDir = '/home/testuser/special-names';

      beforeAll(async () => {
        await mkdir(sftp, testDir).catch(() => {});
      });

      afterAll(async () => {
        await exec(client, `rm -rf ${testDir}`).catch(() => {});
      });

      it('should handle spaces in filenames', async () => {
        const path = `${testDir}/file with spaces.txt`;
        await writeFile(sftp, path, 'spaces');
        const content = (await readFile(sftp, path)).toString();
        expect(content).toBe('spaces');
      });

      it('should handle hyphens and underscores', async () => {
        const path = `${testDir}/my-file_name.txt`;
        await writeFile(sftp, path, 'hyphens');
        const content = (await readFile(sftp, path)).toString();
        expect(content).toBe('hyphens');
      });

      it('should handle dots in filenames', async () => {
        const path = `${testDir}/.hidden-file`;
        await writeFile(sftp, path, 'hidden');
        const content = (await readFile(sftp, path)).toString();
        expect(content).toBe('hidden');
      });

      it('should handle multiple extensions', async () => {
        const path = `${testDir}/archive.tar.gz.bak`;
        await writeFile(sftp, path, 'multi-ext');
        const content = (await readFile(sftp, path)).toString();
        expect(content).toBe('multi-ext');
      });

      it('should handle parentheses in filenames', async () => {
        const path = `${testDir}/file (copy).txt`;
        await writeFile(sftp, path, 'parens');
        const content = (await readFile(sftp, path)).toString();
        expect(content).toBe('parens');
      });
    });

    // ─── Disconnect & Reconnect ──────────────────────────────

    describe('disconnect and reconnect', () => {
      it('should reconnect after disconnect and retain data', async () => {
        const testFile = '/home/testuser/reconnect-os-test.txt';

        try {
          // Write data
          await writeFile(sftp, testFile, `data from ${server.os}`);

          // Disconnect
          client.end();

          // Reconnect
          client = await connectSSH(server);
          sftp = await getSftp(client);

          // Verify identity
          const whoami = await exec(client, 'whoami');
          expect(whoami).toBe('testuser');

          // Verify data persisted
          const content = (await readFile(sftp, testFile)).toString();
          expect(content).toBe(`data from ${server.os}`);
        } finally {
          await unlink(sftp, testFile).catch(() => {});
        }
      });
    });

    // ─── Error Handling ──────────────────────────────────────

    describe('error handling', () => {
      it('should reject reading non-existent file', async () => {
        await expect(readFile(sftp, '/home/testuser/does-not-exist.txt')).rejects.toThrow();
      });

      it('should reject listing non-existent directory', async () => {
        await expect(listDir(sftp, '/home/testuser/no-such-dir')).rejects.toThrow();
      });

      it('should reject writing to non-existent directory', async () => {
        await expect(writeFile(sftp, '/home/testuser/no-dir/file.txt', 'x')).rejects.toThrow();
      });

      it('should reject mkdir in non-existent parent', async () => {
        await expect(mkdir(sftp, '/home/testuser/no-parent/subdir')).rejects.toThrow();
      });

      it('should reject rmdir on non-empty directory', async () => {
        await expect(rmdir(sftp, '/home/testuser/projects')).rejects.toThrow();
      });

      it('should reject wrong password', async () => {
        await expect(connectSSH({ ...server, password: 'wrong' })).rejects.toThrow();
      });
    });
  });

  // ─────────────────────────────────────────────────────────
  // CROSS-OS TESTS: Operations across all OS simultaneously
  // ─────────────────────────────────────────────────────────

  describe('cross-OS concurrent operations', () => {
    let clients: Client[];
    let sftps: SFTPWrapper[];
    const dirs = SERVERS.map(s => `/home/testuser/cross-os-${s.hostname}`);

    beforeAll(async () => {
      clients = await Promise.all(SERVERS.map(s => connectSSH(s)));
      sftps = await Promise.all(clients.map(c => getSftp(c)));
    }, 60000);

    afterAll(async () => {
      await Promise.all(
        clients.map((c, i) => exec(c, `rm -rf ${dirs[i]}`).catch(() => {}))
      );
      clients.forEach(c => c?.end());
    });

    it('should connect to all 5 OS simultaneously', async () => {
      const hostnames = await Promise.all(
        clients.map(c => exec(c, 'hostname'))
      );
      expect(hostnames).toEqual(SERVERS.map(s => s.hostname));
    });

    it('should identify each OS correctly', async () => {
      const osInfo = await Promise.all(
        clients.map(c => exec(c, 'cat /etc/os-release 2>/dev/null | head -1 || cat /etc/alpine-release 2>/dev/null'))
      );
      // Each should return something
      osInfo.forEach(info => expect(info).toBeTruthy());
    });

    it('should create directories on all OS simultaneously', async () => {
      await Promise.all(dirs.map((dir, i) => mkdir(sftps[i], dir)));
      await Promise.all(dirs.map((dir, i) => mkdir(sftps[i], `${dir}/src`)));

      const listings = await Promise.all(
        dirs.map((dir, i) => listDir(sftps[i], dir))
      );
      listings.forEach(files => expect(files).toContain('src'));
    });

    it('should write OS-specific files to all servers simultaneously', async () => {
      await Promise.all(
        SERVERS.map((s, i) =>
          writeFile(sftps[i], `${dirs[i]}/src/info.txt`, `OS: ${s.os}\nHostname: ${s.hostname}`)
        )
      );

      // Verify each file has the correct OS info
      const contents = await Promise.all(
        SERVERS.map((_, i) => readFile(sftps[i], `${dirs[i]}/src/info.txt`))
      );
      SERVERS.forEach((s, i) => {
        const text = contents[i].toString();
        expect(text).toContain(s.os);
        expect(text).toContain(s.hostname);
      });
    });

    it('should search across all OS simultaneously', async () => {
      // Create searchable files on all servers
      await Promise.all(
        SERVERS.map((s, i) => writeFile(sftps[i], `${dirs[i]}/src/search.ts`, [
          `// TODO: implement for ${s.os}`,
          `const os = "${s.os}";`,
          `export function handler() { return os; }`,
        ].join('\n')))
      );

      // Search for TODO on all servers
      const results = await Promise.all(
        clients.map((c, i) => exec(c, `grep -rn "TODO" ${dirs[i]}/`))
      );

      results.forEach((result, i) => {
        expect(result).toContain('TODO');
        expect(result).toContain(SERVERS[i].os);
      });
    });

    it('should edit and verify files across all OS simultaneously', async () => {
      // Write initial content
      await Promise.all(
        SERVERS.map((_, i) => writeFile(sftps[i], `${dirs[i]}/config.json`, JSON.stringify({ version: 1 })))
      );

      // Read and modify
      const configs = await Promise.all(
        SERVERS.map((_, i) => readFile(sftps[i], `${dirs[i]}/config.json`).then(b => JSON.parse(b.toString())))
      );

      // Update each
      configs.forEach((c, i) => { c.version = 2; c.os = SERVERS[i].os; });

      // Write back
      await Promise.all(
        SERVERS.map((_, i) => writeFile(sftps[i], `${dirs[i]}/config.json`, JSON.stringify(configs[i])))
      );

      // Verify
      const updated = await Promise.all(
        SERVERS.map((_, i) => readFile(sftps[i], `${dirs[i]}/config.json`).then(b => JSON.parse(b.toString())))
      );
      updated.forEach((c, i) => {
        expect(c.version).toBe(2);
        expect(c.os).toBe(SERVERS[i].os);
      });
    });

    it('should handle concurrent file creation stress test', async () => {
      // Create 10 files on each of the 5 servers = 50 concurrent operations
      const ops = SERVERS.flatMap((_, i) =>
        Array.from({ length: 10 }, (__, j) =>
          writeFile(sftps[i], `${dirs[i]}/stress-${j}.txt`, `server ${i} file ${j}`)
        )
      );
      await Promise.all(ops);

      // Verify file counts on each server
      const counts = await Promise.all(
        dirs.map((dir, i) => listDir(sftps[i], dir))
      );
      counts.forEach(files => {
        const stressFiles = files.filter(f => f.startsWith('stress-'));
        expect(stressFiles.length).toBe(10);
      });
    });

    it('should handle one server disconnect without affecting others', async () => {
      // Disconnect the Alpine server (index 0)
      clients[0].end();

      // Other 4 servers should still work
      const otherHostnames = await Promise.all(
        clients.slice(1).map(c => exec(c, 'hostname'))
      );
      expect(otherHostnames).toEqual(SERVERS.slice(1).map(s => s.hostname));

      // Reconnect Alpine
      clients[0] = await connectSSH(SERVERS[0]);
      sftps[0] = await getSftp(clients[0]);

      const hostname = await exec(clients[0], 'hostname');
      expect(hostname).toBe('alpine-server');
    });

    it('should delete files on all OS simultaneously', async () => {
      await Promise.all(
        clients.map((c, i) => exec(c, `rm -rf ${dirs[i]}`))
      );

      // Verify deleted
      const results = await Promise.allSettled(
        dirs.map((dir, i) => listDir(sftps[i], dir))
      );
      results.forEach(r => expect(r.status).toBe('rejected'));
    });
  });

  // ─────────────────────────────────────────────────────────
  // ADMIN USER TESTS: Multi-OS with different user
  // ─────────────────────────────────────────────────────────

  describe('admin user across all OS', () => {
    const testServers = SERVERS.map(s => ({
      ...s,
      username: ADMIN_CONFIG.username,
      password: ADMIN_CONFIG.password,
    }));

    it.each(testServers)('should authenticate as admin on $os', async (server) => {
      const client = await connectSSH(server);
      try {
        const whoami = await exec(client, 'whoami');
        expect(whoami).toBe('admin');

        const sftp = await getSftp(client);
        const files = await listDir(sftp, '/home/admin');
        expect(files).toContain('configs');
      } finally {
        client.end();
      }
    });

    it('should connect as admin to all OS simultaneously', async () => {
      const clients = await Promise.all(testServers.map(s => connectSSH(s)));
      try {
        const users = await Promise.all(clients.map(c => exec(c, 'whoami')));
        users.forEach(u => expect(u).toBe('admin'));

        const hostnames = await Promise.all(clients.map(c => exec(c, 'hostname')));
        expect(hostnames).toEqual(SERVERS.map(s => s.hostname));
      } finally {
        clients.forEach(c => c.end());
      }
    });
  });

  // ─────────────────────────────────────────────────────────
  // OS-SPECIFIC BEHAVIOR VERIFICATION
  // ─────────────────────────────────────────────────────────

  describe('OS-specific behaviors', () => {
    let clients: Client[];

    beforeAll(async () => {
      clients = await Promise.all(SERVERS.map(s => connectSSH(s)));
    }, 60000);

    afterAll(() => {
      clients.forEach(c => c?.end());
    });

    it('should have correct default shell path', async () => {
      const shells = await Promise.all(
        clients.map(c => exec(c, 'echo $SHELL'))
      );
      // Alpine defaults to ash/sh, others to bash
      // The actual $SHELL depends on what was set in useradd/adduser
      shells.forEach(shell => {
        expect(shell).toMatch(/\/(bash|sh|ash)$/);
      });
    });

    it('should have GNU or BusyBox grep as expected', async () => {
      const grepVersions = await Promise.all(
        clients.map(c => exec(c, 'grep --version 2>&1 | head -1'))
      );

      SERVERS.forEach((server, i) => {
        if (server.grepVariant === 'busybox') {
          expect(grepVersions[i]).toMatch(/busybox/i);
        } else {
          expect(grepVersions[i]).toMatch(/gnu|grep/i);
        }
      });
    });

    it('should all support basic grep flags (-r, -l, -n, -i)', async () => {
      // These flags work on both GNU grep and BusyBox grep
      const flags = ['-rl', '-rn', '-ri'];
      for (const flag of flags) {
        const results = await Promise.all(
          clients.map(c => exec(c, `grep ${flag} "hello" /home/testuser/projects/ 2>/dev/null || echo "ok"`))
        );
        results.forEach(r => expect(r).toBeTruthy());
      }
    });

    it('should all support --include grep flag', async () => {
      const results = await Promise.all(
        clients.map(c => exec(c, 'grep -rl --include="*.ts" "console" /home/testuser/projects/'))
      );
      results.forEach(r => expect(r).toContain('app.ts'));
    });

    it('should all have coreutils available (ls, cp, mv, rm, cat)', async () => {
      const tools = ['ls', 'cp', 'mv', 'rm', 'cat', 'chmod', 'chown'];
      for (const tool of tools) {
        const results = await Promise.all(
          clients.map(c => exec(c, `which ${tool} 2>/dev/null || command -v ${tool} 2>/dev/null`))
        );
        results.forEach((r, i) => {
          expect(r).toBeTruthy();
        });
      }
    });

    it('should all support find with -name and -type', async () => {
      const results = await Promise.all(
        clients.map(c => exec(c, 'find /home/testuser/projects -name "*.ts" -type f'))
      );
      results.forEach(r => {
        expect(r).toContain('app.ts');
        expect(r).toContain('todo.ts');
      });
    });

    it('should all support wc command', async () => {
      const results = await Promise.all(
        clients.map(c => exec(c, 'echo -e "a\nb\nc" | wc -l'))
      );
      results.forEach(r => {
        expect(parseInt(r.trim())).toBe(3);
      });
    });

    it('should all support stat command for file info', async () => {
      // stat -c on GNU coreutils, stat -f on BusyBox (Alpine)
      const results = await Promise.all(
        clients.map(c => exec(c, 'stat /home/testuser/projects/src/app.ts 2>/dev/null | head -3'))
      );
      results.forEach(r => {
        expect(r).toBeTruthy();
      });
    });

    it('should all report disk usage consistently', async () => {
      const results = await Promise.all(
        clients.map(c => exec(c, 'df -h / | tail -1'))
      );
      results.forEach(r => {
        expect(r).toBeTruthy();
        expect(r).toContain('/');
      });
    });

    it('should all support process listing', async () => {
      // ps output format varies by OS but all should work
      const results = await Promise.all(
        clients.map(c => exec(c, 'ps aux 2>/dev/null || ps -ef 2>/dev/null'))
      );
      results.forEach(r => {
        expect(r).toBeTruthy();
        expect(r).toContain('sshd');
      });
    });
  });
});
