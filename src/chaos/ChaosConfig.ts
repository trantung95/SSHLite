/**
 * Chaos Engine - Run Configuration
 *
 * Modes, budgets, fault rates, topology distribution, server set.
 */

import { ChaosMode, Topology } from './ChaosTypes';

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
  /** Container name for fault injection (docker pause / pkill etc.). */
  container: string;
}

/** Basic Alpine servers (docker-compose.yml). */
export const BASIC_SERVERS: ChaosServerConfig[] = [
  { label: 'prod-server', os: 'Alpine', host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass', hostname: 'prod-server', shell: 'ash', group: 'basic', container: 'sshlite-test-server-1' },
  { label: 'staging-server', os: 'Alpine', host: '127.0.0.1', port: 2202, username: 'testuser', password: 'testpass', hostname: 'staging-server', shell: 'ash', group: 'basic', container: 'sshlite-test-server-2' },
  { label: 'dev-server', os: 'Alpine', host: '127.0.0.1', port: 2203, username: 'admin', password: 'adminpass', hostname: 'dev-server', shell: 'ash', group: 'basic', container: 'sshlite-test-server-3' },
];

/** Multi-OS servers (docker-compose.multios.yml). */
export const MULTIOS_SERVERS: ChaosServerConfig[] = [
  { label: 'alpine-server', os: 'Alpine', host: '127.0.0.1', port: 2210, username: 'testuser', password: 'testpass', hostname: 'alpine-server', shell: 'ash', group: 'multios', container: 'sshlite-os-alpine' },
  { label: 'ubuntu-server', os: 'Ubuntu', host: '127.0.0.1', port: 2211, username: 'testuser', password: 'testpass', hostname: 'ubuntu-server', shell: 'bash', group: 'multios', container: 'sshlite-os-ubuntu' },
  { label: 'debian-server', os: 'Debian', host: '127.0.0.1', port: 2212, username: 'testuser', password: 'testpass', hostname: 'debian-server', shell: 'bash', group: 'multios', container: 'sshlite-os-debian' },
  { label: 'fedora-server', os: 'Fedora', host: '127.0.0.1', port: 2213, username: 'testuser', password: 'testpass', hostname: 'fedora-server', shell: 'bash', group: 'multios', container: 'sshlite-os-fedora' },
  { label: 'rocky-server', os: 'Rocky', host: '127.0.0.1', port: 2214, username: 'testuser', password: 'testpass', hostname: 'rocky-server', shell: 'bash', group: 'multios', container: 'sshlite-os-rocky' },
];

/** All servers used in chaos testing. */
export const ALL_CHAOS_SERVERS: ChaosServerConfig[] = [...BASIC_SERVERS, ...MULTIOS_SERVERS];

// ---- Run Configuration ----

export interface ChaosRunConfig {
  mode: ChaosMode;
  seed: number;
  servers: ChaosServerConfig[];
  /** Wall-clock budget across all sessions. */
  globalBudgetMs: number;
  /** Per-session timeout. */
  sessionTimeoutMs: number;
  /** P(session has a fault). */
  faultRate: number;
  /** Topology weight distribution. Sums to 1.0. */
  topologyWeights: Record<Topology, number>;
  /** Chains per per-server session (uniform draw within range). */
  chainsPerServerRange: [number, number];
  /** Servers per session for topology B (fan-out). */
  fanoutServerRange: [number, number];
  /** Users per session for topology C (fan-in). */
  fanInUserRange: [number, number];
}

export function getRunConfig(): ChaosRunConfig {
  const mode: ChaosMode = (process.env.CHAOS_MODE as ChaosMode) || 'quick';
  const seed = process.env.CHAOS_SEED ? parseInt(process.env.CHAOS_SEED, 10) : Date.now();
  const isQuick = mode === 'quick';
  return {
    mode,
    seed,
    servers: ALL_CHAOS_SERVERS,
    globalBudgetMs: isQuick ? 300000 : 780000,
    // Per-session hard cap. Disruptive faults (sshdSignal, dockerPause) freeze
    // chains; without a cap, each such session would consume the full chain
    // timeout. Short caps (10s quick, 20s deep) keep budget productive.
    sessionTimeoutMs: isQuick ? 10000 : 20000,
    faultRate: isQuick ? 0.30 : 0.70,
    topologyWeights: isQuick
      ? { A: 0.60, B: 0.25, C: 0.12, D: 0.03 }
      : { A: 0.50, B: 0.25, C: 0.17, D: 0.08 },
    chainsPerServerRange: [1, 4],
    fanoutServerRange: [2, 4],
    fanInUserRange: [3, 6],
  };
}
