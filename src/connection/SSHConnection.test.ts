/**
 * SSHConnection tests - tests the ACTUAL SSHConnection class
 *
 * Tests real class methods via instance creation with mocked ssh2/vscode:
 * - Connection ID generation (constructor)
 * - formatPermissions (private, accessed via (instance as any))
 * - parseOwnerGroup (private, accessed via (instance as any))
 * - mapFileList (private, accessed via (instance as any))
 * - writeFile timeout pattern (actual method with mocked SFTP)
 * - Command injection prevention (readFileLastLines, readFileFirstLines, searchFiles)
 * - Connection state management
 */

import { ConnectionState, SFTPError, ConnectionError } from '../types';
import { createMockHostConfig } from '../__mocks__/testHelpers';

// Mock ssh2 Client to prevent real SSH connections
jest.mock('ssh2', () => ({
  Client: jest.fn().mockImplementation(() => ({
    on: jest.fn().mockReturnThis(),
    connect: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
  })),
}));

// Mock CredentialService
jest.mock('../services/CredentialService', () => ({
  CredentialService: {
    getInstance: jest.fn().mockReturnValue({
      getCredentialPassword: jest.fn().mockResolvedValue(undefined),
      listCredentials: jest.fn().mockReturnValue([]),
    }),
  },
}));

import { SSHConnection } from './SSHConnection';

