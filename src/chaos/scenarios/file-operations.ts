/**
 * Chaos Scenarios: File Operations
 *
 * Tests read/write/delete/mkdir/rename/stat with invariant verification.
 * Every file operation verifies its contract holds.
 */

import { SSHConnection } from '../../connection/SSHConnection';
import { ScenarioDefinition, ScenarioContext, ScenarioResult } from '../ChaosConfig';
import { ChaosValidator } from '../ChaosValidator';
import { createChaosConnection, safeChaosDisconnect, SeededRandom } from '../chaos-helpers';

const CATEGORY = 'file-operations';

async function makeResult(
  name: string,
  ctx: ScenarioContext,
  fn: (conn: SSHConnection, validator: ChaosValidator, rng: SeededRandom) => Promise<string[]>
): Promise<ScenarioResult> {
  const start = Date.now();
  let conn: SSHConnection | null = null;
  try {
    conn = await createChaosConnection(ctx.server);
    await conn.mkdir(ctx.testDir).catch(() => {});
    const validator = new ChaosValidator();
    const rng = new SeededRandom(ctx.seed + ctx.variation);

    const extraViolations = await fn(conn, validator, rng);

    return {
      name: `${CATEGORY}:${name}`,
      server: ctx.server.label,
      server_os: ctx.server.os,
      passed: validator.getViolations().length === 0 && extraViolations.length === 0,
      invariantViolations: [...validator.getViolations(), ...extraViolations],
      anomalies: [],
      stateTimeline: [],
      duration_ms: Date.now() - start,
    };
  } catch (err) {
    return {
      name: `${CATEGORY}:${name}`,
      server: ctx.server.label,
      server_os: ctx.server.os,
      passed: false,
      invariantViolations: [],
      anomalies: [],
      stateTimeline: [],
      duration_ms: Date.now() - start,
      error: (err as Error).message,
    };
  } finally {
    if (conn) {
      try { await conn.exec(`rm -rf ${ctx.testDir}`); } catch {}
      await safeChaosDisconnect(conn);
    }
  }
}

