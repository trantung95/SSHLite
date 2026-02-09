/**
 * Chaos Scenarios: Connection Lifecycle
 *
 * Tests connect/disconnect/reconnect/state transitions.
 * Verifies state machine correctness and connection reliability.
 */

import { SSHConnection } from '../../connection/SSHConnection';
import { ConnectionState } from '../../types';
import { ScenarioDefinition, ScenarioContext, ScenarioResult } from '../ChaosConfig';
import { ChaosValidator } from '../ChaosValidator';
import { createChaosConnection, safeChaosDisconnect, waitForState, SeededRandom } from '../chaos-helpers';

const CATEGORY = 'connection-lifecycle';

async function makeResult(
  name: string,
  ctx: ScenarioContext,
  fn: () => Promise<{ violations: string[]; error?: string }>
): Promise<ScenarioResult> {
  const start = Date.now();
  try {
    const { violations, error } = await fn();
    return {
      name: `${CATEGORY}:${name}`,
      server: ctx.server.label,
      server_os: ctx.server.os,
      passed: violations.length === 0 && !error,
      invariantViolations: violations,
      anomalies: [],
      stateTimeline: [],
      duration_ms: Date.now() - start,
      error,
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

export const connectionLifecycleScenarios: ScenarioDefinition[] = [
  {
    name: 'connect-disconnect-cycle',
    category: CATEGORY,
    fn: async (ctx) => makeResult('connect-disconnect-cycle', ctx, async () => {
      const validator = new ChaosValidator();
      const conn = await createChaosConnection(ctx.server);
      validator.verifyConnected(conn);

      await conn.disconnect();
      await waitForState(conn, ConnectionState.Disconnected, 5000).catch(() => {});

      return { violations: validator.getViolations() };
    }),
  },
  {
    name: 'rapid-reconnect',
    category: CATEGORY,
    fn: async (ctx) => makeResult('rapid-reconnect', ctx, async () => {
      const validator = new ChaosValidator();
      const rng = new SeededRandom(ctx.seed);
      const cycles = rng.int(2, 4);
      const violations: string[] = [];

      for (let i = 0; i < cycles; i++) {
        const conn = await createChaosConnection(ctx.server);
        validator.verifyConnected(conn);

        // Do a quick operation to verify connection works
        const result = await conn.exec('echo ok');
        if (result.trim() !== 'ok') {
          violations.push(`Cycle ${i}: exec returned "${result.trim()}" instead of "ok"`);
        }

        await safeChaosDisconnect(conn);
        // Small delay between cycles
        await new Promise(r => setTimeout(r, rng.int(100, 500)));
      }

      return { violations: [...violations, ...validator.getViolations()] };
    }),
  },
  {
    name: 'exec-after-connect',
    category: CATEGORY,
    fn: async (ctx) => makeResult('exec-after-connect', ctx, async () => {
      const validator = new ChaosValidator();
      const conn = await createChaosConnection(ctx.server);
      validator.verifyConnected(conn);

      // Verify basic operations work immediately after connect
      const hostname = await conn.exec('hostname');
      if (!hostname.trim()) {
        return { violations: ['hostname command returned empty string'] };
      }

      const uname = await conn.exec('uname -s');
      if (!uname.includes('Linux')) {
        return { violations: [`uname returned unexpected: ${uname.trim()}`] };
      }

      await safeChaosDisconnect(conn);
      return { violations: validator.getViolations() };
    }),
  },
  {
    name: 'state-after-disconnect',
    category: CATEGORY,
    fn: async (ctx) => makeResult('state-after-disconnect', ctx, async () => {
      const validator = new ChaosValidator();
      const conn = await createChaosConnection(ctx.server);
      await conn.disconnect();
      await waitForState(conn, ConnectionState.Disconnected, 5000).catch(() => {});

      // Verify operations throw on disconnected connection
      await validator.verifyDisconnectedThrows(
        () => conn.exec('echo should-fail'),
        'exec'
      );
      await validator.verifyDisconnectedThrows(
        () => conn.listFiles('/home'),
        'listFiles'
      );
      await validator.verifyDisconnectedThrows(
        () => conn.readFile('/etc/hostname'),
        'readFile'
      );

      return { violations: validator.getViolations() };
    }),
  },
];
