/**
 * Chaos Scenarios: Concurrent Operations
 *
 * Tests parallel operations, race conditions, and multi-connection behavior.
 * Discovers bugs that only appear under concurrent load.
 */

import { SSHConnection } from '../../connection/SSHConnection';
import { ScenarioDefinition, ScenarioContext, ScenarioResult } from '../ChaosConfig';
import { ChaosValidator } from '../ChaosValidator';
import { createChaosConnection, safeChaosDisconnect, SeededRandom } from '../chaos-helpers';

const CATEGORY = 'concurrent-operations';

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

export const concurrentOperationsScenarios: ScenarioDefinition[] = [
  {
    name: 'parallel-writes',
    category: CATEGORY,
    fn: (ctx) => makeResult('parallel-writes', ctx, async (conn, validator, rng) => {
      const violations: string[] = [];
      const count = rng.int(5, 15);

      // Write multiple files in parallel
      const writeOps = Array.from({ length: count }, (_, i) => {
        const filePath = `${ctx.testDir}/parallel-${i}.txt`;
        const content = `parallel content ${i} ${rng.string(20)}`;
        return conn.writeFile(filePath, Buffer.from(content)).then(() => ({ filePath, content }));
      });

      const results = await Promise.allSettled(writeOps);

      // Verify all succeeded
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          violations.push(`parallel write ${i} failed: ${(results[i] as PromiseRejectedResult).reason}`);
        }
      }

      // Verify all files readable
      const fulfilled = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<{ filePath: string; content: string }>[];
      for (const { value } of fulfilled) {
        await validator.verifyWrite(conn, value.filePath, value.content);
      }

      return [...violations, ...validator.getViolations()];
    }),
  },
  {
    name: 'parallel-reads',
    category: CATEGORY,
    fn: (ctx) => makeResult('parallel-reads', ctx, async (conn, _validator, rng) => {
      const violations: string[] = [];
      const count = rng.int(5, 10);

      // Create files first
      for (let i = 0; i < count; i++) {
        await conn.writeFile(`${ctx.testDir}/read-${i}.txt`, Buffer.from(`content ${i}`));
      }

      // Read all in parallel
      const readOps = Array.from({ length: count }, (_, i) =>
        conn.readFile(`${ctx.testDir}/read-${i}.txt`).then(buf => ({ i, content: buf.toString() }))
      );

      const results = await Promise.allSettled(readOps);

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          violations.push(`parallel read ${i} failed: ${(results[i] as PromiseRejectedResult).reason}`);
        } else {
          const { content } = (results[i] as PromiseFulfilledResult<{ i: number; content: string }>).value;
          if (content !== `content ${i}`) {
            violations.push(`parallel read ${i}: content mismatch (got "${content.substring(0, 30)}")`);
          }
        }
      }

      return violations;
    }),
  },
  {
    name: 'parallel-exec',
    category: CATEGORY,
    fn: (ctx) => makeResult('parallel-exec', ctx, async (conn, _validator, rng) => {
      const violations: string[] = [];
      const count = rng.int(5, 10);

      // Execute multiple commands in parallel
      const execOps = Array.from({ length: count }, (_, i) =>
        conn.exec(`echo "result-${i}"`).then(result => ({ i, result: result.trim() }))
      );

      const results = await Promise.allSettled(execOps);

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          violations.push(`parallel exec ${i} failed: ${(results[i] as PromiseRejectedResult).reason}`);
        } else {
          const { result } = (results[i] as PromiseFulfilledResult<{ i: number; result: string }>).value;
          if (result !== `result-${i}`) {
            violations.push(`parallel exec ${i}: expected "result-${i}", got "${result}"`);
          }
        }
      }

      return violations;
    }),
  },
  {
    name: 'parallel-list-and-write',
    category: CATEGORY,
    fn: (ctx) => makeResult('parallel-list-and-write', ctx, async (conn, validator, rng) => {
      const violations: string[] = [];

      // Simultaneously list and write
      const ops = [
        conn.listFiles(ctx.testDir).then(files => ({ type: 'list', files })),
        conn.writeFile(`${ctx.testDir}/concurrent-a.txt`, Buffer.from('a')).then(() => ({ type: 'write-a' })),
        conn.writeFile(`${ctx.testDir}/concurrent-b.txt`, Buffer.from('b')).then(() => ({ type: 'write-b' })),
        conn.exec('echo ok').then(r => ({ type: 'exec', result: r.trim() })),
      ];

      const results = await Promise.allSettled(ops);

      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          violations.push(`concurrent op ${i} failed: ${(results[i] as PromiseRejectedResult).reason}`);
        }
      }

      // Verify writes completed correctly
      await validator.verifyWrite(conn, `${ctx.testDir}/concurrent-a.txt`, 'a');
      await validator.verifyWrite(conn, `${ctx.testDir}/concurrent-b.txt`, 'b');

      return [...violations, ...validator.getViolations()];
    }),
  },
  {
    name: 'concurrent-same-file-writes',
    category: CATEGORY,
    fn: (ctx) => makeResult('concurrent-same-file-writes', ctx, async (conn, _validator, rng) => {
      const violations: string[] = [];
      const filePath = `${ctx.testDir}/contested.txt`;

      // Write to the same file concurrently -- second should succeed or throw, not corrupt
      const results = await Promise.allSettled([
        conn.writeFile(filePath, Buffer.from('writer-1')),
        conn.writeFile(filePath, Buffer.from('writer-2')),
      ]);

      // At least one should succeed
      const succeeded = results.filter(r => r.status === 'fulfilled');
      if (succeeded.length === 0) {
        violations.push('concurrent same-file writes: both failed');
      }

      // File should contain one of the two values (not corrupted)
      try {
        const content = (await conn.readFile(filePath)).toString();
        if (content !== 'writer-1' && content !== 'writer-2') {
          violations.push(`concurrent same-file writes: content corrupted: "${content.substring(0, 50)}"`);
        }
      } catch (err) {
        violations.push(`concurrent same-file writes: readFile failed: ${(err as Error).message}`);
      }

      return violations;
    }),
  },
];
