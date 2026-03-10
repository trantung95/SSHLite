/**
 * Chaos Bug Discovery Module - Engine (Orchestrator)
 *
 * Ties together collector, detector, validator, logger, and scenarios.
 * Iterates: for each scenario x for each server -> run with random params.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SSHConnection } from '../connection/SSHConnection';
import { CommandGuard } from '../services/CommandGuard';
import { ActivityService } from '../services/ActivityService';
import { ServerMonitorService } from '../services/ServerMonitorService';
import {
  ChaosRunConfig,
  ChaosRunResult,
  ChaosServerConfig,
  ScenarioDefinition,
  ScenarioResult,
  ScenarioContext,
  CoverageManifest,
  PerOSSummary,
  getRunConfig,
} from './ChaosConfig';
import { ChaosCollector, CollectedData } from './ChaosCollector';
import { ChaosDetector } from './ChaosDetector';
import { ChaosValidator } from './ChaosValidator';
import { ChaosLogger } from './ChaosLogger';
import {
  createChaosConnection,
  safeChaosDisconnect,
  setupCredentialServiceMock,
  setupVscodeMocks,
  SeededRandom,
  withTimeout,
} from './chaos-helpers';
import { ContainerHealthMonitor, ContainerDeathEvent, ContainerHealthReport } from './ContainerHealthMonitor';

/** All known actions that scenarios can exercise */
const ALL_KNOWN_ACTIONS = [
  'exec', 'listFiles', 'readFile', 'writeFile', 'deleteFile',
  'mkdir', 'rename', 'stat', 'searchFiles', 'readFileChunked',
  'readFileLastLines', 'readFileFirstLines', 'connect', 'disconnect',
  'guard.exec', 'guard.readFile', 'guard.writeFile', 'guard.listFiles',
  'guard.searchFiles', 'monitor.quickStatus', 'monitor.diagnoseSlowness',
  'monitor.listServices', 'monitor.recentLogs', 'monitor.networkDiagnostics',
];

export class ChaosEngine {
  private config: ChaosRunConfig;
  private collector: ChaosCollector;
  private detector: ChaosDetector;
  private validator: ChaosValidator;
  private logger: ChaosLogger;
  private random: SeededRandom;
  private allCollectedData: CollectedData[] = [];
  private healthMonitor: ContainerHealthMonitor;
  private deadServers: Set<string> = new Set();
  /** Per-scenario container log snapshots: [scenarioName, serverLabel, logs] */
  private scenarioLogs: Array<{ scenario: string; server: string; logs: string }> = [];

  constructor(config?: ChaosRunConfig) {
    this.config = config || getRunConfig();
    this.collector = new ChaosCollector();
    this.detector = new ChaosDetector();
    this.validator = new ChaosValidator();
    this.logger = new ChaosLogger();
    this.random = new SeededRandom(this.config.seed);
    this.healthMonitor = new ContainerHealthMonitor(this.config.servers);
  }

