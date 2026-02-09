/**
 * Chaos Bug Discovery Module - Configuration
 *
 * Defines types, modes, server configs, and runtime settings
 * for the chaos testing framework.
 */

import { ConnectionState } from '../types';

// ---- Modes ----

export type ChaosMode = 'quick' | 'deep';

// ---- Server Configuration ----

export interface ChaosServerConfig {
  label: string;
  os: string;
  host: string;
  port: number;
  username: string;
  password: string;
  hostname: string;
  shell: 'bash' | 'ash';
  group: 'basic' | 'multios';
}

/** Basic Alpine servers (docker-compose.yml) */
export const BASIC_SERVERS: ChaosServerConfig[] = [
  { label: 'prod-server', os: 'Alpine', host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass', hostname: 'prod-server', shell: 'ash', group: 'basic' },
  { label: 'staging-server', os: 'Alpine', host: '127.0.0.1', port: 2202, username: 'testuser', password: 'testpass', hostname: 'staging-server', shell: 'ash', group: 'basic' },
  { label: 'dev-server', os: 'Alpine', host: '127.0.0.1', port: 2203, username: 'admin', password: 'adminpass', hostname: 'dev-server', shell: 'ash', group: 'basic' },
];

/** Multi-OS servers (docker-compose.multios.yml) */
export const MULTIOS_SERVERS: ChaosServerConfig[] = [
  { label: 'alpine-server', os: 'Alpine', host: '127.0.0.1', port: 2210, username: 'testuser', password: 'testpass', hostname: 'alpine-server', shell: 'ash', group: 'multios' },
  { label: 'ubuntu-server', os: 'Ubuntu', host: '127.0.0.1', port: 2211, username: 'testuser', password: 'testpass', hostname: 'ubuntu-server', shell: 'bash', group: 'multios' },
  { label: 'debian-server', os: 'Debian', host: '127.0.0.1', port: 2212, username: 'testuser', password: 'testpass', hostname: 'debian-server', shell: 'bash', group: 'multios' },
  { label: 'fedora-server', os: 'Fedora', host: '127.0.0.1', port: 2213, username: 'testuser', password: 'testpass', hostname: 'fedora-server', shell: 'bash', group: 'multios' },
  { label: 'rocky-server', os: 'Rocky', host: '127.0.0.1', port: 2214, username: 'testuser', password: 'testpass', hostname: 'rocky-server', shell: 'bash', group: 'multios' },
];

/** All servers used in chaos testing */
export const ALL_CHAOS_SERVERS: ChaosServerConfig[] = [...BASIC_SERVERS, ...MULTIOS_SERVERS];

// ---- Runtime Configuration ----

export interface ChaosRunConfig {
  mode: ChaosMode;
  seed: number;
  servers: ChaosServerConfig[];
  /** Max time per scenario in ms */
  scenarioTimeout: number;
  /** Quick: fewer variations per scenario; Deep: exhaustive */
  variationsPerScenario: number;
}

export function getRunConfig(): ChaosRunConfig {
  const mode: ChaosMode = (process.env.CHAOS_MODE as ChaosMode) || 'quick';
  const seed = process.env.CHAOS_SEED ? parseInt(process.env.CHAOS_SEED, 10) : Date.now();

  return {
    mode,
    seed,
    servers: ALL_CHAOS_SERVERS,
    scenarioTimeout: mode === 'quick' ? 30000 : 60000,
    variationsPerScenario: mode === 'quick' ? 3 : 10,
  };
}

// ---- Scenario Types ----

export interface StateEvent {
  timestamp: number;
  connectionId: string;
  type: 'state-change' | 'activity-change' | 'file-change';
  data: string;
}

export interface Anomaly {
  type: 'output_error' | 'activity_leak' | 'state_anomaly' | 'invariant_violation' | 'unexpected_error';
  channel?: string;
  server_os?: string;
  server_label?: string;
  message: string;
  timestamp?: number;
}

export interface ScenarioResult {
  name: string;
  server: string;
  server_os: string;
  passed: boolean;
  invariantViolations: string[];
  anomalies: Anomaly[];
  stateTimeline: StateEvent[];
  duration_ms: number;
  error?: string;
}

export interface ScenarioContext {
  server: ChaosServerConfig;
  testDir: string;
  seed: number;
  variation: number;
}

export type ScenarioFn = (ctx: ScenarioContext) => Promise<ScenarioResult>;

export interface ScenarioDefinition {
  name: string;
  category: string;
  fn: ScenarioFn;
}

// ---- Coverage Manifest Types ----

export interface CoverageManifest {
  [method: string]: string[];
}

// ---- Run Results ----

export interface PerOSSummary {
  run: number;
  passed: number;
  failed: number;
}

export interface ChaosRunResult {
  timestamp: string;
  mode: ChaosMode;
  seed: number;
  client_os: string;
  duration_ms: number;
  servers_tested: Array<{ label: string; os: string; port: number }>;
  scenarios_run: number;
  passed: number;
  failed: number;
  failures: Array<{
    scenario: string;
    server_os: string;
    server_label: string;
    error?: string;
    invariantViolations: string[];
  }>;
  per_os_summary: Record<string, PerOSSummary>;
  anomalies_detected: Anomaly[];
  coverage: {
    actions_exercised: string[];
    actions_missed: string[];
    methods_uncovered: string[];
    invariants_checked: number;
    invariants_violated: number;
  };
  output_summary: Record<string, { lines: number; errors: number }>;
}
