/**
 * Chaos Scenarios: CommandGuard
 *
 * Tests CommandGuard wrapper + activity tracking verification.
 * Every CommandGuard operation should create an activity in ActivityService.
 */

import { CommandGuard } from '../../services/CommandGuard';
import { ActivityService } from '../../services/ActivityService';
import { ScenarioDefinition, ScenarioContext, ScenarioResult } from '../ChaosConfig';
import { ChaosValidator } from '../ChaosValidator';
import { createChaosConnection, safeChaosDisconnect, SeededRandom, withTimeout } from '../chaos-helpers';
import { SSHConnection } from '../../connection/SSHConnection';

const CATEGORY = 'command-guard';

async function makeResult(
  name: string,
  ctx: ScenarioContext,
  fn: (conn: SSHConnection, guard: CommandGuard, validator: ChaosValidator, rng: SeededRandom) => Promise<string[]>
): Promise<ScenarioResult> {
  const start = Date.now();
  let conn: SSHConnection | null = null;
  try {
    // Reset singletons per scenario
    (CommandGuard as any)._instance = undefined;
    (ActivityService as any)._instance = undefined;

    conn = await createChaosConnection(ctx.server);
    await conn.mkdir(ctx.testDir).catch(() => {});
    const guard = CommandGuard.getInstance();
    const validator = new ChaosValidator();
    const rng = new SeededRandom(ctx.seed + ctx.variation);

    const extraViolations = await fn(conn, guard, validator, rng);

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
      try { await withTimeout(conn.exec(`rm -rf ${ctx.testDir}`), 10000, 'cleanup rm -rf'); } catch {}
      await safeChaosDisconnect(conn);
    }
  }
}

