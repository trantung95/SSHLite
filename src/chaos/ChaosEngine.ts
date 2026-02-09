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
  ChaosServerConfig,
  ScenarioDefinition,
  ScenarioResult,
  ScenarioContext,
  CoverageManifest,
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
} from './chaos-helpers';

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

  constructor(config?: ChaosRunConfig) {
    this.config = config || getRunConfig();
    this.collector = new ChaosCollector();
    this.detector = new ChaosDetector();
    this.validator = new ChaosValidator();
    this.logger = new ChaosLogger();
    this.random = new SeededRandom(this.config.seed);
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

    // Run each scenario on each server with variations
    for (const scenario of scenarios) {
      for (const server of this.config.servers) {
        for (let variation = 0; variation < this.config.variationsPerScenario; variation++) {
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

    // Build and write results
    const durationMs = Date.now() - startTime;
    const servers = this.config.servers.map(s => ({ label: s.label, os: s.os, port: s.port }));
    const result = this.logger.buildRunResult(
      this.config.mode,
      this.config.seed,
      durationMs,
      servers,
      this.allCollectedData,
      ALL_KNOWN_ACTIONS
    );

    this.logger.writeToFile(result);
    this.logger.printSummary(result);

    return result.failed;
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
      // Cleanup: remove test dir and disconnect
      if (conn) {
        try {
          await conn.exec(`rm -rf ${testDir}`);
        } catch { /* ignore */ }
        await safeChaosDisconnect(conn);
      }
    }
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
    const methodPattern = /^\s+(?:async\s+)?(\w+)\s*\(/gm;

    for (const [className, filePath] of Object.entries(sourceFiles)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const classMethods: string[] = [];
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
