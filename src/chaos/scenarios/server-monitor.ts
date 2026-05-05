/**
 * Chaos Scenarios: Server Monitor
 *
 * Tests ServerMonitorService operations against real containers.
 * Verifies monitor commands work across different OS types.
 */

import { ServerMonitorService } from '../../services/ServerMonitorService';
import { ScenarioDefinition, ScenarioContext, ScenarioResult } from '../ChaosConfig';
import { createChaosConnection, safeChaosDisconnect } from '../chaos-helpers';
import { SSHConnection } from '../../connection/SSHConnection';

const CATEGORY = 'server-monitor';

async function makeResult(
  name: string,
  ctx: ScenarioContext,
  fn: (conn: SSHConnection, monitor: ServerMonitorService) => Promise<string[]>
): Promise<ScenarioResult> {
  const start = Date.now();
  let conn: SSHConnection | null = null;
  try {
    // Reset singleton
    (ServerMonitorService as any)._instance = undefined;

    conn = await createChaosConnection(ctx.server);
    const monitor = ServerMonitorService.getInstance();

    const violations = await fn(conn, monitor);

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

// ServerMonitor scenarios run real diagnostic commands (top, free, netstat, journalctl).
// They are slow on every OS and tagged 'heavy' so the engine samples them at
// ceil(variations / 3) — preserving cross-OS coverage without budget starvation.
export const serverMonitorScenarios: ScenarioDefinition[] = [
  {
    name: 'quickStatus',
    category: CATEGORY,
    weight: 'heavy',
    fn: (ctx) => makeResult('quickStatus', ctx, async (conn, monitor) => {
      // quickStatus should not throw on any OS
      await monitor.quickStatus(conn);
      return [];
    }),
  },
  {
    name: 'diagnoseSlowness',
    category: CATEGORY,
    weight: 'heavy',
    fn: (ctx) => makeResult('diagnoseSlowness', ctx, async (conn, monitor) => {
      await monitor.diagnoseSlowness(conn);
      return [];
    }),
  },
  {
    name: 'listServices',
    category: CATEGORY,
    weight: 'heavy',
    fn: (ctx) => makeResult('listServices', ctx, async (conn, monitor) => {
      await monitor.listServices(conn);
      return [];
    }),
  },
  {
    name: 'recentLogs',
    category: CATEGORY,
    weight: 'heavy',
    fn: (ctx) => makeResult('recentLogs', ctx, async (conn, monitor) => {
      await monitor.recentLogs(conn);
      return [];
    }),
  },
  {
    name: 'networkDiagnostics',
    category: CATEGORY,
    weight: 'heavy',
    fn: (ctx) => makeResult('networkDiagnostics', ctx, async (conn, monitor) => {
      await monitor.networkDiagnostics(conn);
      return [];
    }),
  },
];
