/**
 * Multi-OS File Operations Integration Tests
 *
 * Tests SSHConnection file operations (SFTP + command-based) against 5 Docker server OS.
 * Covers: listFiles, readFile, readFileChunked, readFileLastLines, readFileFirstLines,
 *         writeFile, deleteFile, mkdir, stat, fileExists, searchFiles.
 */
import { SSHConnection } from '../connection/SSHConnection';
import { IRemoteFile, SFTPError } from '../types';
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
});

// ---- Per-OS File Operation Tests ----
describe.each(CI_SERVERS)('File operations on $os', (server: OSServerConfig) => {
  let conn: SSHConnection;
  const testDir = `/home/testuser/fileops-test-${server.hostname}`;

  beforeAll(async () => {
    conn = await createTestConnection(server);
    // Create test directory for this OS
    try {
      await conn.exec(`rm -rf ${testDir}`);
    } catch { /* ignore */ }
    await conn.mkdir(testDir);
  });

  afterAll(async () => {
    // Cleanup test directory
    try {
      await conn.exec(`rm -rf ${testDir}`);
    } catch { /* ignore */ }
    await safeDisconnect(conn);
  });

  // -- listFiles --
  describe('listFiles', () => {
    it('should list home directory', async () => {
      const files = await conn.listFiles('/home/testuser');
      expect(files.length).toBeGreaterThan(0);
      const names = files.map(f => f.name);
      expect(names).toContain('projects');
    });

    it('should return IRemoteFile with all fields', async () => {
      const files = await conn.listFiles('/home/testuser/projects');
      expect(files.length).toBeGreaterThan(0);
      const file = files.find(f => f.name === 'package.json');
      expect(file).toBeDefined();
      expect(file!.name).toBe('package.json');
      expect(file!.path).toBe('/home/testuser/projects/package.json');
      expect(file!.isDirectory).toBe(false);
      expect(file!.size).toBeGreaterThan(0);
      expect(file!.modifiedTime).toBeGreaterThan(0);
      expect(file!.owner).toBeDefined();
      expect(file!.group).toBeDefined();
      expect(file!.permissions).toBeDefined();
      expect(file!.connectionId).toBe(conn.id);
    });

    it('should sort directories before files', async () => {
      const files = await conn.listFiles('/home/testuser');
      const firstDir = files.findIndex(f => f.isDirectory);
      const firstFile = files.findIndex(f => !f.isDirectory);
      if (firstDir >= 0 && firstFile >= 0) {
        expect(firstDir).toBeLessThan(firstFile);
      }
    });

    it('should filter out . and ..', async () => {
      const files = await conn.listFiles('/home/testuser');
      const names = files.map(f => f.name);
      expect(names).not.toContain('.');
      expect(names).not.toContain('..');
    });

    it('should list empty directory', async () => {
      const emptyDir = `${testDir}/empty`;
      await conn.mkdir(emptyDir);
      const files = await conn.listFiles(emptyDir);
      expect(files).toHaveLength(0);
    });

    it('should expand ~ to home directory', async () => {
      const files = await conn.listFiles('~');
      expect(files.length).toBeGreaterThan(0);
      const names = files.map(f => f.name);
      expect(names).toContain('projects');
    });
  });

  // -- readFile --
  describe('readFile', () => {
    it('should read existing file content', async () => {
      const content = await conn.readFile('/home/testuser/projects/src/app.ts');
      expect(content).toBeInstanceOf(Buffer);
      expect(content.toString()).toContain('console.log');
    });

    it('should read UTF-8 content', async () => {
      const utf8Content = 'Hello World - Xin chao - \u00e9\u00e0\u00fc\u00f1\u00f1';
      await conn.writeFile(`${testDir}/utf8.txt`, Buffer.from(utf8Content));
      const content = await conn.readFile(`${testDir}/utf8.txt`);
      expect(content.toString()).toBe(utf8Content);
    });

    it('should throw SFTPError for non-existent file', async () => {
      await expect(conn.readFile('/home/testuser/nonexistent.xyz'))
        .rejects.toThrow();
    });
  });

  // -- readFileChunked --
  describe('readFileChunked', () => {
    it('should read file with progress callback', async () => {
      const progressCalls: number[] = [];
      const content = await conn.readFileChunked(
        '/home/testuser/projects/src/app.ts',
        (transferred, _total) => { progressCalls.push(transferred); }
      );
      expect(content).toBeInstanceOf(Buffer);
      expect(content.toString()).toContain('console.log');
    });
  });

  // -- readFileLastLines / readFileFirstLines --
  describe('readFileLastLines / readFileFirstLines', () => {
    beforeAll(async () => {
      const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
      await conn.writeFile(`${testDir}/lines.txt`, Buffer.from(lines));
    });

    it('should read last N lines with tail', async () => {
      const result = await conn.readFileLastLines(`${testDir}/lines.txt`, 3);
      const lines = result.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[2]).toBe('line10');
    });

    it('should read first N lines with head', async () => {
      const result = await conn.readFileFirstLines(`${testDir}/lines.txt`, 3);
      const lines = result.trim().split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe('line1');
    });
  });

  // -- writeFile --
  describe('writeFile', () => {
    it('should write and read back content', async () => {
      const content = 'test content from integration test';
      await conn.writeFile(`${testDir}/write-test.txt`, Buffer.from(content));
      const readBack = await conn.readFile(`${testDir}/write-test.txt`);
      expect(readBack.toString()).toBe(content);
    });

    it('should overwrite existing file', async () => {
      await conn.writeFile(`${testDir}/overwrite.txt`, Buffer.from('original'));
      await conn.writeFile(`${testDir}/overwrite.txt`, Buffer.from('updated'));
      const content = await conn.readFile(`${testDir}/overwrite.txt`);
      expect(content.toString()).toBe('updated');
    });

    it('should write binary-like content', async () => {
      const binary = Buffer.from([0x00, 0x01, 0x02, 0xFF, 0xFE, 0xFD]);
      await conn.writeFile(`${testDir}/binary.bin`, binary);
      const readBack = await conn.readFile(`${testDir}/binary.bin`);
      expect(readBack.equals(binary)).toBe(true);
    });
  });

  // -- deleteFile --
  describe('deleteFile', () => {
    it('should delete a regular file', async () => {
      await conn.writeFile(`${testDir}/to-delete.txt`, Buffer.from('delete me'));
      expect(await conn.fileExists(`${testDir}/to-delete.txt`)).toBe(true);
      await conn.deleteFile(`${testDir}/to-delete.txt`);
      expect(await conn.fileExists(`${testDir}/to-delete.txt`)).toBe(false);
    });

    it('should delete an empty directory', async () => {
      await conn.mkdir(`${testDir}/to-delete-dir`);
      expect(await conn.fileExists(`${testDir}/to-delete-dir`)).toBe(true);
      await conn.deleteFile(`${testDir}/to-delete-dir`);
      expect(await conn.fileExists(`${testDir}/to-delete-dir`)).toBe(false);
    });
  });

  // -- mkdir --
  describe('mkdir', () => {
    it('should create a directory', async () => {
      await conn.mkdir(`${testDir}/new-dir`);
      const stat = await conn.stat(`${testDir}/new-dir`);
      expect(stat.isDirectory).toBe(true);
    });
  });

  // -- stat / fileExists --
  describe('stat / fileExists', () => {
    it('should stat a regular file', async () => {
      await conn.writeFile(`${testDir}/stat-test.txt`, Buffer.from('stat me'));
      const stat = await conn.stat(`${testDir}/stat-test.txt`);
      expect(stat.isDirectory).toBe(false);
      expect(stat.size).toBeGreaterThan(0);
      expect(stat.modifiedTime).toBeGreaterThan(0);
      expect(stat.name).toBe('stat-test.txt');
    });

    it('should stat a directory', async () => {
      const stat = await conn.stat('/home/testuser/projects');
      expect(stat.isDirectory).toBe(true);
    });

    it('should throw for non-existent path', async () => {
      await expect(conn.stat('/home/testuser/doesnotexist'))
        .rejects.toThrow();
    });

    it('should return true for existing file', async () => {
      expect(await conn.fileExists('/home/testuser/projects/package.json')).toBe(true);
    });

    it('should return false for non-existent file', async () => {
      expect(await conn.fileExists('/home/testuser/no-such-file.xyz')).toBe(false);
    });
  });

  // -- searchFiles --
  describe('searchFiles', () => {
    beforeAll(async () => {
      const searchDir = `${testDir}/search`;
      await conn.mkdir(searchDir);
      await conn.writeFile(`${searchDir}/hello.ts`, Buffer.from('function greet() { return "hello world"; }'));
      await conn.writeFile(`${searchDir}/config.json`, Buffer.from('{"greeting": "hello"}'));
      await conn.writeFile(`${searchDir}/readme.md`, Buffer.from('This project says HELLO'));
    });

    it('should find content matches (grep mode)', async () => {
      const results = await conn.searchFiles(`${testDir}/search`, 'hello', {
        searchContent: true,
        caseSensitive: true,
      });
      expect(results.length).toBeGreaterThanOrEqual(2);
      const paths = results.map(r => r.path);
      expect(paths.some(p => p.includes('hello.ts'))).toBe(true);
      expect(paths.some(p => p.includes('config.json'))).toBe(true);
    });

    it('should find files by name (find mode)', async () => {
      const results = await conn.searchFiles(`${testDir}/search`, 'hello', {
        searchContent: false,
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      const paths = results.map(r => r.path);
      expect(paths.some(p => p.includes('hello.ts'))).toBe(true);
    });

    it('should support case-insensitive search', async () => {
      const results = await conn.searchFiles(`${testDir}/search`, 'HELLO', {
        searchContent: true,
        caseSensitive: false,
      });
      expect(results.length).toBeGreaterThanOrEqual(3); // all 3 files contain hello/HELLO
    });

    it('should return empty for no matches', async () => {
      const results = await conn.searchFiles(`${testDir}/search`, 'zzz_no_match_zzz', {
        searchContent: true,
      });
      expect(results).toHaveLength(0);
    });

    it('should filter by file pattern', async () => {
      const results = await conn.searchFiles(`${testDir}/search`, 'hello', {
        searchContent: true,
        caseSensitive: true,
        filePattern: '*.ts',
      });
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.path).toMatch(/\.ts$/);
      }
    });
  });

  // -- listDirectories --
  describe('listDirectories', () => {
    beforeAll(async () => {
      const dirBase = `${testDir}/listdirs`;
      await conn.mkdir(dirBase);
      await conn.mkdir(`${dirBase}/alpha`);
      await conn.mkdir(`${dirBase}/beta`);
      await conn.mkdir(`${dirBase}/gamma`);
      await conn.writeFile(`${dirBase}/file1.txt`, Buffer.from('not a directory'));
      await conn.writeFile(`${dirBase}/file2.log`, Buffer.from('also not a directory'));
    });

    it('should list only subdirectories, not files', async () => {
      const dirs = await conn.listDirectories(`${testDir}/listdirs`);
      expect(dirs.length).toBe(3);
      for (const d of dirs) {
        expect(d).not.toMatch(/file[12]/);
      }
    });

    it('should return sorted results', async () => {
      const dirs = await conn.listDirectories(`${testDir}/listdirs`);
      const sorted = [...dirs].sort();
      expect(dirs).toEqual(sorted);
    });

    it('should return full paths', async () => {
      const dirs = await conn.listDirectories(`${testDir}/listdirs`);
      for (const d of dirs) {
        expect(d).toMatch(/^\//); // absolute path
        expect(d).toContain(`${testDir}/listdirs/`);
      }
    });

    it('should return empty array for empty directory', async () => {
      // alpha has no subdirectories
      const dirs = await conn.listDirectories(`${testDir}/listdirs/alpha`);
      expect(dirs).toEqual([]);
    });

    it('should handle directory with only files (no subdirs)', async () => {
      const onlyFiles = `${testDir}/listdirs-onlyfiles`;
      await conn.mkdir(onlyFiles);
      await conn.writeFile(`${onlyFiles}/a.txt`, Buffer.from('data'));
      const dirs = await conn.listDirectories(onlyFiles);
      expect(dirs).toEqual([]);
    });
  });

  // -- searchFiles with multiple paths (string[]) --
  describe('searchFiles multi-path', () => {
    beforeAll(async () => {
      const base = `${testDir}/multi-search`;
      await conn.mkdir(base);
      await conn.mkdir(`${base}/dir1`);
      await conn.mkdir(`${base}/dir2`);
      await conn.mkdir(`${base}/dir3`);
      await conn.writeFile(`${base}/dir1/match.ts`, Buffer.from('export const TOKEN_MULTI = "found1";'));
      await conn.writeFile(`${base}/dir2/match.ts`, Buffer.from('export const TOKEN_MULTI = "found2";'));
      await conn.writeFile(`${base}/dir3/no-match.ts`, Buffer.from('nothing here'));
    });

    it('should search across multiple paths (grep)', async () => {
      const results = await conn.searchFiles(
        [`${testDir}/multi-search/dir1`, `${testDir}/multi-search/dir2`],
        'TOKEN_MULTI',
        { searchContent: true }
      );
      expect(results.length).toBeGreaterThanOrEqual(2);
      const paths = results.map(r => r.path);
      expect(paths.some(p => p.includes('dir1'))).toBe(true);
      expect(paths.some(p => p.includes('dir2'))).toBe(true);
    });

    it('should not return results from paths not included', async () => {
      const results = await conn.searchFiles(
        [`${testDir}/multi-search/dir1`],
        'TOKEN_MULTI',
        { searchContent: true }
      );
      expect(results.length).toBeGreaterThanOrEqual(1);
      for (const r of results) {
        expect(r.path).not.toContain('dir2');
        expect(r.path).not.toContain('dir3');
      }
    });

    it('should search multiple paths by filename (find)', async () => {
      const results = await conn.searchFiles(
        [`${testDir}/multi-search/dir1`, `${testDir}/multi-search/dir2`, `${testDir}/multi-search/dir3`],
        'match',
        { searchContent: false }
      );
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it('should handle single-element array same as string', async () => {
      const arrayResult = await conn.searchFiles(
        [`${testDir}/multi-search/dir1`],
        'TOKEN_MULTI',
        { searchContent: true }
      );
      const stringResult = await conn.searchFiles(
        `${testDir}/multi-search/dir1`,
        'TOKEN_MULTI',
        { searchContent: true }
      );
      expect(arrayResult.length).toBe(stringResult.length);
    });
  });

  // -- rename (file rename) --
  describe('rename', () => {
    it('should rename a file', async () => {
      await conn.writeFile(`${testDir}/before-rename.txt`, Buffer.from('rename test'));
      await conn.rename(`${testDir}/before-rename.txt`, `${testDir}/after-rename.txt`);

      // Old file should not exist
      const oldExists = await conn.fileExists(`${testDir}/before-rename.txt`);
      expect(oldExists).toBe(false);

      // New file should exist with same content
      const content = await conn.readFile(`${testDir}/after-rename.txt`);
      expect(content.toString()).toBe('rename test');

      // Cleanup
      await conn.deleteFile(`${testDir}/after-rename.txt`);
    });

    it('should rename a directory', async () => {
      await conn.mkdir(`${testDir}/dir-old-name`);
      await conn.writeFile(`${testDir}/dir-old-name/inside.txt`, Buffer.from('inside'));

      await conn.rename(`${testDir}/dir-old-name`, `${testDir}/dir-new-name`);

      // Old dir should not exist
      const oldExists = await conn.fileExists(`${testDir}/dir-old-name`);
      expect(oldExists).toBe(false);

      // New dir should exist with contents
      const content = await conn.readFile(`${testDir}/dir-new-name/inside.txt`);
      expect(content.toString()).toBe('inside');

      // Cleanup
      await conn.exec(`rm -rf ${testDir}/dir-new-name`);
    });

    it('should reject rename of non-existent file', async () => {
      await expect(
        conn.rename(`${testDir}/does-not-exist.txt`, `${testDir}/new-name.txt`)
      ).rejects.toThrow();
    });

    it('should rename with special characters', async () => {
      await conn.writeFile(`${testDir}/file with spaces.txt`, Buffer.from('spaces'));
      await conn.rename(`${testDir}/file with spaces.txt`, `${testDir}/file-no-spaces.txt`);

      const content = await conn.readFile(`${testDir}/file-no-spaces.txt`);
      expect(content.toString()).toBe('spaces');

      await conn.deleteFile(`${testDir}/file-no-spaces.txt`);
    });
  });

  // -- move (rename across directories) --
  describe('move', () => {
    const moveDir = (sub: string) => `${testDir}/move-test/${sub}`;

    beforeAll(async () => {
      await conn.mkdir(`${testDir}/move-test`);
      await conn.mkdir(`${testDir}/move-test/src`);
      await conn.mkdir(`${testDir}/move-test/dest`);
    });

    afterAll(async () => {
      try { await conn.exec(`rm -rf ${testDir}/move-test`); } catch { /* ignore */ }
    });

    it('should move a file to a different directory', async () => {
      await conn.writeFile(moveDir('src/moveme.txt'), Buffer.from('move content'));
      await conn.rename(moveDir('src/moveme.txt'), moveDir('dest/moveme.txt'));

      // Source should be gone
      const srcExists = await conn.fileExists(moveDir('src/moveme.txt'));
      expect(srcExists).toBe(false);

      // Destination should have the content
      const content = await conn.readFile(moveDir('dest/moveme.txt'));
      expect(content.toString()).toBe('move content');

      await conn.deleteFile(moveDir('dest/moveme.txt'));
    });

    it('should move and rename simultaneously', async () => {
      await conn.writeFile(moveDir('src/original.ts'), Buffer.from('code'));
      await conn.rename(moveDir('src/original.ts'), moveDir('dest/renamed.ts'));

      const srcExists = await conn.fileExists(moveDir('src/original.ts'));
      expect(srcExists).toBe(false);

      const content = await conn.readFile(moveDir('dest/renamed.ts'));
      expect(content.toString()).toBe('code');

      await conn.deleteFile(moveDir('dest/renamed.ts'));
    });

    it('should move a directory to a different location', async () => {
      await conn.mkdir(moveDir('src/subdir'));
      await conn.writeFile(moveDir('src/subdir/data.json'), Buffer.from('{"key":"value"}'));

      await conn.rename(moveDir('src/subdir'), moveDir('dest/subdir'));

      const srcExists = await conn.fileExists(moveDir('src/subdir'));
      expect(srcExists).toBe(false);

      const content = await conn.readFile(moveDir('dest/subdir/data.json'));
      expect(content.toString()).toBe('{"key":"value"}');

      await conn.exec(`rm -rf ${moveDir('dest/subdir')}`);
    });

    it('should reject move to non-existent parent directory', async () => {
      await conn.writeFile(moveDir('src/orphan.txt'), Buffer.from('orphan'));

      await expect(
        conn.rename(moveDir('src/orphan.txt'), moveDir('nonexistent/orphan.txt'))
      ).rejects.toThrow();

      // Original should still exist
      const exists = await conn.fileExists(moveDir('src/orphan.txt'));
      expect(exists).toBe(true);

      await conn.deleteFile(moveDir('src/orphan.txt'));
    });
  });

  // -- listEntries (file-level worker pool support) --
  describe('listEntries', () => {
    const entriesDir = `${testDir}/list-entries-test`;

    beforeAll(async () => {
      // Create test structure:
      // list-entries-test/
      //   file1.ts
      //   file2.py
      //   readme.md
      //   sub-a/
      //   sub-b/
      //   empty-dir/
      await conn.mkdir(entriesDir);
      await conn.writeFile(`${entriesDir}/file1.ts`, Buffer.from('ts'));
      await conn.writeFile(`${entriesDir}/file2.py`, Buffer.from('py'));
      await conn.writeFile(`${entriesDir}/readme.md`, Buffer.from('md'));
      await conn.mkdir(`${entriesDir}/sub-a`);
      await conn.mkdir(`${entriesDir}/sub-b`);
      await conn.mkdir(`${entriesDir}/empty-dir`);
      await conn.writeFile(`${entriesDir}/sub-a/nested.ts`, Buffer.from('nested'));
    });

    afterAll(async () => {
      try { await conn.exec(`rm -rf ${entriesDir}`); } catch { /* ignore */ }
    });

    it('should return files and dirs at one level', async () => {
      const result = await conn.listEntries(entriesDir);

      expect(result.files.length).toBe(3);
      expect(result.dirs.length).toBe(3);

      // Files should be sorted
      const fileNames = result.files.map(f => f.split('/').pop());
      expect(fileNames).toContain('file1.ts');
      expect(fileNames).toContain('file2.py');
      expect(fileNames).toContain('readme.md');

      // Dirs should be sorted
      const dirNames = result.dirs.map(d => d.split('/').pop());
      expect(dirNames).toContain('sub-a');
      expect(dirNames).toContain('sub-b');
      expect(dirNames).toContain('empty-dir');
    });

    it('should NOT include nested files (non-recursive)', async () => {
      const result = await conn.listEntries(entriesDir);

      // nested.ts is in sub-a/, should NOT appear in top-level files
      const allPaths = result.files.join(' ');
      expect(allPaths).not.toContain('nested.ts');
    });

    it('should filter files by pattern', async () => {
      const result = await conn.listEntries(entriesDir, '*.ts');

      expect(result.files.length).toBe(1);
      expect(result.files[0]).toContain('file1.ts');

      // Dirs should still all be returned (pattern only affects files)
      expect(result.dirs.length).toBe(3);
    });

    it('should return empty arrays for empty directory', async () => {
      const result = await conn.listEntries(`${entriesDir}/empty-dir`);

      expect(result.files).toEqual([]);
      expect(result.dirs).toEqual([]);
    });

    it('should return full absolute paths', async () => {
      const result = await conn.listEntries(entriesDir);

      for (const file of result.files) {
        expect(file).toMatch(/^\//); // starts with /
        expect(file).toContain(entriesDir); // contains parent
      }
      for (const dir of result.dirs) {
        expect(dir).toMatch(/^\//);
        expect(dir).toContain(entriesDir);
      }
    });

    it('should handle subdirectory listing', async () => {
      const result = await conn.listEntries(`${entriesDir}/sub-a`);

      expect(result.files.length).toBe(1);
      expect(result.files[0]).toContain('nested.ts');
      expect(result.dirs.length).toBe(0);
    });
  });
});

// ---- Cross-OS File Operations ----
describe('Cross-OS file operations', () => {
  it('should write and read files on all 5 OS in parallel', async () => {
    const connections = await Promise.all(
      CI_SERVERS.map(server => createTestConnection(server))
    );

    try {
      // Write OS-specific files
      await Promise.all(
        connections.map((conn, i) =>
          conn.writeFile(`/home/testuser/cross-os-test-${i}.txt`, Buffer.from(`data from ${CI_SERVERS[i].os}`))
        )
      );

      // Read back
      const contents = await Promise.all(
        connections.map((conn, i) =>
          conn.readFile(`/home/testuser/cross-os-test-${i}.txt`).then(b => b.toString())
        )
      );

      for (let i = 0; i < 5; i++) {
        expect(contents[i]).toBe(`data from ${CI_SERVERS[i].os}`);
      }

      // Cleanup
      await Promise.allSettled(
        connections.map((conn, i) => conn.deleteFile(`/home/testuser/cross-os-test-${i}.txt`))
      );
    } finally {
      await disconnectAll(connections);
    }
  });

  it('should list files on all 5 OS in parallel', async () => {
    const connections = await Promise.all(
      CI_SERVERS.map(server => createTestConnection(server))
    );

    try {
      const fileLists = await Promise.all(
        connections.map(conn => conn.listFiles('/home/testuser'))
      );

      for (const files of fileLists) {
        expect(files.length).toBeGreaterThan(0);
        const names = files.map(f => f.name);
        expect(names).toContain('projects');
      }
    } finally {
      await disconnectAll(connections);
    }
  });
});