describe('SSHConnection - Actual Class', () => {
  let connection: SSHConnection;

  beforeEach(() => {
    const host = createMockHostConfig({
      host: '10.0.0.1',
      port: 22,
      username: 'testuser',
    });
    connection = new SSHConnection(host);
  });

  afterEach(() => {
    // Reset _client to null before dispose to avoid calling .end() on mock objects
    (connection as any)._client = null;
    connection.dispose();
  });

  describe('constructor & connection ID', () => {
    it('should generate ID as host:port:username', () => {
      expect(connection.id).toBe('10.0.0.1:22:testuser');
    });

    it('should use custom port in ID', () => {
      const host = createMockHostConfig({ host: 'example.com', port: 2222, username: 'deploy' });
      const conn = new SSHConnection(host);
      expect(conn.id).toBe('example.com:2222:deploy');
      conn.dispose();
    });

    it('should differentiate connections by username on same host', () => {
      const h1 = createMockHostConfig({ host: '10.0.0.1', port: 22, username: 'root' });
      const h2 = createMockHostConfig({ host: '10.0.0.1', port: 22, username: 'deploy' });
      const c1 = new SSHConnection(h1);
      const c2 = new SSHConnection(h2);

      expect(c1.id).not.toBe(c2.id);
      c1.dispose();
      c2.dispose();
    });

    it('should start in Disconnected state', () => {
      expect(connection.state).toBe(ConnectionState.Disconnected);
    });

    it('should store host config', () => {
      expect(connection.host.host).toBe('10.0.0.1');
      expect(connection.host.port).toBe(22);
      expect(connection.host.username).toBe('testuser');
    });
  });

  describe('formatPermissions (private method)', () => {
    const formatPermissions = (mode: number): string => {
      return (connection as any).formatPermissions(mode);
    };

    it('should format full permissions (777)', () => {
      expect(formatPermissions(0o100777)).toBe('rwxrwxrwx');
    });

    it('should format typical file permissions (644)', () => {
      expect(formatPermissions(0o100644)).toBe('rw-r--r--');
    });

    it('should format executable permissions (755)', () => {
      expect(formatPermissions(0o100755)).toBe('rwxr-xr-x');
    });

    it('should format directory permissions (755 with dir bit)', () => {
      expect(formatPermissions(0o040755)).toBe('rwxr-xr-x');
    });

    it('should format no permissions (000)', () => {
      expect(formatPermissions(0o100000)).toBe('---------');
    });

    it('should format read-only (444)', () => {
      expect(formatPermissions(0o100444)).toBe('r--r--r--');
    });

    it('should format write-only (222)', () => {
      expect(formatPermissions(0o100222)).toBe('-w--w--w-');
    });

    it('should format owner-only execute (700)', () => {
      expect(formatPermissions(0o100700)).toBe('rwx------');
    });
  });

  describe('parseOwnerGroup (private method)', () => {
    const parseOwnerGroup = (longname: string): { owner: string; group: string } => {
      return (connection as any).parseOwnerGroup(longname);
    };

    it('should parse standard ls -l output', () => {
      const result = parseOwnerGroup('-rw-r--r--  1 user group  1234 Jan 20 10:30 filename');
      expect(result.owner).toBe('user');
      expect(result.group).toBe('group');
    });

    it('should parse root-owned files', () => {
      const result = parseOwnerGroup('-rwxr-xr-x  1 root root  4096 Dec 25 00:00 bin');
      expect(result.owner).toBe('root');
      expect(result.group).toBe('root');
    });

    it('should handle multiple spaces in longname', () => {
      const result = parseOwnerGroup('-rw-r--r--    1   deploy   www-data   2048 Feb 14 12:00 index.html');
      expect(result.owner).toBe('deploy');
      expect(result.group).toBe('www-data');
    });

    it('should return unknown for malformed longname', () => {
      const result = parseOwnerGroup('short');
      expect(result.owner).toBe('unknown');
      expect(result.group).toBe('unknown');
    });

    it('should return unknown for empty string', () => {
      const result = parseOwnerGroup('');
      expect(result.owner).toBe('unknown');
      expect(result.group).toBe('unknown');
    });
  });

  describe('mapFileList (private method)', () => {
    const mapFileList = (
      list: Array<{ filename: string; longname: string; attrs: { size: number; mtime: number; atime: number; mode: number } }>,
      basePath: string
    ) => {
      return (connection as any).mapFileList(list, basePath);
    };

    const makeEntry = (filename: string, isDir = false, size = 1024) => ({
      filename,
      longname: `-rw-r--r-- 1 user group ${size} Jan 01 00:00 ${filename}`,
      attrs: {
        size,
        mtime: 1700000000,
        atime: 1700000000,
        mode: isDir ? 0o40755 : 0o100644,
      },
    });

    it('should filter out . and .. entries', () => {
      const list = [makeEntry('.'), makeEntry('..'), makeEntry('file.ts')];
      const result = mapFileList(list, '/home');
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('file.ts');
    });

    it('should build correct paths with standard basePath', () => {
      const list = [makeEntry('app.ts')];
      const result = mapFileList(list, '/home/user');
      expect(result[0].path).toBe('/home/user/app.ts');
    });

    it('should build correct paths with root basePath', () => {
      const list = [makeEntry('etc')];
      const result = mapFileList(list, '/');
      expect(result[0].path).toBe('/etc');
    });

    it('should build correct paths with dot basePath (home)', () => {
      const list = [makeEntry('Documents')];
      const result = mapFileList(list, '.');
      expect(result[0].path).toBe('Documents');
    });

    it('should detect directories from mode bits', () => {
      const list = [makeEntry('folder', true), makeEntry('file.txt', false)];
      const result = mapFileList(list, '/home');
      expect(result[0].isDirectory).toBe(true);
      expect(result[0].name).toBe('folder');
      expect(result[1].isDirectory).toBe(false);
    });

    it('should sort directories before files', () => {
      const list = [
        makeEntry('zebra.txt', false),
        makeEntry('alpha', true),
        makeEntry('beta.txt', false),
      ];
      const result = mapFileList(list, '/home');
      expect(result[0].name).toBe('alpha');
      expect(result[1].name).toBe('beta.txt');
      expect(result[2].name).toBe('zebra.txt');
    });

    it('should sort alphabetically within same type', () => {
      const list = [makeEntry('c.txt'), makeEntry('a.txt'), makeEntry('b.txt')];
      const result = mapFileList(list, '/home');
      expect(result.map((f: any) => f.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    });

    it('should convert mtime seconds to milliseconds', () => {
      const list = [makeEntry('file.ts')];
      const result = mapFileList(list, '/home');
      expect(result[0].modifiedTime).toBe(1700000000 * 1000);
    });

    it('should include connectionId from the instance', () => {
      const list = [makeEntry('file.ts')];
      const result = mapFileList(list, '/home');
      expect(result[0].connectionId).toBe(connection.id);
    });

    it('should parse owner and group from longname', () => {
      const list = [{
        filename: 'file.ts',
        longname: '-rw-r--r-- 1 deploy www-data 1024 Jan 01 00:00 file.ts',
        attrs: { size: 1024, mtime: 1700000000, atime: 1700000000, mode: 0o100644 },
      }];
      const result = mapFileList(list, '/home');
      expect(result[0].owner).toBe('deploy');
      expect(result[0].group).toBe('www-data');
    });

    it('should include permissions string in result', () => {
      const list = [makeEntry('file.ts')];
      const result = mapFileList(list, '/home');
      expect(result[0].permissions).toBe('rw-r--r--');
    });
  });

  describe('writeFile (actual method with mocked SFTP)', () => {
    let mockSftp: any;

    beforeEach(() => {
      jest.useFakeTimers();
      mockSftp = {
        writeFile: jest.fn(),
      };
      // Inject mocked SFTP into the connection
      (connection as any)._sftp = mockSftp;
      (connection as any).state = ConnectionState.Connected;
      (connection as any)._client = {}; // Non-null client
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should resolve when SFTP write succeeds', async () => {
      mockSftp.writeFile.mockImplementation(
        (_path: string, _content: Buffer, cb: (err?: Error) => void) => cb()
      );

      const promise = connection.writeFile('/test.ts', Buffer.from('data'));
      await expect(promise).resolves.toBeUndefined();
    });

    it('should reject when SFTP write fails', async () => {
      mockSftp.writeFile.mockImplementation(
        (_path: string, _content: Buffer, cb: (err?: Error) => void) => cb(new Error('Permission denied'))
      );

      await expect(
        connection.writeFile('/test.ts', Buffer.from('data'))
      ).rejects.toThrow('Permission denied');
    });

    it('should reject with timeout when write takes too long', async () => {
      mockSftp.writeFile.mockImplementation(
        (_path: string, _content: Buffer, _cb: (err?: Error) => void) => {
          // Never calls callback
        }
      );

      const promise = connection.writeFile('/test.ts', Buffer.from('data'));
      // Flush microtask queue so getSFTP() await resolves and setTimeout is registered
      await Promise.resolve();
      jest.advanceTimersByTime(60_001);
      await expect(promise).rejects.toThrow('timed out');
    });

    it('should not double-settle when timeout fires after callback', async () => {
      mockSftp.writeFile.mockImplementation(
        (_path: string, _content: Buffer, cb: (err?: Error) => void) => {
          // Succeed immediately
          cb();
        }
      );

      const result = await connection.writeFile('/test.ts', Buffer.from('data'));
      expect(result).toBeUndefined();

      // Advance past timeout - should not cause issues
      jest.advanceTimersByTime(70_000);
    });

    it('should pass correct path and content to SFTP', async () => {
      mockSftp.writeFile.mockImplementation(
        (_path: string, _content: Buffer, cb: (err?: Error) => void) => cb()
      );

      const content = Buffer.from('hello world');
      await connection.writeFile('/home/user/file.ts', content);

      expect(mockSftp.writeFile).toHaveBeenCalledWith(
        '/home/user/file.ts',
        content,
        expect.any(Function)
      );
    });
  });

  describe('rename (actual method with mocked SFTP)', () => {
    let mockSftp: any;

    beforeEach(() => {
      mockSftp = {
        rename: jest.fn(),
      };
      (connection as any)._sftp = mockSftp;
      (connection as any).state = ConnectionState.Connected;
      (connection as any)._client = {};
    });

    it('should rename file successfully', async () => {
      mockSftp.rename.mockImplementation(
        (_oldPath: string, _newPath: string, cb: (err?: Error) => void) => cb()
      );

      await expect(connection.rename('/tmp/old.txt', '/tmp/new.txt')).resolves.toBeUndefined();
    });

    it('should reject when SFTP rename fails', async () => {
      mockSftp.rename.mockImplementation(
        (_oldPath: string, _newPath: string, cb: (err?: Error) => void) =>
          cb(new Error('No such file'))
      );

      await expect(
        connection.rename('/tmp/old.txt', '/tmp/new.txt')
      ).rejects.toThrow('No such file');
    });

    it('should pass correct old and new paths to SFTP', async () => {
      mockSftp.rename.mockImplementation(
        (_oldPath: string, _newPath: string, cb: (err?: Error) => void) => cb()
      );

      await connection.rename('/home/user/old-name.ts', '/home/user/new-name.ts');

      expect(mockSftp.rename).toHaveBeenCalledWith(
        '/home/user/old-name.ts',
        '/home/user/new-name.ts',
        expect.any(Function)
      );
    });

    it('should support move (different directory paths)', async () => {
      mockSftp.rename.mockImplementation(
        (_oldPath: string, _newPath: string, cb: (err?: Error) => void) => cb()
      );

      await connection.rename('/home/user/file.ts', '/home/user/subdir/file.ts');

      expect(mockSftp.rename).toHaveBeenCalledWith(
        '/home/user/file.ts',
        '/home/user/subdir/file.ts',
        expect.any(Function)
      );
    });

    it('should reject with SFTPError on permission denied', async () => {
      mockSftp.rename.mockImplementation(
        (_oldPath: string, _newPath: string, cb: (err?: Error) => void) =>
          cb(new Error('Permission denied'))
      );

      await expect(
        connection.rename('/root/secret.txt', '/tmp/secret.txt')
      ).rejects.toThrow('Permission denied');
    });
  });

  describe('command injection prevention', () => {
    let execSpy: jest.SpyInstance;

    beforeEach(() => {
      // Mock exec to capture the command string without running it
      (connection as any)._client = {}; // Non-null client
      (connection as any).state = ConnectionState.Connected;
      execSpy = jest.spyOn(connection, 'exec').mockResolvedValue('');
    });

    describe('readFileLastLines', () => {
      it('should escape single quotes in file path', async () => {
        await connection.readFileLastLines("/home/user/it's a file.log", 100);
        const cmd = execSpy.mock.calls[0][0];
        // The path should be wrapped in single quotes with escaped quotes
        expect(cmd).toContain("'\\''");
        expect(cmd).toContain('tail -n 100');
      });

      it('should prevent shell command injection via path', async () => {
        await connection.readFileLastLines("/tmp/file'; rm -rf /; echo '", 100);
        const cmd = execSpy.mock.calls[0][0];
        // The single-quote escaping wraps the path so bash treats the entire
        // argument as a literal string. Each ' becomes '\'' (end quote, escaped
        // literal quote, start new quote). The raw characters appear in the
        // command string but are safely inside single quotes.
        expect(cmd).toContain("'\\''");
        expect(cmd).toMatch(/^tail -n 100 '/);
      });

      it('should validate lineCount to prevent injection', async () => {
        // NaN should be sanitized
        await connection.readFileLastLines('/tmp/file.log', NaN);
        const cmd = execSpy.mock.calls[0][0];
        expect(cmd).toContain('tail -n 1'); // NaN -> default 1
      });

      it('should clamp lineCount to valid range', async () => {
        await connection.readFileLastLines('/tmp/file.log', -5);
        const cmd1 = execSpy.mock.calls[0][0];
        expect(cmd1).toContain('tail -n 1'); // Clamped to min 1

        execSpy.mockClear();

        await connection.readFileLastLines('/tmp/file.log', 999999);
        const cmd2 = execSpy.mock.calls[0][0];
        expect(cmd2).toContain('tail -n 100000'); // Clamped to max 100000
      });

      it('should throw ConnectionError when not connected', async () => {
        (connection as any).state = ConnectionState.Disconnected;
        (connection as any)._client = null;
        execSpy.mockRestore(); // Remove spy so real method runs

        await expect(
          connection.readFileLastLines('/tmp/file.log', 100)
        ).rejects.toThrow('Not connected');
      });
    });

    describe('readFileFirstLines', () => {
      it('should escape single quotes in file path', async () => {
        await connection.readFileFirstLines("/home/user/it's a file.log", 50);
        const cmd = execSpy.mock.calls[0][0];
        expect(cmd).toContain("'\\''");
        expect(cmd).toContain('head -n 50');
      });

      it('should prevent shell command injection via path', async () => {
        await connection.readFileFirstLines("/tmp/$(whoami)/file.log", 50);
        const cmd = execSpy.mock.calls[0][0];
        // Inside single quotes, $() is not expanded
        expect(cmd).toContain("'/tmp/$(whoami)/file.log'");
      });

      it('should validate lineCount', async () => {
        await connection.readFileFirstLines('/tmp/file.log', 0);
        const cmd = execSpy.mock.calls[0][0];
        expect(cmd).toContain('head -n 1'); // 0 clamped to 1
      });
    });

    describe('searchFiles', () => {
      // searchFiles calls this._client!.exec() directly, not this.exec()
      // We need a separate mock for the client's exec
      let clientExecSpy: jest.Mock;
      let capturedCommand: string;

      beforeEach(() => {
        capturedCommand = '';
        const mockStream = {
          on: jest.fn().mockImplementation(function(this: any, event: string, cb: Function) {
            if (event === 'close') {
              // Fire close immediately to resolve the promise
              setTimeout(() => cb(), 0);
            }
            return this;
          }),
          stderr: {
            on: jest.fn().mockReturnThis(),
          },
          close: jest.fn(),
        };
        clientExecSpy = jest.fn().mockImplementation((cmd: string, cb: Function) => {
          capturedCommand = cmd;
          cb(null, mockStream);
        });
        (connection as any)._client = { exec: clientExecSpy, end: jest.fn(), destroy: jest.fn() };
      });

      it('should escape single quotes in search pattern', async () => {
        await connection.searchFiles('/home', "it's a test", { searchContent: true });
        expect(capturedCommand).toContain("'\\''");
      });

      it('should escape single quotes in search path', async () => {
        await connection.searchFiles("/home/user's dir", 'pattern', { searchContent: false });
        expect(capturedCommand).toContain("'\\''");
      });

      it('should use -F flag for literal string matching by default', async () => {
        await connection.searchFiles('/home', 'audio/ogg; codecs=opus', { searchContent: true });
        expect(capturedCommand).toContain('-F');
      });

      it('should omit -F flag when regex mode is enabled', async () => {
        await connection.searchFiles('/home', '.*pattern', { searchContent: true, regex: true });
        expect(capturedCommand).not.toContain('-F');
      });

      it('should validate maxResults', async () => {
        await connection.searchFiles('/home', 'test', { maxResults: -1 });
        expect(capturedCommand).toContain('head -1');
      });

      it('should return empty array when already aborted', async () => {
        const abortController = new AbortController();
        abortController.abort();
        const result = await connection.searchFiles('/home', 'test', { signal: abortController.signal });
        expect(result).toEqual([]);
      });

      it('should prevent command injection via search pattern', async () => {
        await connection.searchFiles('/home', "'; cat /etc/shadow; echo '", { searchContent: true });
        // The single-quote escaping ensures the malicious pattern is treated
        // as a literal grep argument, not a shell command. Verify escaping present.
        expect(capturedCommand).toContain("'\\''");
        // The command should still be a grep command, not hijacked
        expect(capturedCommand).toMatch(/^grep /);
      });

      it('should apply both --exclude and --exclude-dir for glob patterns in content search', async () => {
        await connection.searchFiles('/home', 'test', {
          searchContent: true,
          excludePattern: '*uat*',
        });
        // Both flags must be present so *uat* excludes files AND directories
        expect(capturedCommand).toContain("--exclude='*uat*'");
        expect(capturedCommand).toContain("--exclude-dir='*uat*'");
      });

      it('should apply both --exclude and --exclude-dir for dotted patterns too', async () => {
        await connection.searchFiles('/home', 'test', {
          searchContent: true,
          excludePattern: '*.log',
        });
        expect(capturedCommand).toContain("--exclude='*.log'");
        expect(capturedCommand).toContain("--exclude-dir='*.log'");
      });

      it('should handle multiple comma-separated exclude patterns', async () => {
        await connection.searchFiles('/home', 'test', {
          searchContent: true,
          excludePattern: '*uat*, *.tmp, node_modules',
        });
        expect(capturedCommand).toContain("--exclude='*uat*'");
        expect(capturedCommand).toContain("--exclude-dir='*uat*'");
        expect(capturedCommand).toContain("--exclude='*.tmp'");
        expect(capturedCommand).toContain("--exclude-dir='*.tmp'");
        expect(capturedCommand).toContain("--exclude='node_modules'");
        expect(capturedCommand).toContain("--exclude-dir='node_modules'");
      });

      it('should apply find excludes for filename search with glob patterns', async () => {
        await connection.searchFiles('/home', 'test', {
          searchContent: false,
          excludePattern: '*uat*',
        });
        // find uses ! -name for file exclusion and ! -path for directory exclusion
        expect(capturedCommand).toContain("! -name '*uat*'");
        expect(capturedCommand).toContain("! -path '*/*uat*/*'");
        // Should be a find command, not grep
        expect(capturedCommand).toMatch(/^find /);
      });

      it('should accept string[] paths for grep content search', async () => {
        await connection.searchFiles(['/home', '/var', '/etc'], 'test', { searchContent: true });
        // All three paths should appear in the grep command
        expect(capturedCommand).toContain("'/home'");
        expect(capturedCommand).toContain("'/var'");
        expect(capturedCommand).toContain("'/etc'");
        expect(capturedCommand).toMatch(/^grep /);
      });

      it('should accept string[] paths for find filename search', async () => {
        await connection.searchFiles(['/opt/a', '/opt/b'], 'test', { searchContent: false });
        // Both paths should appear in the find command
        expect(capturedCommand).toContain("'/opt/a'");
        expect(capturedCommand).toContain("'/opt/b'");
        expect(capturedCommand).toMatch(/^find /);
      });

      it('should handle single-element string[] same as string', async () => {
        await connection.searchFiles(['/home'], 'test', { searchContent: true });
        expect(capturedCommand).toContain("'/home'");
        expect(capturedCommand).toMatch(/^grep /);
      });

      it('should escape single quotes in multi-path search', async () => {
        await connection.searchFiles(["/home/user's dir", "/var/it's here"], 'test', { searchContent: true });
        expect(capturedCommand).toContain("'\\''");
        expect(capturedCommand).toMatch(/^grep /);
      });

      it('should add -w flag when wholeWord is true', async () => {
        await connection.searchFiles('/home', 'test', { searchContent: true, wholeWord: true });
        expect(capturedCommand).toContain('-w');
        expect(capturedCommand).toMatch(/^grep /);
      });

      it('should not add -w flag when wholeWord is false', async () => {
        await connection.searchFiles('/home', 'test', { searchContent: true, wholeWord: false });
        expect(capturedCommand).not.toContain('-w');
      });

      it('should combine -w with -F for whole word literal search', async () => {
        await connection.searchFiles('/home', 'test', { searchContent: true, wholeWord: true, regex: false });
        expect(capturedCommand).toContain('-F');
        expect(capturedCommand).toContain('-w');
      });

      it('should support comma-separated include patterns', async () => {
        await connection.searchFiles('/home', 'test', {
          searchContent: true,
          filePattern: '*.ts, *.js',
        });
        expect(capturedCommand).toContain("--include='*.ts'");
        expect(capturedCommand).toContain("--include='*.js'");
        expect(capturedCommand).toMatch(/^grep /);
      });

      it('should handle single include pattern without comma', async () => {
        await connection.searchFiles('/home', 'test', {
          searchContent: true,
          filePattern: '*.ts',
        });
        expect(capturedCommand).toContain("--include='*.ts'");
        expect(capturedCommand).not.toContain("--include='*'");
      });

      it('should default to --include=* when filePattern is empty', async () => {
        await connection.searchFiles('/home', 'test', {
          searchContent: true,
          filePattern: '',
        });
        expect(capturedCommand).toContain("--include='*'");
      });
    });

    describe('listDirectories', () => {
      let execSpy: jest.SpyInstance;

      beforeEach(() => {
        (connection as any).state = ConnectionState.Connected;
        (connection as any)._client = { exec: jest.fn(), end: jest.fn(), destroy: jest.fn() };
      });

      function mockExecOutput(output: string) {
        execSpy = jest.spyOn(connection, 'exec').mockResolvedValue(output);
      }

      it('should throw when not connected', async () => {
        (connection as any).state = ConnectionState.Disconnected;
        (connection as any)._client = null;
        await expect(connection.listDirectories('/home')).rejects.toThrow('Not connected');
      });

      it('should build correct find command', async () => {
        mockExecOutput('/home/user\n/home/admin\n');
        await connection.listDirectories('/home');
        expect(execSpy).toHaveBeenCalledWith(
          expect.stringContaining("find '/home' -maxdepth 1 -mindepth 1 -type d")
        );
      });

      it('should parse output into sorted directory list', async () => {
        mockExecOutput('/home/zeta\n/home/alpha\n/home/beta\n');
        const result = await connection.listDirectories('/home');
        expect(result).toEqual(['/home/alpha', '/home/beta', '/home/zeta']);
      });

      it('should handle empty output', async () => {
        mockExecOutput('');
        const result = await connection.listDirectories('/home');
        expect(result).toEqual([]);
      });

      it('should escape single quotes in path', async () => {
        mockExecOutput('');
        await connection.listDirectories("/home/user's dir");
        expect(execSpy).toHaveBeenCalledWith(
          expect.stringContaining("'\\''")
        );
      });

      it('should handle root / path correctly', async () => {
        mockExecOutput('/home\n/var\n/etc\n/proc\n');
        const result = await connection.listDirectories('/');
        expect(result).toEqual(['/etc', '/home', '/proc', '/var']);
        expect(execSpy).toHaveBeenCalledWith(
          expect.stringContaining("find '/' -maxdepth 1")
        );
      });
    });

    describe('listEntries', () => {
      let execSpy: jest.SpyInstance;

      beforeEach(() => {
        (connection as any).state = ConnectionState.Connected;
        (connection as any)._client = { exec: jest.fn(), end: jest.fn(), destroy: jest.fn() };
      });

      function mockExecOutput(output: string) {
        execSpy = jest.spyOn(connection, 'exec').mockResolvedValue(output);
      }

      it('should throw when not connected', async () => {
        (connection as any).state = ConnectionState.Disconnected;
        (connection as any)._client = null;
        await expect(connection.listEntries('/home')).rejects.toThrow('Not connected');
      });

      it('should return files and dirs correctly', async () => {
        mockExecOutput(
          '/home/file1.ts\n/home/file2.ts\n<<DIR_MARKER>>\n/home/subdir1\n/home/subdir2\n'
        );
        const result = await connection.listEntries('/home');
        expect(result.files).toEqual(['/home/file1.ts', '/home/file2.ts']);
        expect(result.dirs).toEqual(['/home/subdir1', '/home/subdir2']);
      });

      it('should sort files and dirs', async () => {
        mockExecOutput(
          '/opt/z.ts\n/opt/a.ts\n<<DIR_MARKER>>\n/opt/zdir\n/opt/adir\n'
        );
        const result = await connection.listEntries('/opt');
        expect(result.files).toEqual(['/opt/a.ts', '/opt/z.ts']);
        expect(result.dirs).toEqual(['/opt/adir', '/opt/zdir']);
      });

      it('should handle empty directory (no files, no dirs)', async () => {
        mockExecOutput('<<DIR_MARKER>>\n');
        const result = await connection.listEntries('/empty');
        expect(result.files).toEqual([]);
        expect(result.dirs).toEqual([]);
      });

      it('should handle directory with only files', async () => {
        mockExecOutput('/opt/a.ts\n/opt/b.ts\n<<DIR_MARKER>>\n');
        const result = await connection.listEntries('/opt');
        expect(result.files).toEqual(['/opt/a.ts', '/opt/b.ts']);
        expect(result.dirs).toEqual([]);
      });

      it('should handle directory with only subdirs', async () => {
        mockExecOutput('<<DIR_MARKER>>\n/opt/sub1\n/opt/sub2\n');
        const result = await connection.listEntries('/opt');
        expect(result.files).toEqual([]);
        expect(result.dirs).toEqual(['/opt/sub1', '/opt/sub2']);
      });

      it('should apply filePattern filter', async () => {
        mockExecOutput('/opt/a.ts\n<<DIR_MARKER>>\n/opt/sub1\n');
        await connection.listEntries('/opt', '*.ts');
        expect(execSpy).toHaveBeenCalledWith(
          expect.stringContaining("-name '*.ts'")
        );
      });

      it('should not apply name filter when pattern is *', async () => {
        mockExecOutput('<<DIR_MARKER>>\n');
        await connection.listEntries('/opt', '*');
        const cmd = execSpy.mock.calls[0][0] as string;
        expect(cmd).not.toContain("-name '*'");
      });

      it('should escape single quotes in path', async () => {
        mockExecOutput('<<DIR_MARKER>>\n');
        await connection.listEntries("/home/user's dir");
        expect(execSpy).toHaveBeenCalledWith(
          expect.stringContaining("'\\''")
        );
      });

      it('should escape single quotes in filePattern', async () => {
        mockExecOutput('<<DIR_MARKER>>\n');
        await connection.listEntries('/opt', "*.o'malley");
        expect(execSpy).toHaveBeenCalledWith(
          expect.stringContaining("'\\''")
        );
      });

      it('should use single SSH exec call with marker', async () => {
        mockExecOutput('<<DIR_MARKER>>\n');
        await connection.listEntries('/opt');
        expect(execSpy).toHaveBeenCalledTimes(1);
        const cmd = execSpy.mock.calls[0][0] as string;
        expect(cmd).toContain('<<DIR_MARKER>>');
        expect(cmd).toContain('-type f');
        expect(cmd).toContain('-type d');
      });

      it('should support comma-separated file patterns with OR', async () => {
        mockExecOutput('<<DIR_MARKER>>\n');
        await connection.listEntries('/opt', '*.ts, *.js');
        const cmd = execSpy.mock.calls[0][0] as string;
        expect(cmd).toContain("\\( -name '*.ts' -o -name '*.js' \\)");
      });

      it('should use simple -name for single pattern', async () => {
        mockExecOutput('<<DIR_MARKER>>\n');
        await connection.listEntries('/opt', '*.ts');
        const cmd = execSpy.mock.calls[0][0] as string;
        expect(cmd).toContain("-name '*.ts'");
        expect(cmd).not.toContain('\\(');
      });

      it('should handle three comma-separated patterns', async () => {
        mockExecOutput('<<DIR_MARKER>>\n');
        await connection.listEntries('/opt', '*.ts, *.js, *.json');
        const cmd = execSpy.mock.calls[0][0] as string;
        expect(cmd).toContain("\\( -name '*.ts' -o -name '*.js' -o -name '*.json' \\)");
      });
    });
  });

  describe('connection state', () => {
    it('should define all valid states', () => {
      expect(ConnectionState.Disconnected).toBeDefined();
      expect(ConnectionState.Connecting).toBeDefined();
      expect(ConnectionState.Connected).toBeDefined();
      expect(ConnectionState.Error).toBeDefined();
    });

    it('should have 4 distinct states', () => {
      const states = new Set([
        ConnectionState.Disconnected,
        ConnectionState.Connecting,
        ConnectionState.Connected,
        ConnectionState.Error,
      ]);
      expect(states.size).toBe(4);
    });

    it('should start disconnected', () => {
      expect(connection.state).toBe(ConnectionState.Disconnected);
    });

    it('should have null client initially', () => {
      expect(connection.client).toBeNull();
    });
  });

  describe('Sudo mode state management', () => {
    it('should start with sudo mode disabled', () => {
      expect(connection.sudoMode).toBe(false);
      expect(connection.sudoPassword).toBeNull();
    });

    it('should enable sudo mode with password', () => {
      connection.enableSudoMode('mypassword');
      expect(connection.sudoMode).toBe(true);
      expect(connection.sudoPassword).toBe('mypassword');
    });

    it('should disable sudo mode and clear password', () => {
      connection.enableSudoMode('mypassword');
      connection.disableSudoMode();
      expect(connection.sudoMode).toBe(false);
      expect(connection.sudoPassword).toBeNull();
    });

    it('should clear sudo mode on handleDisconnect', () => {
      connection.enableSudoMode('mypassword');
      // Trigger handleDisconnect via internal method
      (connection as any).handleDisconnect();
      expect(connection.sudoMode).toBe(false);
      expect(connection.sudoPassword).toBeNull();
    });

    it('should allow re-enabling sudo mode with different password', () => {
      connection.enableSudoMode('password1');
      connection.enableSudoMode('password2');
      expect(connection.sudoPassword).toBe('password2');
    });
  });

  describe('Sudo operations', () => {
    let writtenData: any[];
    let lastExecCmd: string;

    // Create a mock stream that fires close(0) immediately after end() is called
    function createAutoStream(opts?: { exitCode?: number; stdout?: string; stderr?: string }) {
      const exitCode = opts?.exitCode ?? 0;
      const stdout = opts?.stdout ?? '';
      const stderr = opts?.stderr ?? '';
      const dataHandlers: any[] = [];
      const stderrHandlers: any[] = [];
      const closeHandlers: any[] = [];

      const stream: any = {
        on: jest.fn().mockImplementation((event: string, handler: any) => {
          if (event === 'data') { dataHandlers.push(handler); }
          if (event === 'close') { closeHandlers.push(handler); }
          return stream;
        }),
        stderr: {
          on: jest.fn().mockImplementation((event: string, handler: any) => {
            if (event === 'data') { stderrHandlers.push(handler); }
            return stream.stderr;
          }),
        },
        write: jest.fn().mockImplementation((data: any) => {
          writtenData.push(data);
        }),
        end: jest.fn().mockImplementation(() => {
          // Fire events after end() — simulates server processing
          process.nextTick(() => {
            if (stdout) { dataHandlers.forEach(h => h(Buffer.from(stdout))); }
            if (stderr) { stderrHandlers.forEach(h => h(Buffer.from(stderr))); }
            closeHandlers.forEach(h => h(exitCode));
          });
        }),
        destroy: jest.fn(),
      };
      return stream;
    }

    beforeEach(() => {
      writtenData = [];
      lastExecCmd = '';

      (connection as any).state = ConnectionState.Connected;
      (connection as any)._client = {
        exec: jest.fn().mockImplementation((cmd: string, cb: (err: Error | null, stream: any) => void) => {
          lastExecCmd = cmd;
          cb(null, createAutoStream());
        }),
      };
    });

    describe('sudoExec', () => {
      it('should send password via stdin followed by newline', async () => {
        (connection as any)._client.exec.mockImplementation((cmd: string, cb: any) => {
          lastExecCmd = cmd;
          cb(null, createAutoStream({ stdout: 'root\n' }));
        });
        const result = await connection.sudoExec('whoami', 'secret');
        expect(result).toBe('root\n');
        expect(writtenData[0]).toBe('secret\n');
      });

      it('should construct sudo -S -p command', async () => {
        await connection.sudoExec('ls /root', 'pass');
        expect(lastExecCmd).toBe("sudo -S -p '' -- ls /root");
      });

      it('should throw on incorrect password', async () => {
        (connection as any)._client.exec.mockImplementation((_cmd: string, cb: any) => {
          cb(null, createAutoStream({ exitCode: 1, stderr: 'Sorry, try again.' }));
        });
        await expect(connection.sudoExec('ls /root', 'wrong')).rejects.toThrow('incorrect password');
      });

      it('should throw on non-zero exit code', async () => {
        (connection as any)._client.exec.mockImplementation((_cmd: string, cb: any) => {
          cb(null, createAutoStream({ exitCode: 2, stderr: 'No such file' }));
        });
        await expect(connection.sudoExec('ls /nonexistent', 'pass')).rejects.toThrow('exit 2');
      });

      it('should throw ConnectionError when not connected', async () => {
        (connection as any).state = ConnectionState.Disconnected;
        (connection as any)._client = null;
        await expect(connection.sudoExec('whoami', 'pass')).rejects.toThrow('Not connected');
      });
    });

    describe('sudoWriteFile', () => {
      it('should pipe password then content for text files', async () => {
        const content = Buffer.from('server { listen 80; }');
        await connection.sudoWriteFile('/etc/nginx/nginx.conf', content, 'pass');
        expect(writtenData[0]).toBe('pass\n');
        expect(writtenData[1]).toEqual(content);
      });

      it('should use tee command for text files', async () => {
        await connection.sudoWriteFile('/etc/hosts', Buffer.from('data'), 'pass');
        expect(lastExecCmd).toContain('tee');
        expect(lastExecCmd).toContain('/etc/hosts');
        expect(lastExecCmd).toContain('> /dev/null');
      });

      it('should use base64 pipeline for binary files', async () => {
        const content = Buffer.from([0x00, 0x01, 0x02, 0xFF]);
        await connection.sudoWriteFile('/usr/bin/app', content, 'pass');
        expect(lastExecCmd).toContain('base64 -d');
        expect(writtenData[1]).toEqual(Buffer.from(content.toString('base64')));
      });

      it('should escape single quotes in path', async () => {
        await connection.sudoWriteFile("/etc/it's/config", Buffer.from('x'), 'pass');
        expect(lastExecCmd).toContain("it'\\''s");
      });
    });

    describe('sudoReadFile', () => {
      it('should use sudo cat to read file', async () => {
        (connection as any)._client.exec.mockImplementation((cmd: string, cb: any) => {
          lastExecCmd = cmd;
          cb(null, createAutoStream({ stdout: 'root:x:0:0' }));
        });
        const result = await connection.sudoReadFile('/etc/shadow', 'pass');
        expect(result.toString()).toBe('root:x:0:0');
        expect(lastExecCmd).toContain("cat '/etc/shadow'");
      });
    });

    describe('sudoDeleteFile', () => {
      it('should use rm for files', async () => {
        await connection.sudoDeleteFile('/etc/old.conf', 'pass', false);
        expect(lastExecCmd).toContain("rm '/etc/old.conf'");
        expect(lastExecCmd).not.toContain('-rf');
      });

      it('should use rm -rf for directories', async () => {
        await connection.sudoDeleteFile('/opt/oldapp', 'pass', true);
        expect(lastExecCmd).toContain("rm -rf '/opt/oldapp'");
      });
    });

    describe('sudoMkdir', () => {
      it('should use mkdir -p', async () => {
        await connection.sudoMkdir('/opt/newapp/config', 'pass');
        expect(lastExecCmd).toContain("mkdir -p '/opt/newapp/config'");
      });
    });

    describe('sudoRename', () => {
      it('should use mv with both paths escaped', async () => {
        await connection.sudoRename('/etc/old.conf', '/etc/new.conf', 'pass');
        expect(lastExecCmd).toContain("mv '/etc/old.conf' '/etc/new.conf'");
      });
    });

    describe('sudoListFiles', () => {
      it('should parse ls -la output into IRemoteFile array', async () => {
        const lsOutput = [
          'total 12',
          'drwxr-xr-x 2 root root 4096 Jan  1 12:00 subdir',
          '-rw-r--r-- 1 www-data www-data 1234 Feb 15 09:30 index.html',
          'lrwxrwxrwx 1 root root   11 Mar  1 08:00 link -> /etc/hosts',
        ].join('\n');
        (connection as any)._client.exec.mockImplementation((cmd: string, cb: any) => {
          lastExecCmd = cmd;
          cb(null, createAutoStream({ stdout: lsOutput }));
        });

        const files = await connection.sudoListFiles('/var/www', 'pass');
        expect(files).toHaveLength(3);
        expect(files[0].name).toBe('subdir');
        expect(files[0].isDirectory).toBe(true);
        expect(files[0].path).toBe('/var/www/subdir');
        expect(files[0].owner).toBe('root:root');
        expect(files[0].connectionId).toBe(connection.id);
        expect(files[1].name).toBe('index.html');
        expect(files[1].size).toBe(1234);
        expect(files[2].name).toBe('link');
      });

      it('should skip . and .. entries', async () => {
        const lsOutput = [
          'total 4',
          'drwxr-xr-x 2 root root 4096 Jan  1 12:00 .',
          'drwxr-xr-x 3 root root 4096 Jan  1 12:00 ..',
          '-rw-r--r-- 1 root root  100 Jan  1 12:00 file.txt',
        ].join('\n');
        (connection as any)._client.exec.mockImplementation((_cmd: string, cb: any) => {
          cb(null, createAutoStream({ stdout: lsOutput }));
        });

        const files = await connection.sudoListFiles('/root', 'pass');
        expect(files).toHaveLength(1);
        expect(files[0].name).toBe('file.txt');
      });
    });

    describe('escapePath', () => {
      it('should escape single quotes', () => {
        const escape = (connection as any).escapePath.bind(connection);
        expect(escape("it's a file")).toBe("it'\\''s a file");
      });

      it('should not modify paths without quotes', () => {
        const escape = (connection as any).escapePath.bind(connection);
        expect(escape('/etc/hosts')).toBe('/etc/hosts');
      });
    });
  });
});
