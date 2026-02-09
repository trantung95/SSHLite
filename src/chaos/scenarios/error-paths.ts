/**
 * Chaos Scenarios: Error Paths
 *
 * Tests invalid inputs, permission errors, and edge cases.
 * Verifies the extension handles errors gracefully without crashing.
 */

import { SSHConnection } from '../../connection/SSHConnection';
import { SFTPError } from '../../types';
import { ScenarioDefinition, ScenarioContext, ScenarioResult } from '../ChaosConfig';
import { createChaosConnection, safeChaosDisconnect, SeededRandom } from '../chaos-helpers';

const CATEGORY = 'error-paths';

async function makeResult(
  name: string,
  ctx: ScenarioContext,
  fn: (conn: SSHConnection, rng: SeededRandom) => Promise<string[]>
): Promise<ScenarioResult> {
  const start = Date.now();
  let conn: SSHConnection | null = null;
  try {
    conn = await createChaosConnection(ctx.server);
    const rng = new SeededRandom(ctx.seed + ctx.variation);

    const violations = await fn(conn, rng);

    return {
      name: `${CATEGORY}:${name}`,
      server: ctx.server.label,
      server_os: ctx.server.os,
      passed: violations.length === 0,
      invariantViolations: violations,
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
      await safeChaosDisconnect(conn);
    }
  }
}

export const errorPathsScenarios: ScenarioDefinition[] = [
  {
    name: 'read-nonexistent-file',
    category: CATEGORY,
    fn: (ctx) => makeResult('read-nonexistent-file', ctx, async (conn, rng) => {
      const violations: string[] = [];
      const fakePath = `/home/${ctx.server.username}/nonexistent-${rng.string(10)}.txt`;

      try {
        await conn.readFile(fakePath);
        violations.push('readFile on nonexistent path did not throw');
      } catch (err) {
        // Expected to throw
        if (!(err instanceof SFTPError) && !(err instanceof Error)) {
          violations.push(`readFile threw non-Error: ${typeof err}`);
        }
      }

      return violations;
    }),
  },
  {
    name: 'list-nonexistent-dir',
    category: CATEGORY,
    fn: (ctx) => makeResult('list-nonexistent-dir', ctx, async (conn, rng) => {
      const violations: string[] = [];
      const fakePath = `/home/${ctx.server.username}/nonexistent-dir-${rng.string(10)}`;

      try {
        await conn.listFiles(fakePath);
        violations.push('listFiles on nonexistent directory did not throw');
      } catch (err) {
        if (!(err instanceof Error)) {
          violations.push(`listFiles threw non-Error: ${typeof err}`);
        }
      }

      return violations;
    }),
  },
  {
    name: 'stat-nonexistent',
    category: CATEGORY,
    fn: (ctx) => makeResult('stat-nonexistent', ctx, async (conn, rng) => {
      const violations: string[] = [];
      const fakePath = `/home/${ctx.server.username}/no-such-file-${rng.string(10)}`;

      try {
        await conn.stat(fakePath);
        violations.push('stat on nonexistent path did not throw');
      } catch (err) {
        if (!(err instanceof Error)) {
          violations.push(`stat threw non-Error: ${typeof err}`);
        }
      }

      return violations;
    }),
  },
  {
    name: 'delete-nonexistent',
    category: CATEGORY,
    fn: (ctx) => makeResult('delete-nonexistent', ctx, async (conn, rng) => {
      const violations: string[] = [];
      const fakePath = `/home/${ctx.server.username}/no-such-delete-${rng.string(10)}`;

      try {
        await conn.deleteFile(fakePath);
        violations.push('deleteFile on nonexistent path did not throw');
      } catch {
        // Expected
      }

      return violations;
    }),
  },
  {
    name: 'mkdir-existing',
    category: CATEGORY,
    fn: (ctx) => makeResult('mkdir-existing', ctx, async (conn) => {
      const violations: string[] = [];
      const dirPath = `/home/${ctx.server.username}`;

      // mkdir on existing directory -- should throw or succeed gracefully
      try {
        await conn.mkdir(dirPath);
        // Some implementations allow mkdir on existing dirs
      } catch {
        // Also acceptable to throw
      }

      // Either way, the directory should still exist
      try {
        const files = await conn.listFiles(dirPath);
        if (!Array.isArray(files)) {
          violations.push('existing directory not listable after mkdir attempt');
        }
      } catch (err) {
        violations.push(`existing directory broken after mkdir: ${(err as Error).message}`);
      }

      return violations;
    }),
  },
  {
    name: 'write-to-readonly-path',
    category: CATEGORY,
    fn: (ctx) => makeResult('write-to-readonly-path', ctx, async (conn, rng) => {
      const violations: string[] = [];

      // Try to write to /etc (should fail for non-root)
      if (ctx.server.username !== 'root') {
        try {
          await conn.writeFile(`/etc/chaos-test-${rng.string(6)}`, Buffer.from('should fail'));
          violations.push('writeFile to /etc succeeded for non-root user');
        } catch {
          // Expected
        }
      }

      return violations;
    }),
  },
  {
    name: 'rename-nonexistent',
    category: CATEGORY,
    fn: (ctx) => makeResult('rename-nonexistent', ctx, async (conn, rng) => {
      const violations: string[] = [];
      const fakePath = `/home/${ctx.server.username}/no-such-rename-${rng.string(10)}`;
      const newPath = `/home/${ctx.server.username}/renamed-${rng.string(10)}`;

      try {
        await conn.rename(fakePath, newPath);
        violations.push('rename of nonexistent path did not throw');
      } catch {
        // Expected
      }

      return violations;
    }),
  },
  {
    name: 'exec-invalid-command',
    category: CATEGORY,
    fn: (ctx) => makeResult('exec-invalid-command', ctx, async (conn) => {
      const violations: string[] = [];

      try {
        await conn.exec('this-command-does-not-exist-xyz-123');
        violations.push('exec of nonexistent command did not throw');
      } catch {
        // Expected
      }

      // Connection should still be usable after failed command
      try {
        const result = await conn.exec('echo ok');
        if (result.trim() !== 'ok') {
          violations.push('connection broken after failed exec');
        }
      } catch (err) {
        violations.push(`connection broken after failed exec: ${(err as Error).message}`);
      }

      return violations;
    }),
  },
];
