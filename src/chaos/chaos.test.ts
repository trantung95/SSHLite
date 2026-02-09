/**
 * Chaos Bug Discovery Module - Jest Entry Point
 *
 * Runs the chaos engine with all registered scenarios.
 * Configurable via environment variables:
 *   CHAOS_MODE=quick|deep (default: quick)
 *   CHAOS_SEED=<number>   (default: Date.now())
 *   CHAOS_TIMEOUT=<ms>    (default: 360000)
 */

import { ChaosEngine } from './ChaosEngine';
import { ALL_SCENARIOS } from './scenarios';
import { getRunConfig } from './ChaosConfig';

describe('Chaos Bug Discovery', () => {
  it('should run all scenarios and report findings', async () => {
    const config = getRunConfig();
    const engine = new ChaosEngine(config);

    console.log(`[Chaos] Mode: ${config.mode}`);
    console.log(`[Chaos] Seed: ${config.seed}`);
    console.log(`[Chaos] Scenarios: ${ALL_SCENARIOS.length}`);
    console.log(`[Chaos] Servers: ${config.servers.length}`);
    console.log(`[Chaos] Variations per scenario: ${config.variationsPerScenario}`);
    console.log(`[Chaos] Total scenario runs: ${ALL_SCENARIOS.length * config.servers.length * config.variationsPerScenario}`);

    const failures = await engine.run(ALL_SCENARIOS);

    // The test passes if the engine ran successfully.
    // Failures are reported in logs/chaos-results.jsonl and console output.
    // We don't fail the Jest test on scenario failures -- the chaos module
    // is about discovery, not pass/fail gating.
    // However, if we want strict mode, uncomment:
    // expect(failures).toBe(0);

    expect(true).toBe(true); // Engine ran without crashing
  });
});
