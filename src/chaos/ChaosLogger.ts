/**
 * Chaos Bug Discovery Module - Structured Logger
 *
 * Writes structured JSON results to logs/chaos-results.jsonl (append-only).
 * Also provides console summary for immediate feedback.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ChaosRunResult, ScenarioResult, Anomaly, PerOSSummary } from './ChaosConfig';
import { CollectedData } from './ChaosCollector';

const LOGS_DIR = path.resolve(__dirname, '../../logs');
const RESULTS_FILE = path.join(LOGS_DIR, 'chaos-results.jsonl');

export class ChaosLogger {
  private scenarioResults: ScenarioResult[] = [];
  private allAnomalies: Anomaly[] = [];
  private totalInvariantsChecked = 0;
  private totalInvariantsViolated = 0;
  private actionsExercised = new Set<string>();
  private methodsUncovered: string[] = [];

  /**
   * Record a scenario result.
   */
  addResult(result: ScenarioResult): void {
    this.scenarioResults.push(result);
    this.allAnomalies.push(...result.anomalies);
  }

  /**
   * Record invariant stats.
   */
  addInvariantStats(checked: number, violated: number): void {
    this.totalInvariantsChecked += checked;
    this.totalInvariantsViolated += violated;
  }

  /**
   * Record an action that was exercised.
   */
  recordAction(action: string): void {
    this.actionsExercised.add(action);
  }

  /**
   * Set uncovered methods from coverage manifest check.
   */
  setUncoveredMethods(methods: string[]): void {
    this.methodsUncovered = methods;
  }

  /**
   * Build per-OS summary.
   */
  private buildPerOSSummary(): Record<string, PerOSSummary> {
    const summary: Record<string, PerOSSummary> = {};
    for (const result of this.scenarioResults) {
      const os = result.server_os;
      if (!summary[os]) {
        summary[os] = { run: 0, passed: 0, failed: 0 };
      }
      summary[os].run++;
      if (result.passed) {
        summary[os].passed++;
      } else {
        summary[os].failed++;
      }
    }
    return summary;
  }

  /**
   * Build output summary from collected data across all scenarios.
   */
  buildOutputSummary(allCollectedData: CollectedData[]): Record<string, { lines: number; errors: number }> {
    const summary: Record<string, { lines: number; errors: number }> = {};
    for (const data of allCollectedData) {
      for (const [channel, lines] of data.outputChannels) {
        if (!summary[channel]) {
          summary[channel] = { lines: 0, errors: 0 };
        }
        summary[channel].lines += lines.length;
        summary[channel].errors += lines.filter(l => /error|failed/i.test(l)).length;
      }
    }
    return summary;
  }

  /**
   * Build the full run result.
   */
  buildRunResult(
    mode: string,
    seed: number,
    durationMs: number,
    servers: Array<{ label: string; os: string; port: number }>,
    allCollectedData: CollectedData[],
    allKnownActions: string[]
  ): ChaosRunResult {
    const passed = this.scenarioResults.filter(r => r.passed).length;
    const failed = this.scenarioResults.filter(r => !r.passed).length;
    const exercised = Array.from(this.actionsExercised);
    const missed = allKnownActions.filter(a => !this.actionsExercised.has(a));

    return {
      timestamp: new Date().toISOString(),
      mode: mode as any,
      seed,
      client_os: process.platform,
      duration_ms: durationMs,
      servers_tested: servers,
      scenarios_run: this.scenarioResults.length,
      passed,
      failed,
      failures: this.scenarioResults
        .filter(r => !r.passed)
        .map(r => ({
          scenario: r.name,
          server_os: r.server_os,
          server_label: r.server,
          error: r.error,
          invariantViolations: r.invariantViolations,
        })),
      per_os_summary: this.buildPerOSSummary(),
      anomalies_detected: this.allAnomalies,
      coverage: {
        actions_exercised: exercised,
        actions_missed: missed,
        methods_uncovered: this.methodsUncovered,
        invariants_checked: this.totalInvariantsChecked,
        invariants_violated: this.totalInvariantsViolated,
      },
      output_summary: this.buildOutputSummary(allCollectedData),
    };
  }

  /**
   * Write run result to JSONL log file.
   */
  writeToFile(result: ChaosRunResult): void {
    try {
      if (!fs.existsSync(LOGS_DIR)) {
        fs.mkdirSync(LOGS_DIR, { recursive: true });
      }
      fs.appendFileSync(RESULTS_FILE, JSON.stringify(result) + '\n');
    } catch (err) {
      console.error('[Chaos] Failed to write results file:', (err as Error).message);
    }
  }

  /**
   * Print console summary.
   */
  printSummary(result: ChaosRunResult): void {
    const divider = '='.repeat(70);

    console.log(`\n${divider}`);
    console.log(`  CHAOS BUG DISCOVERY RESULTS`);
    console.log(`  Mode: ${result.mode} | Seed: ${result.seed} | Client OS: ${result.client_os}`);
    console.log(`  Duration: ${(result.duration_ms / 1000).toFixed(1)}s`);
    console.log(divider);

    // Per-OS summary
    console.log('\n  Per-OS Results:');
    for (const [os, summary] of Object.entries(result.per_os_summary)) {
      const status = summary.failed === 0 ? 'PASS' : 'FAIL';
      console.log(`    ${os.padEnd(10)} ${summary.run} run, ${summary.passed} passed, ${summary.failed} failed [${status}]`);
    }

    // Overall
    console.log(`\n  Total: ${result.scenarios_run} scenarios, ${result.passed} passed, ${result.failed} failed`);

    // Failures
    if (result.failures.length > 0) {
      console.log(`\n  FAILURES:`);
      for (const f of result.failures) {
        console.log(`    [${f.server_os}] ${f.scenario}: ${f.error || 'invariant violations'}`);
        for (const v of f.invariantViolations) {
          console.log(`      - ${v}`);
        }
      }
    }

    // Anomalies
    if (result.anomalies_detected.length > 0) {
      console.log(`\n  ANOMALIES DETECTED (${result.anomalies_detected.length}):`);
      for (const a of result.anomalies_detected.slice(0, 20)) {
        console.log(`    [${a.type}] ${a.server_os || '?'}: ${a.message.substring(0, 100)}`);
      }
      if (result.anomalies_detected.length > 20) {
        console.log(`    ... and ${result.anomalies_detected.length - 20} more`);
      }
    }

    // Coverage
    console.log(`\n  Coverage:`);
    console.log(`    Actions exercised: ${result.coverage.actions_exercised.length}`);
    console.log(`    Actions missed: ${result.coverage.actions_missed.length}`);
    if (result.coverage.actions_missed.length > 0) {
      console.log(`      ${result.coverage.actions_missed.join(', ')}`);
    }
    console.log(`    Invariants checked: ${result.coverage.invariants_checked}`);
    console.log(`    Invariants violated: ${result.coverage.invariants_violated}`);

    // Uncovered methods
    if (result.coverage.methods_uncovered.length > 0) {
      console.log(`\n  UNCOVERED METHODS (${result.coverage.methods_uncovered.length}):`);
      for (const m of result.coverage.methods_uncovered) {
        console.log(`    - ${m}`);
      }
    }

    // Output channel summary
    console.log(`\n  Output Channel Summary:`);
    for (const [channel, stats] of Object.entries(result.output_summary)) {
      console.log(`    ${channel}: ${stats.lines} lines, ${stats.errors} errors`);
    }

    console.log(`\n${divider}\n`);
  }
}