  /**
   * Run all scenarios across all servers.
   * Returns the number of failures.
   */
  async run(scenarios: ScenarioDefinition[]): Promise<number> {
    const startTime = Date.now();

    // Setup mocks
    setupCredentialServiceMock();
    setupVscodeMocks();

    // Reset singletons
    (CommandGuard as any)._instance = undefined;
    (ActivityService as any)._instance = undefined;
    (ServerMonitorService as any)._instance = undefined;

    // Check coverage manifest
    this.checkCoverageManifest(scenarios);

    console.log(`\n[Chaos] Starting ${this.config.mode} mode (seed: ${this.config.seed})`);
    console.log(`[Chaos] Servers: ${this.config.servers.map(s => s.label).join(', ')}`);
    console.log(`[Chaos] Scenarios: ${scenarios.length} x ${this.config.servers.length} servers x ${this.config.variationsPerScenario} variations`);

    // Pre-flight: verify all containers are running
    const preFlightFailed = await this.healthMonitor.preFlightCheck();
    if (preFlightFailed.length > 0) {
      console.error(`\n[Chaos] PRE-FLIGHT FAILED: ${preFlightFailed.length} container(s) not running:`);
      for (const c of preFlightFailed) {
        console.error(`  - ${c.name} (${c.serverLabel}): ${c.status}${c.exitCode !== undefined ? ` (exit ${c.exitCode})` : ''}`);
        this.deadServers.add(c.serverLabel);
      }
      console.error('[Chaos] These servers will be skipped.\n');
    }

    // Start real-time container health monitoring
    this.healthMonitor.onDeath((event: ContainerDeathEvent) => {
      console.error(`[Chaos] ALERT: Container ${event.container} died during scenario execution!`);
      this.deadServers.add(event.serverLabel);
    });
    this.healthMonitor.start();

    // Global time budget: stop before Jest's outer timeout kills us ungracefully
    const maxTotalRunTime = this.config.mode === 'quick' ? 300000 : 780000;
    let globalTimeoutHit = false;
    let scenariosSkipped = 0;

    let containerHealth: ContainerHealthReport | undefined;

    try {
      // Run each scenario on each server with variations
      for (const scenario of scenarios) {
        if (globalTimeoutHit) break;
        for (const server of this.config.servers) {
          if (globalTimeoutHit) break;

          // Skip dead servers
          if (this.deadServers.has(server.label)) {
            scenariosSkipped += this.config.variationsPerScenario;
            console.log(`  SKIP: ${scenario.name} on ${server.label} (container dead)`);
            continue;
          }

          for (let variation = 0; variation < this.config.variationsPerScenario; variation++) {
            // Check global time budget
            if (Date.now() - startTime > maxTotalRunTime) {
              console.error(`[Chaos] GLOBAL TIMEOUT: ${maxTotalRunTime}ms exceeded, stopping remaining scenarios`);
              globalTimeoutHit = true;
              break;
            }

            const result = await this.runScenario(scenario, server, variation);
            this.logger.addResult(result);

            // Record the actions exercised by this scenario category
            this.logger.recordAction(scenario.category);

            if (!result.passed) {
              console.log(`  FAIL: ${scenario.name} on ${server.label} (v${variation}): ${result.error || result.invariantViolations.join('; ')}`);
            }
          }
        }
      }

      // Add invariant stats
      this.logger.addInvariantStats(
        this.validator.getStats().checked,
        this.validator.getStats().violated
      );

      // Stop container monitoring and collect health report
      containerHealth = this.healthMonitor.stop();
    } finally {
      // Ensure monitor is always stopped, even on crash
      if (!containerHealth) {
        containerHealth = this.healthMonitor.stop();
      }
    }

    // Build and write results
    const durationMs = Date.now() - startTime;
    const servers = this.config.servers.map(s => ({ label: s.label, os: s.os, port: s.port }));
    const result = this.logger.buildRunResult(
      this.config.mode,
      this.config.seed,
      durationMs,
      servers,
      this.allCollectedData,
      ALL_KNOWN_ACTIONS,
      containerHealth
    );

    // Record skipped scenarios and early termination reason
    result.scenarios_skipped = scenariosSkipped;
    if (globalTimeoutHit) {
      result.early_termination = {
        reason: 'global_timeout',
        message: `Global time budget of ${maxTotalRunTime}ms exceeded after ${result.scenarios_run} scenarios. ${scenariosSkipped} scenarios were skipped.`,
      };
    } else if (this.deadServers.size === this.config.servers.length) {
      result.early_termination = {
        reason: 'all_servers_dead',
        message: `All ${this.config.servers.length} servers are dead. ${scenariosSkipped} scenarios were skipped.`,
      };
    }

    // Generate post-run analysis
    result.post_run_analysis = this.generatePostRunAnalysis(result);

    this.logger.writeToFile(result);
    this.logger.printSummary(result);

    // Write all per-scenario container logs to file
    this.writeContainerLogs();

    return result.failed;
  }

