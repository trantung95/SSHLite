/**
 * SSH Tools Chaos Test
 *
 * Targeted chaos run for the new v0.6-v0.7 services.
 * Runs only ssh-tools scenarios to fit within the time budget.
 *
 * Pure scenarios (clipboard, snippet, parsers) run on all available servers.
 * SSH scenarios run on the 3 basic Alpine servers from docker-compose.yml.
 *
 * Run: npx jest --config jest.chaos.config.js --no-coverage -- chaos-ssh-tools
 * Or via: npm run test:chaos:tools
 */

import { sshToolsScenarios } from './scenarios/ssh-tools';
import { sshToolsKeyScenarios } from './scenarios/ssh-tools-keys';
import { getRunConfig, BASIC_SERVERS, ChaosServerConfig } from './ChaosConfig';
import { createChaosConnection, safeChaosDisconnect, setupCredentialServiceMock, setupVscodeMocks } from './chaos-helpers';
import { ScenarioContext, ScenarioResult } from './ChaosConfig';

const ALL_SSH_TOOLS = [...sshToolsScenarios, ...sshToolsKeyScenarios];

describe('SSH Tools Chaos', () => {
  it('should pass all ssh-tools scenarios', async () => {
    setupCredentialServiceMock();
    setupVscodeMocks();

    const config = getRunConfig();
    const seed = config.seed;
    const variations = config.mode === 'quick' ? 2 : 4;

    // Determine which servers are live (pre-flight check)
    const liveServers: ChaosServerConfig[] = [];
    for (const server of BASIC_SERVERS) {
      let conn = null;
      try {
        conn = await createChaosConnection(server);
        liveServers.push(server);
      } catch {
        console.log(`[SSH-Tools Chaos] SKIP: ${server.label} (not reachable)`);
      } finally {
        if (conn) { await safeChaosDisconnect(conn); }
      }
    }

    if (liveServers.length === 0) {
      console.warn('[SSH-Tools Chaos] No servers reachable — skipping SSH scenarios');
      // Pure scenarios still run (no server needed), but we need at least one server label for result shape
      liveServers.push({ ...BASIC_SERVERS[0], label: 'localhost-mock' });
    }

    const results: ScenarioResult[] = [];
    const failures: Array<{ name: string; server: string; detail: string }> = [];

    for (const scenario of ALL_SSH_TOOLS) {
      for (const server of liveServers) {
        for (let v = 0; v < variations; v++) {
          const ctx: ScenarioContext = {
            server,
            testDir: `/tmp/chaos-tools-${Date.now()}-${v}`,
            seed,
            variation: v,
          };
          const result = await scenario.fn(ctx);
          results.push(result);
          const pass = result.passed && !result.error;
          const status = pass ? '✓' : '✗';
          console.log(`  ${status} ${result.name} [${result.server}] (${result.duration_ms}ms)`);
          if (!pass) {
            const detail = result.error || (result.invariantViolations || []).join('; ');
            failures.push({ name: result.name, server: result.server, detail });
            console.error(`    FAIL: ${detail}`);
          }
        }
      }
    }

    const total = results.length;
    const passed = results.filter((r) => r.passed && !r.error).length;
    const failed = total - passed;

    console.log(`\n[SSH-Tools Chaos] Results: ${passed}/${total} passed, ${failed} failed`);
    console.log(`[SSH-Tools Chaos] Scenarios: ${ALL_SSH_TOOLS.length}, Servers: ${liveServers.length}, Variations: ${variations}`);

    if (failures.length > 0) {
      const msg = failures.map((f) => `${f.name} (${f.server}): ${f.detail}`).join('\n');
      throw new Error(`[SSH-Tools Chaos] ${failures.length} failure(s):\n${msg}`);
    }
  }, 300000);
});
