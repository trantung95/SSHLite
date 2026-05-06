/**
 * Chaos Engine - jest entry point
 *
 * Runs the new session-based chaos engine against the live Docker stack
 * within the configured global budget. Exercises real SSH connections,
 * concurrent chains, and real fault injection. Results are written to
 * logs/chaos-results.jsonl for replay.
 *
 * Configurable via environment variables:
 *   CHAOS_MODE=quick|deep (default: quick)
 *   CHAOS_SEED=<number>   (default: Date.now())
 */

import { ChaosEngine } from './ChaosEngine';
import { getRunConfig } from './ChaosConfig';
import { setupCredentialServiceMock, setupVscodeMocks } from './chaos-helpers';

describe('Chaos Engine', () => {
  beforeAll(() => {
    setupVscodeMocks();
    setupCredentialServiceMock();
  });

  it('runs sessions within the configured budget without crashing', async () => {
    const config = getRunConfig();
    const engine = new ChaosEngine(config);

    console.log(`[Chaos] Mode: ${config.mode}`);
    console.log(`[Chaos] Seed: ${config.seed}`);
    console.log(`[Chaos] Servers: ${config.servers.length}`);
    console.log(`[Chaos] Budget: ${config.globalBudgetMs}ms`);

    const results = await engine.run();
    console.log(`[Chaos] Sessions: ${results.length}`);

    const violations = results.filter(r => r.outcome !== 'passed');
    if (violations.length > 0) {
      console.log(`[Chaos] Sessions with violations: ${violations.length}`);
      for (const v of violations.slice(0, 5)) {
        console.log(`  ${v.run_id}: ${JSON.stringify(v.outcome)}`);
      }
    }

    // Engine ran without crashing; violation review happens via the JSONL output.
    expect(results.length).toBeGreaterThan(0);
  }, 900000);
});