  /**
   * Write all collected per-scenario container logs to logs/chaos-container-logs.txt.
   * Each scenario's log snapshot shows the full container output at that point in time.
   */
  private writeContainerLogs(): void {
    if (this.scenarioLogs.length === 0) return;

    const logsDir = path.resolve(__dirname, '../../logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logFile = path.join(logsDir, 'chaos-container-logs.txt');
    const sections: string[] = [];
    const timestamp = new Date().toISOString();

    sections.push('='.repeat(80));
    sections.push(`CHAOS CONTAINER LOGS — ${timestamp}`);
    sections.push(`Mode: ${this.config.mode} | Seed: ${this.config.seed}`);
    sections.push(`Scenarios with logs: ${this.scenarioLogs.length}`);
    sections.push('='.repeat(80));
    sections.push('');

    for (const { scenario, server, logs } of this.scenarioLogs) {
      sections.push('─'.repeat(60));
      sections.push(`Scenario: ${scenario} | Server: ${server}`);
      sections.push('─'.repeat(60));
      sections.push(logs || '(empty)');
      sections.push('');
    }

    fs.writeFileSync(logFile, sections.join('\n'), 'utf-8');
    console.log(`[Chaos] Container logs saved to ${logFile} (${this.scenarioLogs.length} snapshots)`);
  }

  /**
   * Run a single scenario on a single server.
   */
  private async runScenario(
    scenario: ScenarioDefinition,
    server: ChaosServerConfig,
    variation: number
  ): Promise<ScenarioResult> {
    const scenarioSeed = this.random.int(0, 2147483647);
    const testDir = `/home/${server.username}/chaos-${server.label}-${Date.now()}`;

    const ctx: ScenarioContext = {
      server,
      testDir,
      seed: scenarioSeed,
      variation,
    };

    // Reset per-scenario state
    this.validator.reset();
    (ActivityService as any)._instance = undefined;

    // Start collecting
    this.collector.start();

    let conn: SSHConnection | null = null;

    try {
      // Create connection and hook it
      conn = await createChaosConnection(server);
      this.collector.hookConnection(conn);

      // Create test directory
      await conn.mkdir(testDir);

      // Run the scenario with timeout
      const result = await Promise.race([
        scenario.fn(ctx),
        new Promise<ScenarioResult>((_, reject) =>
          setTimeout(() => reject(new Error('Scenario timeout')), this.config.scenarioTimeout)
        ),
      ]);

      // Post-scenario invariant checks
      this.validator.verifyConnected(conn);

      // Wait a moment for async activity completions
      await new Promise(r => setTimeout(r, 500));
      this.validator.verifyNoRunningActivities();

      // Collect output and detect anomalies
      const collectedData = this.collector.stop();
      this.allCollectedData.push(collectedData);

      const anomalies = this.detector.detect(collectedData, {
        scenario: scenario.name,
        server_os: server.os,
        server_label: server.label,
      });

      const violations = [
        ...result.invariantViolations,
        ...this.validator.getViolations(),
      ];

      const allAnomalies = [...result.anomalies, ...anomalies];

      return {
        ...result,
        server: server.label,
        server_os: server.os,
        invariantViolations: violations,
        anomalies: allAnomalies,
        stateTimeline: collectedData.stateTimeline,
        passed: result.passed && violations.length === 0,
      };
    } catch (err) {
      // Collect whatever we have
      const collectedData = this.collector.stop();
      this.allCollectedData.push(collectedData);

      return {
        name: scenario.name,
        server: server.label,
        server_os: server.os,
        passed: false,
        invariantViolations: this.validator.getViolations(),
        anomalies: [],
        stateTimeline: collectedData.stateTimeline,
        duration_ms: 0,
        error: (err as Error).message,
      };
    } finally {
      // Cleanup: remove test dir and disconnect (with timeouts to prevent hangs)
      if (conn) {
        try {
          await withTimeout(conn.exec(`rm -rf ${testDir}`), 10000, 'cleanup rm -rf');
        } catch { /* ignore */ }
        await safeChaosDisconnect(conn);
      }

      // Collect container logs after each scenario
      try {
        const logs = await withTimeout(
          this.healthMonitor.collectLogsForServer(server.label),
          5000,
          `collect logs for ${server.label}`
        );
        this.scenarioLogs.push({ scenario: scenario.name, server: server.label, logs });
      } catch { /* ignore timeout */ }
    }
  }

  /**
   * Generate post-run analysis: summarize findings, correlate failures with
   * container health, and produce actionable insights.
   */
  private generatePostRunAnalysis(result: ChaosRunResult): string[] {
    const analysis: string[] = [];

    // Overall health
    const passRate = result.scenarios_run > 0
      ? ((result.passed / result.scenarios_run) * 100).toFixed(1)
      : '0';
    analysis.push(`Pass rate: ${passRate}% (${result.passed}/${result.scenarios_run})`);

    // Early termination
    if (result.early_termination) {
      analysis.push(`EARLY TERMINATION [${result.early_termination.reason}]: ${result.early_termination.message}`);
    }

    // Skipped scenarios
    if (result.scenarios_skipped > 0) {
      analysis.push(`Skipped: ${result.scenarios_skipped} scenario(s) due to dead/unavailable servers (${Array.from(this.deadServers).join(', ')})`);
    }

    // Container health correlation
    if (result.container_health.dead > 0) {
      analysis.push(`CRITICAL: ${result.container_health.dead} container(s) died during the run`);
      for (const death of result.container_health.deaths) {
        analysis.push(`  Container ${death.container} (${death.serverLabel}) exited with code ${death.exitCode}`);
        analysis.push(`  Root cause: ${death.analysis}`);

        // Correlate with scenario failures on this server
        const relatedFailures = result.failures.filter(f => f.server_label === death.serverLabel);
        if (relatedFailures.length > 0) {
          analysis.push(`  ${relatedFailures.length} scenario failure(s) likely caused by this container death:`);
          for (const f of relatedFailures) {
            analysis.push(`    - ${f.scenario}: ${f.error || f.invariantViolations.join('; ')}`);
          }
        }
      }
    } else {
      analysis.push('All containers remained healthy throughout the run');
    }

    // Per-OS analysis
    for (const [os, summary] of Object.entries(result.per_os_summary) as [string, PerOSSummary][]) {
      if (summary.failed > 0) {
        const osFailRate = ((summary.failed / summary.run) * 100).toFixed(1);
        analysis.push(`${os}: ${osFailRate}% failure rate (${summary.failed}/${summary.run}) — investigate OS-specific issues`);
      }
    }

    // Anomaly patterns
    if (result.anomalies_detected.length > 0) {
      const byType: Record<string, number> = {};
      for (const a of result.anomalies_detected) {
        byType[a.type] = (byType[a.type] || 0) + 1;
      }
      analysis.push(`Anomaly breakdown: ${Object.entries(byType).map(([t, c]) => `${t}=${c}`).join(', ')}`);
    }

    // Coverage gaps
    if (result.coverage.actions_missed.length > 0) {
      analysis.push(`Coverage gaps: ${result.coverage.actions_missed.length} actions not exercised — add scenarios for: ${result.coverage.actions_missed.join(', ')}`);
    }
    if (result.coverage.methods_uncovered.length > 0) {
      analysis.push(`Uncovered methods: ${result.coverage.methods_uncovered.length} — add scenarios to improve coverage`);
    }

    // Invariant health
    if (result.coverage.invariants_violated > 0) {
      const violationRate = ((result.coverage.invariants_violated / result.coverage.invariants_checked) * 100).toFixed(2);
      analysis.push(`Invariant violation rate: ${violationRate}% (${result.coverage.invariants_violated}/${result.coverage.invariants_checked})`);
    }

    // Output channel errors
    const outputEntries = Object.entries(result.output_summary) as [string, { lines: number; errors: number }][];
    const channelsWithErrors = outputEntries.filter(([, stats]) => stats.errors > 0);
    if (channelsWithErrors.length > 0) {
      analysis.push(`Output channels with errors: ${channelsWithErrors.map(([ch, s]) => `${ch}(${s.errors})`).join(', ')}`);
    }

    // Duration insight
    const durationSec = (result.duration_ms / 1000).toFixed(1);
    const avgPerScenario = result.scenarios_run > 0
      ? (result.duration_ms / result.scenarios_run / 1000).toFixed(2)
      : '0';
    analysis.push(`Total duration: ${durationSec}s, avg ${avgPerScenario}s per scenario`);

    return analysis;
  }

  /**
   * Strategy 7: Check coverage manifest for uncovered methods.
   */
  private checkCoverageManifest(scenarios: ScenarioDefinition[]): void {
    const manifestPath = path.resolve(__dirname, 'coverage-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.log('[Chaos] No coverage manifest found, skipping coverage check');
      return;
    }

    try {
      const manifest: CoverageManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      const scenarioCategories = new Set(scenarios.map(s => s.category));
      const uncovered: string[] = [];

      for (const [method, coveredBy] of Object.entries(manifest)) {
        if (coveredBy.length === 0) {
          uncovered.push(method);
        } else {
          // Check if any covering scenario is actually registered
          const hasCoverage = coveredBy.some(cat => scenarioCategories.has(cat));
          if (!hasCoverage) {
            uncovered.push(method);
          }
        }
      }

      if (uncovered.length > 0) {
        console.log(`[Chaos] WARNING: ${uncovered.length} methods without scenario coverage:`);
        for (const m of uncovered) {
          console.log(`  - ${m}`);
        }
      }

      this.logger.setUncoveredMethods(uncovered);
    } catch (err) {
      console.error('[Chaos] Failed to read coverage manifest:', (err as Error).message);
    }
  }

  /**
   * Scan source files for public methods (for coverage manifest updates).
   */
  static scanPublicMethods(): Record<string, string[]> {
    const sourceFiles: Record<string, string> = {
      'SSHConnection': path.resolve(__dirname, '../connection/SSHConnection.ts'),
      'CommandGuard': path.resolve(__dirname, '../services/CommandGuard.ts'),
      'ServerMonitorService': path.resolve(__dirname, '../services/ServerMonitorService.ts'),
      'ActivityService': path.resolve(__dirname, '../services/ActivityService.ts'),
    };

    const methods: Record<string, string[]> = {};

    for (const [className, filePath] of Object.entries(sourceFiles)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const classMethods: string[] = [];
        // Fresh regex per file — global-flag regexes retain lastIndex across calls,
        // so reusing one across loop iterations causes silent method skipping after errors
        const methodPattern = /^\s+(?:async\s+)?(\w+)\s*\(/gm;
        let match;

        while ((match = methodPattern.exec(content)) !== null) {
          const name = match[1];
          // Skip constructor, private methods (prefixed with _), and common utility methods
          if (name === 'constructor' || name.startsWith('_') || name === 'dispose') continue;
          classMethods.push(name);
        }

        methods[className] = [...new Set(classMethods)];
      } catch {
        // File not found
      }
    }

    return methods;
  }
}