export const commandGuardScenarios: ScenarioDefinition[] = [
  {
    name: 'guard-exec-tracking',
    category: CATEGORY,
    fn: (ctx) => makeResult('guard-exec-tracking', ctx, async (conn, guard, validator) => {
      const activityService = ActivityService.getInstance();
      const beforeCount = activityService.getAllActivities().length;

      await guard.exec(conn, 'echo "guard test"', { description: 'Test exec' });

      validator.verifyActivityRecorded(activityService, beforeCount);
      return validator.getViolations();
    }),
  },
  {
    name: 'guard-readFile-tracking',
    category: CATEGORY,
    fn: (ctx) => makeResult('guard-readFile-tracking', ctx, async (conn, guard, validator) => {
      const filePath = `${ctx.testDir}/guard-read.txt`;
      await conn.writeFile(filePath, Buffer.from('guard read content'));

      const activityService = ActivityService.getInstance();
      const beforeCount = activityService.getAllActivities().length;

      const content = await guard.readFile(conn, filePath);

      validator.verifyActivityRecorded(activityService, beforeCount);

      if (content.toString() !== 'guard read content') {
        return [`guard.readFile: content mismatch`];
      }
      return validator.getViolations();
    }),
  },
  {
    name: 'guard-writeFile-tracking',
    category: CATEGORY,
    fn: (ctx) => makeResult('guard-writeFile-tracking', ctx, async (conn, guard, validator, rng) => {
      const filePath = `${ctx.testDir}/guard-write-${rng.string(6)}.txt`;

      const activityService = ActivityService.getInstance();
      const beforeCount = activityService.getAllActivities().length;

      await guard.writeFile(conn, filePath, 'guard write content');

      validator.verifyActivityRecorded(activityService, beforeCount);
      await validator.verifyWrite(conn, filePath, 'guard write content');

      return validator.getViolations();
    }),
  },
  {
    name: 'guard-listFiles-tracking',
    category: CATEGORY,
    fn: (ctx) => makeResult('guard-listFiles-tracking', ctx, async (conn, guard, validator) => {
      const activityService = ActivityService.getInstance();
      const beforeCount = activityService.getAllActivities().length;

      const files = await guard.listFiles(conn, ctx.testDir);

      validator.verifyActivityRecorded(activityService, beforeCount);

      if (!Array.isArray(files)) {
        return ['guard.listFiles: did not return array'];
      }
      return validator.getViolations();
    }),
  },
  {
    name: 'guard-searchFiles-tracking',
    category: CATEGORY,
    fn: (ctx) => makeResult('guard-searchFiles-tracking', ctx, async (conn, guard, validator, rng) => {
      const searchDir = `${ctx.testDir}/guard-search`;
      await conn.mkdir(searchDir);
      const token = rng.string(10);
      await conn.writeFile(`${searchDir}/data.txt`, Buffer.from(`contains ${token}`));

      const activityService = ActivityService.getInstance();
      const beforeCount = activityService.getAllActivities().length;

      const results = await guard.searchFiles(conn, searchDir, token, { searchContent: true });

      validator.verifyActivityRecorded(activityService, beforeCount);

      if (results.length === 0) {
        return ['guard.searchFiles: returned no results'];
      }
      return validator.getViolations();
    }),
  },
  {
    name: 'guard-multiple-ops',
    category: CATEGORY,
    fn: (ctx) => makeResult('guard-multiple-ops', ctx, async (conn, guard, validator, rng) => {
      const violations: string[] = [];

      // Run multiple guard operations in sequence
      await guard.exec(conn, 'echo "multi-1"');
      const filePath = `${ctx.testDir}/multi-${rng.string(6)}.txt`;
      await guard.writeFile(conn, filePath, 'multi content');
      await guard.readFile(conn, filePath);
      await guard.listFiles(conn, ctx.testDir);

      // Wait for activities to complete
      await new Promise(r => setTimeout(r, 500));

      validator.verifyNoRunningActivities();
      return [...violations, ...validator.getViolations()];
    }),
  },
  {
    name: 'connect-lifecycle',
    category: CATEGORY,
    fn: (ctx) => makeResult('connect-lifecycle', ctx, async (conn, guard, validator) => {
      // P0 coverage: startConnect / completeConnect / failConnect / trackDisconnect.
      // Contract: every start has a matching complete or fail; activity count returns
      // to baseline; running count is 0 after the lifecycle.
      const activityService = ActivityService.getInstance();
      const baseline = activityService.getRunningActivities().length;

      // Happy path: start + complete
      const okId = guard.startConnect(conn.host.name, conn.id);
      if (activityService.getRunningActivities().length !== baseline + 1) {
        return [`startConnect invariant: running count did not increment (baseline ${baseline})`];
      }
      guard.completeConnect(okId);

      // Failure path: start + fail
      const failId = guard.startConnect(conn.host.name, conn.id);
      guard.failConnect(failId, 'simulated failure');

      // Disconnect tracking — synchronously starts and completes
      guard.trackDisconnect(conn);

      // Wait briefly for any async settling, then verify
      await new Promise(r => setTimeout(r, 100));
      const runningAfter = activityService.getRunningActivities().length;
      if (runningAfter !== baseline) {
        return [`connect-lifecycle invariant: running activities ${runningAfter}, expected baseline ${baseline}`];
      }
      validator.verifyNoRunningActivities();
      return validator.getViolations();
    }),
  },
  {
    name: 'monitoring-lifecycle',
    category: CATEGORY,
    fn: (ctx) => makeResult('monitoring-lifecycle', ctx, async (conn, guard, validator, rng) => {
      // P0 coverage: startMonitoring / updateMonitoring / stopMonitoring,
      // startRefresh / completeRefresh / failRefresh.
      // Contract: monitor and refresh activities follow start→update*→stop with the
      // running count balancing back to baseline. Cancelled stop must not leak as Running.
      const violations: string[] = [];
      const activityService = ActivityService.getInstance();
      const baseline = activityService.getRunningActivities().length;

      const watchPath = `${ctx.testDir}/watched-${rng.string(6)}.log`;
      // Monitor: stop with default reason (completed)
      const monId = guard.startMonitoring(conn, watchPath);
      guard.updateMonitoring(monId, 'progress: 50%');
      guard.stopMonitoring(monId, 'done');

      // Monitor: stop with cancelled reason
      const cancelId = guard.startMonitoring(conn, watchPath);
      guard.stopMonitoring(cancelId, 'cancelled');

      // Refresh: complete
      const refId = guard.startRefresh(conn, ctx.testDir);
      guard.completeRefresh(refId, 'ok');

      // Refresh: fail
      const refFailId = guard.startRefresh(conn, ctx.testDir);
      guard.failRefresh(refFailId, 'simulated refresh failure');

      await new Promise(r => setTimeout(r, 100));
      const runningAfter = activityService.getRunningActivities().length;
      if (runningAfter !== baseline) {
        violations.push(`monitoring-lifecycle invariant: running activities ${runningAfter}, expected baseline ${baseline}`);
      }
      return [...violations, ...validator.getViolations()];
    }),
  },
];
