/**
 * Chaos Scenarios: Port Forwarding
 *
 * Tests SSHConnection.forwardPort / stopForward / getActiveForwards lifecycle.
 * Contract: forwardPort registers the local port; stopForward unregisters it;
 * getActiveForwards reflects the current set; calls balance to baseline.
 *
 * Note: scenarios verify the registry contract only — they do not bind real
 * traffic to the forwarded port (that would require allocating high ports
 * deterministically, which is brittle in CI). The registry is what user-facing
 * commands rely on, so it's the correct chaos surface.
 */

import { SSHConnection } from '../../connection/SSHConnection';
import { ScenarioDefinition, ScenarioContext, ScenarioResult } from '../ChaosConfig';
import { createChaosConnection, safeChaosDisconnect, SeededRandom } from '../chaos-helpers';

const CATEGORY = 'port-forward';

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

export const portForwardScenarios: ScenarioDefinition[] = [
  {
    name: 'lifecycle',
    category: CATEGORY,
    fn: (ctx) => makeResult('lifecycle', ctx, async (conn, rng) => {
      const violations: string[] = [];

      // High random port to avoid collisions across parallel chaos runs
      const localPort = rng.int(49152, 65535);
      const baseline = conn.getActiveForwards();
      if (baseline.includes(localPort)) {
        // Extremely unlikely; skip rather than report a false violation
        return [];
      }

      try {
        await conn.forwardPort(localPort, '127.0.0.1', 22);
      } catch (err) {
        // forwardPort can fail if the local port is taken — accept and move on
        const msg = (err as Error).message;
        if (/address already in use|EADDRINUSE/i.test(msg)) return [];
        throw err;
      }

      const afterForward = conn.getActiveForwards();
      if (!afterForward.includes(localPort)) {
        violations.push(`forwardPort invariant: ${localPort} not in getActiveForwards after success`);
      }
      if (afterForward.length !== baseline.length + 1) {
        violations.push(`forwardPort invariant: active forwards count ${afterForward.length}, expected ${baseline.length + 1}`);
      }

      await conn.stopForward(localPort);

      const afterStop = conn.getActiveForwards();
      if (afterStop.includes(localPort)) {
        violations.push(`stopForward invariant: ${localPort} still in getActiveForwards after stop`);
      }
      if (afterStop.length !== baseline.length) {
        violations.push(`stopForward invariant: active forwards count ${afterStop.length}, expected baseline ${baseline.length}`);
      }

      return violations;
    }),
  },
];
