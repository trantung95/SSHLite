/**
 * Chaos Scenarios: Mixed Workflows
 *
 * Multi-step user workflow simulations.
 * Tests realistic usage patterns that combine multiple operations.
 */

import { SSHConnection } from '../../connection/SSHConnection';
import { CommandGuard } from '../../services/CommandGuard';
import { ActivityService } from '../../services/ActivityService';
import { ScenarioDefinition, ScenarioContext, ScenarioResult } from '../ChaosConfig';
import { ChaosValidator } from '../ChaosValidator';
import { createChaosConnection, safeChaosDisconnect, SeededRandom } from '../chaos-helpers';

const CATEGORY = 'mixed-workflows';

async function makeResult(
  name: string,
  ctx: ScenarioContext,
  fn: (conn: SSHConnection, validator: ChaosValidator, rng: SeededRandom) => Promise<string[]>
): Promise<ScenarioResult> {
  const start = Date.now();
  let conn: SSHConnection | null = null;
  try {
    (CommandGuard as any)._instance = undefined;
    (ActivityService as any)._instance = undefined;

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

export const mixedWorkflowsScenarios: ScenarioDefinition[] = [
  {
    name: 'browse-edit-save',
    category: CATEGORY,
    fn: (ctx) => makeResult('browse-edit-save', ctx, async (conn, validator, rng) => {
      const guard = CommandGuard.getInstance();

      // Simulate: user browses, opens file, edits, saves
      const files = await guard.listFiles(conn, ctx.testDir);

      const filePath = `${ctx.testDir}/user-file-${rng.string(6)}.txt`;
      const original = `original content ${rng.string(20)}`;
      await guard.writeFile(conn, filePath, original);

      // "Open" the file (read it)
      const content = await guard.readFile(conn, filePath);
      if (content.toString() !== original) {
        return [`browse-edit-save: initial read mismatch`];
      }

      // "Edit" and save
      const edited = `edited content ${rng.string(20)}`;
      await guard.writeFile(conn, filePath, edited);
      await validator.verifyWrite(conn, filePath, edited);

      return validator.getViolations();
    }),
  },
  {
    name: 'create-project-structure',
    category: CATEGORY,
    fn: (ctx) => makeResult('create-project-structure', ctx, async (conn, validator, rng) => {
      // Simulate: user creates a project folder structure
      const projectDir = `${ctx.testDir}/project-${rng.string(4)}`;
      await conn.mkdir(projectDir);
      await conn.mkdir(`${projectDir}/src`);
      await conn.mkdir(`${projectDir}/tests`);
      await conn.mkdir(`${projectDir}/docs`);

      await conn.writeFile(`${projectDir}/package.json`, Buffer.from('{"name":"test"}'));
      await conn.writeFile(`${projectDir}/src/index.ts`, Buffer.from('console.log("hello");'));
      await conn.writeFile(`${projectDir}/tests/index.test.ts`, Buffer.from('test("it works", () => {});'));
      await conn.writeFile(`${projectDir}/docs/readme.md`, Buffer.from('# Project'));

      // Verify structure
      const rootFiles = await conn.listFiles(projectDir);
      const names = rootFiles.map(f => f.name);
      const violations: string[] = [];

      for (const expected of ['src', 'tests', 'docs', 'package.json']) {
        if (!names.includes(expected)) {
          violations.push(`create-project: missing ${expected}`);
        }
      }

      // Verify a nested file
      await validator.verifyWrite(conn, `${projectDir}/src/index.ts`, 'console.log("hello");');

      return [...violations, ...validator.getViolations()];
    }),
  },
  {
    name: 'search-and-edit',
    category: CATEGORY,
    fn: (ctx) => makeResult('search-and-edit', ctx, async (conn, validator, rng) => {
      const guard = CommandGuard.getInstance();

      // Create files with searchable content
      const searchDir = `${ctx.testDir}/search-edit`;
      await conn.mkdir(searchDir);
      const token = `FINDME_${rng.string(8)}`;
      await conn.writeFile(`${searchDir}/target.txt`, Buffer.from(`line1\n${token}\nline3`));
      await conn.writeFile(`${searchDir}/other.txt`, Buffer.from('no match here'));

      // Search for the token
      const results = await guard.searchFiles(conn, searchDir, token, { searchContent: true });

      if (results.length === 0) {
        return ['search-and-edit: search returned no results'];
      }

      // "Edit" the found file
      const replacement = `line1\nREPLACED_${rng.string(8)}\nline3`;
      await guard.writeFile(conn, results[0].path, replacement);
      await validator.verifyWrite(conn, results[0].path, replacement);

      return validator.getViolations();
    }),
  },
  {
    name: 'bulk-rename',
    category: CATEGORY,
    fn: (ctx) => makeResult('bulk-rename', ctx, async (conn, validator, rng) => {
      const violations: string[] = [];
      const count = rng.int(3, 8);

      // Create files
      const files: string[] = [];
      for (let i = 0; i < count; i++) {
        const filePath = `${ctx.testDir}/old-${i}.txt`;
        await conn.writeFile(filePath, Buffer.from(`file ${i}`));
        files.push(filePath);
      }

      // Rename all in sequence
      for (let i = 0; i < count; i++) {
        const newPath = `${ctx.testDir}/new-${i}.txt`;
        await conn.rename(files[i], newPath);
        await validator.verifyRename(conn, files[i], newPath);
      }

      return [...violations, ...validator.getViolations()];
    }),
  },
  {
    name: 'cleanup-workflow',
    category: CATEGORY,
    fn: (ctx) => makeResult('cleanup-workflow', ctx, async (conn, _validator, rng) => {
      const violations: string[] = [];

      // Simulate: user creates temp files, then cleans up
      const tempDir = `${ctx.testDir}/temp-${rng.string(4)}`;
      await conn.mkdir(tempDir);

      for (let i = 0; i < rng.int(5, 10); i++) {
        await conn.writeFile(`${tempDir}/tmp-${i}.txt`, Buffer.from(`temp ${i}`));
      }

      // Verify files exist
      const files = await conn.listFiles(tempDir);
      if (files.length === 0) {
        violations.push('cleanup: no temp files created');
      }

      // Delete entire temp directory
      await conn.deleteFile(tempDir);

      // Verify deletion
      try {
        await conn.stat(tempDir);
        violations.push('cleanup: temp directory still exists after delete');
      } catch {
        // Expected
      }

      return violations;
    }),
  },
  {
    name: 'interleaved-guard-raw',
    category: CATEGORY,
    fn: (ctx) => makeResult('interleaved-guard-raw', ctx, async (conn, validator, rng) => {
      const guard = CommandGuard.getInstance();
      const violations: string[] = [];

      // Mix CommandGuard and raw SSHConnection operations
      const file1 = `${ctx.testDir}/guard-${rng.string(4)}.txt`;
      const file2 = `${ctx.testDir}/raw-${rng.string(4)}.txt`;

      await guard.writeFile(conn, file1, 'via guard');
      await conn.writeFile(file2, Buffer.from('via raw'));

      const content1 = await conn.readFile(file1);
      const content2 = await guard.readFile(conn, file2);

      if (content1.toString() !== 'via guard') {
        violations.push('interleaved: guard-written file has wrong content via raw read');
      }
      if (content2.toString() !== 'via raw') {
        violations.push('interleaved: raw-written file has wrong content via guard read');
      }

      // Verify listing shows both
      const files = await guard.listFiles(conn, ctx.testDir);
      const names = files.map(f => f.name);
      const file1Name = file1.split('/').pop()!;
      const file2Name = file2.split('/').pop()!;
      if (!names.includes(file1Name)) {
        violations.push(`interleaved: guard-written ${file1Name} missing from listing`);
      }
      if (!names.includes(file2Name)) {
        violations.push(`interleaved: raw-written ${file2Name} missing from listing`);
      }

      return [...violations, ...validator.getViolations()];
    }),
  },
];