export const fileOperationsScenarios: ScenarioDefinition[] = [
  {
    name: 'write-read-verify',
    category: CATEGORY,
    fn: (ctx) => makeResult('write-read-verify', ctx, async (conn, validator, rng) => {
      const content = rng.string(rng.int(10, 1000));
      const filePath = `${ctx.testDir}/write-read-${rng.string(6)}.txt`;

      await conn.writeFile(filePath, Buffer.from(content));
      await validator.verifyWrite(conn, filePath, content);

      return [];
    }),
  },
  {
    name: 'write-binary-verify',
    category: CATEGORY,
    fn: (ctx) => makeResult('write-binary-verify', ctx, async (conn, validator, rng) => {
      const content = rng.bytes(rng.int(10, 2000));
      const filePath = `${ctx.testDir}/binary-${rng.string(6)}.bin`;

      await conn.writeFile(filePath, content);
      await validator.verifyWrite(conn, filePath, content);

      return [];
    }),
  },
  {
    name: 'write-empty-file',
    category: CATEGORY,
    fn: (ctx) => makeResult('write-empty-file', ctx, async (conn, validator) => {
      const filePath = `${ctx.testDir}/empty.txt`;

      await conn.writeFile(filePath, Buffer.from(''));
      await validator.verifyWrite(conn, filePath, '');

      return [];
    }),
  },
  {
    name: 'mkdir-verify',
    category: CATEGORY,
    fn: (ctx) => makeResult('mkdir-verify', ctx, async (conn, validator, rng) => {
      const dirName = `subdir-${rng.string(6)}`;
      const dirPath = `${ctx.testDir}/${dirName}`;

      await conn.mkdir(dirPath);
      await validator.verifyMkdir(conn, dirPath, ctx.testDir);

      return [];
    }),
  },
  {
    name: 'delete-file-verify',
    category: CATEGORY,
    fn: (ctx) => makeResult('delete-file-verify', ctx, async (conn, validator, rng) => {
      const filePath = `${ctx.testDir}/to-delete-${rng.string(6)}.txt`;

      await conn.writeFile(filePath, Buffer.from('delete me'));
      await conn.deleteFile(filePath);
      await validator.verifyDelete(conn, filePath);

      return [];
    }),
  },
  {
    name: 'delete-dir-verify',
    category: CATEGORY,
    fn: (ctx) => makeResult('delete-dir-verify', ctx, async (conn, validator, rng) => {
      const dirPath = `${ctx.testDir}/dir-to-delete-${rng.string(6)}`;

      await conn.mkdir(dirPath);
      await conn.writeFile(`${dirPath}/file.txt`, Buffer.from('in dir'));
      await conn.deleteFile(dirPath);
      await validator.verifyDelete(conn, dirPath);

      return [];
    }),
  },
  {
    name: 'rename-verify',
    category: CATEGORY,
    fn: (ctx) => makeResult('rename-verify', ctx, async (conn, validator, rng) => {
      const oldPath = `${ctx.testDir}/old-${rng.string(6)}.txt`;
      const newPath = `${ctx.testDir}/new-${rng.string(6)}.txt`;

      await conn.writeFile(oldPath, Buffer.from('rename me'));
      await conn.rename(oldPath, newPath);
      await validator.verifyRename(conn, oldPath, newPath);

      // Also verify content survived rename
      await validator.verifyWrite(conn, newPath, 'rename me');

      return [];
    }),
  },
  {
    name: 'list-files-verify',
    category: CATEGORY,
    fn: (ctx) => makeResult('list-files-verify', ctx, async (conn, validator, rng) => {
      const violations: string[] = [];

      // Create several files and dirs
      const fileNames = Array.from({ length: rng.int(3, 8) }, (_, i) => `file-${i}-${rng.string(4)}.txt`);
      const dirNames = Array.from({ length: rng.int(1, 3) }, (_, i) => `dir-${i}-${rng.string(4)}`);

      for (const name of fileNames) {
        await conn.writeFile(`${ctx.testDir}/${name}`, Buffer.from(`content of ${name}`));
      }
      for (const name of dirNames) {
        await conn.mkdir(`${ctx.testDir}/${name}`);
      }

      // List and verify all names present
      const files = await conn.listFiles(ctx.testDir);
      const names = files.map(f => f.name);

      for (const expected of [...fileNames, ...dirNames]) {
        if (!names.includes(expected)) {
          violations.push(`listFiles: missing "${expected}" from directory listing`);
        }
      }

      // Verify directory flags
      for (const f of files) {
        if (dirNames.includes(f.name) && !f.isDirectory) {
          violations.push(`listFiles: "${f.name}" should be directory but isDirectory=${f.isDirectory}`);
        }
        if (fileNames.includes(f.name) && f.isDirectory) {
          violations.push(`listFiles: "${f.name}" should be file but isDirectory=${f.isDirectory}`);
        }
      }

      return violations;
    }),
  },
  {
    name: 'stat-verify',
    category: CATEGORY,
    fn: (ctx) => makeResult('stat-verify', ctx, async (conn, _validator, rng) => {
      const violations: string[] = [];
      const content = rng.string(rng.int(50, 500));
      const filePath = `${ctx.testDir}/stat-test-${rng.string(6)}.txt`;

      await conn.writeFile(filePath, Buffer.from(content));
      const stat = await conn.stat(filePath);

      if (stat.isDirectory) {
        violations.push('stat: file reported as directory');
      }
      if (stat.size !== Buffer.byteLength(content)) {
        violations.push(`stat: size mismatch (expected ${Buffer.byteLength(content)}, got ${stat.size})`);
      }
      if (!stat.name) {
        violations.push('stat: name is empty');
      }

      return violations;
    }),
  },
  {
    name: 'rapid-create-delete',
    category: CATEGORY,
    fn: (ctx) => makeResult('rapid-create-delete', ctx, async (conn, validator, rng) => {
      const violations: string[] = [];
      const cycles = rng.int(5, 15);

      for (let i = 0; i < cycles; i++) {
        const filePath = `${ctx.testDir}/rapid-${i}.txt`;
        await conn.writeFile(filePath, Buffer.from(`cycle ${i}`));
        await conn.deleteFile(filePath);
      }

      // Verify no ghost files remain
      const files = await conn.listFiles(ctx.testDir);
      const ghostFiles = files.filter(f => f.name.startsWith('rapid-'));
      if (ghostFiles.length > 0) {
        violations.push(`rapid-create-delete: ${ghostFiles.length} ghost files remain: ${ghostFiles.map(f => f.name).join(', ')}`);
      }

      return violations;
    }),
  },
  {
    name: 'special-characters',
    category: CATEGORY,
    fn: (ctx) => makeResult('special-characters', ctx, async (conn, validator, rng) => {
      const violations: string[] = [];
      // Test files with spaces and special chars (safe subset)
      const testNames = [
        'file with spaces.txt',
        'file-with-dashes.txt',
        'file_with_underscores.txt',
        'file.multiple.dots.txt',
      ];

      for (const name of testNames) {
        const filePath = `${ctx.testDir}/${name}`;
        try {
          await conn.writeFile(filePath, Buffer.from(`content of ${name}`));
          await validator.verifyWrite(conn, filePath, `content of ${name}`);
        } catch (err) {
          violations.push(`special-chars: failed for "${name}": ${(err as Error).message}`);
        }
      }

      return [...violations, ...validator.getViolations()];
    }),
  },
  {
    name: 'search-files-verify',
    category: CATEGORY,
    fn: (ctx) => makeResult('search-files-verify', ctx, async (conn, validator, rng) => {
      const searchDir = `${ctx.testDir}/search`;
      await conn.mkdir(searchDir);

      const uniqueToken = rng.string(12);
      await conn.writeFile(`${searchDir}/a.txt`, Buffer.from(`found ${uniqueToken} here`));
      await conn.writeFile(`${searchDir}/b.txt`, Buffer.from(`also ${uniqueToken} here`));
      await conn.writeFile(`${searchDir}/c.txt`, Buffer.from('no match'));

      const results = await conn.searchFiles(searchDir, uniqueToken, {
        searchContent: true,
      });

      if (results.length < 2) {
        return [`search: expected at least 2 results, got ${results.length}`];
      }

      // Verify all returned paths are statable
      await validator.verifySearchResults(conn, results);

      return validator.getViolations();
    }),
  },
  {
    name: 'list-directories-verify',
    category: CATEGORY,
    fn: (ctx) => makeResult('list-directories-verify', ctx, async (conn, validator, rng) => {
      const violations: string[] = [];
      const baseDir = `${ctx.testDir}/listdirs`;
      await conn.mkdir(baseDir);

      // Create random subdirs and files
      const subDirCount = rng.int(2, 5);
      const expectedDirs: string[] = [];
      for (let i = 0; i < subDirCount; i++) {
        const dirName = `sub-${rng.string(6)}`;
        await conn.mkdir(`${baseDir}/${dirName}`);
        expectedDirs.push(`${baseDir}/${dirName}`);
      }
      // Add files (should NOT appear in listDirectories)
      for (let i = 0; i < rng.int(1, 3); i++) {
        await conn.writeFile(`${baseDir}/file-${rng.string(4)}.txt`, Buffer.from('data'));
      }

      const dirs = await conn.listDirectories(baseDir);

      // Invariant: must return only directories
      if (dirs.length !== subDirCount) {
        violations.push(`listDirectories: expected ${subDirCount} dirs, got ${dirs.length}`);
      }

      // Invariant: results must be sorted
      const sorted = [...dirs].sort();
      if (JSON.stringify(dirs) !== JSON.stringify(sorted)) {
        violations.push('listDirectories: results not sorted');
      }

      // Invariant: all expected dirs must be present
      for (const expected of expectedDirs) {
        if (!dirs.includes(expected)) {
          violations.push(`listDirectories: missing expected dir "${expected}"`);
        }
      }

      // Invariant: all returned paths must be statable as directories
      for (const dir of dirs) {
        try {
          const stat = await conn.stat(dir);
          if (!stat.isDirectory) {
            violations.push(`listDirectories: "${dir}" is not a directory`);
          }
        } catch {
          violations.push(`listDirectories: "${dir}" not statable`);
        }
      }

      return violations;
    }),
  },
  {
    name: 'search-files-multi-path-verify',
    category: CATEGORY,
    fn: (ctx) => makeResult('search-files-multi-path-verify', ctx, async (conn, validator, rng) => {
      const violations: string[] = [];
      const baseDir = `${ctx.testDir}/multi-search`;
      await conn.mkdir(baseDir);
      await conn.mkdir(`${baseDir}/dirA`);
      await conn.mkdir(`${baseDir}/dirB`);

      const token = rng.string(12);
      await conn.writeFile(`${baseDir}/dirA/match.txt`, Buffer.from(`found ${token} here`));
      await conn.writeFile(`${baseDir}/dirB/match.txt`, Buffer.from(`also ${token} here`));

      // Search with string[] paths
      const results = await conn.searchFiles(
        [`${baseDir}/dirA`, `${baseDir}/dirB`],
        token,
        { searchContent: true }
      );

      if (results.length < 2) {
        violations.push(`multi-path search: expected >=2 results, got ${results.length}`);
      }

      // Verify results come from both paths
      const hasA = results.some(r => r.path.includes('dirA'));
      const hasB = results.some(r => r.path.includes('dirB'));
      if (!hasA) violations.push('multi-path search: no results from dirA');
      if (!hasB) violations.push('multi-path search: no results from dirB');

      // Verify all returned paths are statable
      await validator.verifySearchResults(conn, results);

      return [...violations, ...validator.getViolations()];
    }),
  },
];
