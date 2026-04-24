/**
 * Chaos Scenarios: ChannelSemaphore
 *
 * Tests ChannelSemaphore slot management, adaptive capacity, and multi-connection
 * isolation including deadlock, leak, destroy, and cross-server scenarios.
 */

import { ChannelSemaphore } from '../../services/ChannelSemaphore';
import { CommandGuard } from '../../services/CommandGuard';
import { ActivityService } from '../../services/ActivityService';
import { ScenarioDefinition, ScenarioContext, ScenarioResult } from '../ChaosConfig';
import { ChaosValidator } from '../ChaosValidator';
import { createChaosConnection, safeChaosDisconnect, SeededRandom, withTimeout } from '../chaos-helpers';
import { SSHConnection } from '../../connection/SSHConnection';

const CATEGORY = 'channel-semaphore';

// ---------------------------------------------------------------------------
// Helper: build a ScenarioResult using a real SSH connection (scenarios 1 & 2)
// ---------------------------------------------------------------------------

async function makeResult(
  name: string,
  ctx: ScenarioContext,
  fn: (conn: SSHConnection, guard: CommandGuard, validator: ChaosValidator, rng: SeededRandom) => Promise<string[]>
): Promise<ScenarioResult> {
  const start = Date.now();
  let conn: SSHConnection | null = null;
  try {
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
      try { await withTimeout(conn.exec(`rm -rf `), 10000, 'cleanup rm -rf'); } catch {}
      await safeChaosDisconnect(conn);
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: build a ScenarioResult without a real SSH connection (scenarios 3 & 4)
// ---------------------------------------------------------------------------

async function makePureResult(
  name: string,
  ctx: ScenarioContext,
  fn: (validator: ChaosValidator, rng: SeededRandom) => Promise<string[]>
): Promise<ScenarioResult> {
  const start = Date.now();
  try {
    const validator = new ChaosValidator();
    const rng = new SeededRandom(ctx.seed + ctx.variation);
    const extraViolations = await fn(validator, rng);
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
  }
}

// ---------------------------------------------------------------------------
// Helper: build a ScenarioResult using mock connections (scenarios 5 & 6)
// ---------------------------------------------------------------------------

interface MockConn {
  id: string;
  host: { name: string };
  sudoMode: boolean;
  sudoPassword: string | null;
  exec: (cmd: string) => Promise<string>;
  shell: () => Promise<{ on: (evt: string, cb: () => void) => void }>;
}

function makeMockConn(id: string, execImpl: (cmd: string) => Promise<string>): MockConn {
  return {
    id,
    host: { name: id },
    sudoMode: false,
    sudoPassword: null,
    exec: execImpl,
    shell: async () => ({ on: (_evt: string, _cb: () => void) => {} }),
  };
}

async function makeMockResult(
  name: string,
  ctx: ScenarioContext,
  fn: (validator: ChaosValidator, rng: SeededRandom) => Promise<string[]>
): Promise<ScenarioResult> {
  const start = Date.now();
  try {
    (CommandGuard as any)._instance = undefined;
    (ActivityService as any)._instance = undefined;

    const validator = new ChaosValidator();
    const rng = new SeededRandom(ctx.seed + ctx.variation);
    const extraViolations = await fn(validator, rng);
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
  }
}

// ---------------------------------------------------------------------------
// Scenario 1: random-concurrent-mix-no-deadlock
//
// Fire a mix of guard.exec() and guard.openShell() calls concurrently against a
// real server connection with _maxSlots capped at 3.  After all settle, the
// semaphore must drain to 0 active slots, proving no slot was leaked.
// ---------------------------------------------------------------------------

const scenarioRandomConcurrentMix: ScenarioDefinition = {
  name: 'random-concurrent-mix-no-deadlock',
  category: CATEGORY,
  fn: (ctx: ScenarioContext) =>
    makeResult('random-concurrent-mix-no-deadlock', ctx, async (conn, guard, _validator, rng) => {
      const violations: string[] = [];

      // Shrink the semaphore to create real contention with this small batch.
      const sem = (guard as any).getSemaphore(conn.id) as ChannelSemaphore;
      (sem as any)._maxSlots = 3;

      const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

      // 5 remote-exec calls
      const execTasks = Array.from({ length: 5 }, () =>
        guard.exec(conn, 'echo ok').catch(() => {})
      );

      // 3 remote shell channels, closed immediately with a 0-50 ms delay
      const shellTasks = Array.from({ length: 3 }, async () => {
        try {
          const channel = await guard.openShell(conn);
          await delay(rng.int(0, 50));
          // Emit 'close' so the slot is released via the channel event listener.
          (channel as any).emit?.('close');
          // Fallback: call destroy if emit is not available.
          try { (channel as any).destroy?.(); } catch {}
        } catch {
          // openShell failure is acceptable under contention; guard released the slot.
        }
      });

      // 4 more remote-exec calls
      const execTasks2 = Array.from({ length: 4 }, () =>
        guard.exec(conn, 'echo ok').catch(() => {})
      );

      await Promise.allSettled([...execTasks, ...shellTasks, ...execTasks2]);

      // Give the event loop a tick so any pending release callbacks can fire.
      await delay(100);

      if (sem.activeCount !== 0) {
        violations.push(`Slot leak: activeCount=${sem.activeCount} after all operations settled`);
      }

      return violations;
    }),
};

// ---------------------------------------------------------------------------
// Scenario 2: random-open-failures-maxslots-never-below-1
//
// Inject random open-failure errors into the connection remote-exec method
// (40% probability), fire 20 concurrent guard.exec() calls, then assert the
// semaphore degraded but never below 1 slot, and has no leaked active slots.
// ---------------------------------------------------------------------------

const scenarioOpenFailures: ScenarioDefinition = {
  name: 'random-open-failures-maxslots-never-below-1',
  category: CATEGORY,
  fn: (ctx: ScenarioContext) =>
    makeResult('random-open-failures-maxslots-never-below-1', ctx, async (conn, guard, _validator, rng) => {
      const violations: string[] = [];

      // Wrap the connection remote-exec to inject random channel-open failures.
      const origExec = conn.exec.bind(conn);
      (conn as any).exec = async (cmd: string): Promise<string> => {
        if (rng.next() < 0.4) throw new Error('Channel open failure');
        return origExec(cmd);
      };

      // Fire 20 concurrent remote-exec calls; some will fail, guard retries internally.
      const tasks = Array.from({ length: 20 }, () =>
        guard.exec(conn, 'echo ok').catch(() => {})
      );
      await Promise.allSettled(tasks);

      const sem = (guard as any).getSemaphore(conn.id) as ChannelSemaphore;

      if (sem.maxSlots < 1) {
        violations.push(`maxSlots dropped below 1: maxSlots=${sem.maxSlots}`);
      }
      if (sem.activeCount !== 0) {
        violations.push(`Slot leak: activeCount=${sem.activeCount}`);
      }

      // Restore original remote-exec so cleanup works.
      (conn as any).exec = origExec;

      return violations;
    }),
};

// ---------------------------------------------------------------------------
// Scenario 3: abrupt-disconnect-mid-queue-waiters-rejected
//
// Pure semaphore test, no SSH connection needed.
// Hold the only slot, queue 5 waiters, then destroy().  All waiters must be
// rejected and the queue must drain to 0.
// ---------------------------------------------------------------------------

const scenarioAbruptDisconnect: ScenarioDefinition = {
  name: 'abrupt-disconnect-mid-queue-waiters-rejected',
  category: CATEGORY,
  fn: (ctx: ScenarioContext) =>
    makePureResult('abrupt-disconnect-mid-queue-waiters-rejected', ctx, async (_validator, _rng) => {
      const violations: string[] = [];
      const sem = new ChannelSemaphore(1);

      // Acquire the only slot so subsequent acquires queue.
      await sem.acquire();

      const destroyErr = new Error('Connection dropped');
      const waiterResults: Array<'resolved' | 'rejected'> = [];

      // Queue 5 waiters, none should resolve before destroy.
      const waiters = Array.from({ length: 5 }, () =>
        sem.acquire().then(
          () => { waiterResults.push('resolved'); },
          () => { waiterResults.push('rejected'); }
        )
      );

      // Give the event loop a tick so the waiters are registered in the queue.
      await new Promise<void>(r => setTimeout(r, 0));

      if (sem.queued !== 5) {
        violations.push(`Expected 5 queued waiters before destroy, got ${sem.queued}`);
      }

      sem.destroy(destroyErr);

      // Wait for all waiter promises to settle.
      await Promise.allSettled(waiters);

      const rejected = waiterResults.filter(r => r === 'rejected').length;
      const resolved = waiterResults.filter(r => r === 'resolved').length;

      if (rejected !== 5) {
        violations.push(`Expected 5 rejected waiters, got ${rejected} (resolved=${resolved})`);
      }
      if (sem.queued !== 0) {
        violations.push(`Queue not drained after destroy: queued=${sem.queued}`);
      }

      return violations;
    }),
};

// ---------------------------------------------------------------------------
// Scenario 4: rapid-acquire-release-queue-never-unbounded
//
// Pure semaphore test.  Hammer 500 acquire-then-release cycles through a
// semaphore with 4 slots.  After all settle, activeCount must be 0.
// ---------------------------------------------------------------------------

const scenarioRapidAcquireRelease: ScenarioDefinition = {
  name: 'rapid-acquire-release-queue-never-unbounded',
  category: CATEGORY,
  fn: (ctx: ScenarioContext) =>
    makePureResult('rapid-acquire-release-queue-never-unbounded', ctx, async (_validator, rng) => {
      const violations: string[] = [];
      const sem = new ChannelSemaphore(4);

      const tasks = Array.from({ length: 500 }, async () => {
        const release = await sem.acquire();
        await new Promise<void>(r => setTimeout(r, rng.int(0, 5)));
        release();
      });

      await Promise.all(tasks);

      if (sem.activeCount !== 0) {
        violations.push(`Slot leak after rapid acquire/release: activeCount=${sem.activeCount}`);
      }

      return violations;
    }),
};

// ---------------------------------------------------------------------------
// Scenario 5: multi-server-no-cross-server-slot-leakage
//
// Three mock connections, each gets its own semaphore inside CommandGuard.
// Inject 30% open-failure rate per server, fire 8 remote-execs per server
// concurrently.  Each semaphore must drain to 0 and all three must be distinct
// objects (no cross-server sharing).
// ---------------------------------------------------------------------------

const scenarioMultiServerNoLeakage: ScenarioDefinition = {
  name: 'multi-server-no-cross-server-slot-leakage',
  category: CATEGORY,
  fn: (ctx: ScenarioContext) =>
    makeMockResult('multi-server-no-cross-server-slot-leakage', ctx, async (_validator, rng) => {
      const violations: string[] = [];

      const guard = CommandGuard.getInstance();

      const serverIds = [
        'server-chaos-A:22:root',
        'server-chaos-B:22:root',
        'server-chaos-C:22:root',
      ];

      const conns: MockConn[] = serverIds.map(id =>
        makeMockConn(id, async (_cmd: string) => {
          if (rng.next() < 0.3) throw new Error('Channel open failure');
          return 'ok';
        })
      );

      // Fire 8 remote-execs per mock connection concurrently.
      const allTasks = conns.flatMap(conn =>
        Array.from({ length: 8 }, () =>
          guard.exec(conn as unknown as SSHConnection, 'echo ok').catch(() => {})
        )
      );

      await Promise.allSettled(allTasks);

      // Verify per-server semaphore state.
      const semaphores = serverIds.map(id => {
        const sem = (guard as any).semaphores.get(id) as ChannelSemaphore | undefined;
        return { id, sem };
      });

      for (const { id, sem } of semaphores) {
        if (!sem) {
          violations.push(`Semaphore not created for server ${id}`);
          continue;
        }
        if (sem.activeCount !== 0) {
          violations.push(`Slot leak on ${id}: activeCount=${sem.activeCount}`);
        }
      }

      // All three semaphores must be distinct object references.
      const semObjects = semaphores.map(s => s.sem).filter(Boolean);
      for (let i = 0; i < semObjects.length; i++) {
        for (let j = i + 1; j < semObjects.length; j++) {
          if (semObjects[i] === semObjects[j]) {
            violations.push(`Semaphores shared between servers ${serverIds[i]} and ${serverIds[j]}`);
          }
        }
      }

      return violations;
    }),
};

// ---------------------------------------------------------------------------
// Scenario 6: multi-user-same-host-independent-adaptation
//
// Two mock connections to the same host, different users.
// userA remote-exec throws open failure 50% of the time, semaphore degrades.
// userB remote-exec always succeeds, semaphore stays at initial max.
// After all: semA !== semB, semA.maxSlots < semB.maxSlots, both activeCount=0.
// ---------------------------------------------------------------------------

const scenarioMultiUserAdaptation: ScenarioDefinition = {
  name: 'multi-user-same-host-independent-adaptation',
  category: CATEGORY,
  fn: (ctx: ScenarioContext) =>
    makeMockResult('multi-user-same-host-independent-adaptation', ctx, async (_validator, rng) => {
      const violations: string[] = [];

      const guard = CommandGuard.getInstance();

      const idA = 'host-chaos:22:root';
      const idB = 'host-chaos:22:deploy';

      // userA: 50% failure rate, causes repeated reduceMax() calls.
      const connA = makeMockConn(idA, async (_cmd: string) => {
        if (rng.next() < 0.5) throw new Error('Channel open failure');
        return 'ok';
      });

      // userB: always succeeds, causes recordSuccess() calls.
      const connB = makeMockConn(idB, async (_cmd: string) => 'ok');

      const tasksA = Array.from({ length: 15 }, () =>
        guard.exec(connA as unknown as SSHConnection, 'echo ok').catch(() => {})
      );
      const tasksB = Array.from({ length: 15 }, () =>
        guard.exec(connB as unknown as SSHConnection, 'echo ok').catch(() => {})
      );

      await Promise.allSettled([...tasksA, ...tasksB]);

      const semA = (guard as any).semaphores.get(idA) as ChannelSemaphore | undefined;
      const semB = (guard as any).semaphores.get(idB) as ChannelSemaphore | undefined;

      if (!semA) { violations.push(`Semaphore not created for ${idA}`); }
      if (!semB) { violations.push(`Semaphore not created for ${idB}`); }

      if (semA && semB) {
        if (semA === semB) {
          violations.push('semA and semB are the same object, cross-user semaphore sharing detected');
        }
        if (semA.activeCount !== 0) {
          violations.push(`Slot leak for ${idA}: activeCount=${semA.activeCount}`);
        }
        if (semB.activeCount !== 0) {
          violations.push(`Slot leak for ${idB}: activeCount=${semB.activeCount}`);
        }
        // userA had 50% failures so maxSlots should have been reduced below the initial 8.
        if (semA.maxSlots >= semB.maxSlots) {
          violations.push(
            `Expected semA (${idA}) to have degraded maxSlots < semB (${idB}), ` +
            `but got semA.maxSlots=${semA.maxSlots} semB.maxSlots=${semB.maxSlots}`
          );
        }
      }

      return violations;
    }),
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const channelSemaphoreScenarios: ScenarioDefinition[] = [
  scenarioRandomConcurrentMix,
  scenarioOpenFailures,
  scenarioAbruptDisconnect,
  scenarioRapidAcquireRelease,
  scenarioMultiServerNoLeakage,
  scenarioMultiUserAdaptation,
];
