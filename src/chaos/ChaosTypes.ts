/**
 * Chaos Engine - shared types
 *
 * Central type module used by every part of the chaos engine: primitives,
 * personas, faults, invariants, generator, engine, logger, replayer.
 */

import { SSHConnection } from '../connection/SSHConnection';
import { SeededRandom } from './chaos-helpers';
import { ChaosServerConfig } from './ChaosConfig';

export type Topology = 'A' | 'B' | 'C' | 'D';
export type ChaosMode = 'quick' | 'deep';

export type PrimitiveSurface =
  | 'sshOps'
  | 'vscodeCommands'
  | 'treeOps'
  | 'hoverOps'
  | 'decorationOps'
  | 'serviceOps'
  | 'backgroundOps';

export interface ChainOp {
  primitive: string;
  params: Record<string, unknown>;
}

/** State the generator carries forward through a chain so primitive draws can be context-aware. */
export interface GenContext {
  /** Paths the generator believes were created during this chain. */
  knownPaths: string[];
  /** Whether the connection is currently live. */
  connected: boolean;
}

export interface PrimitiveOp {
  name: string;
  surface: PrimitiveSurface;
  /** Generator draw weight (relative). */
  weight: number;
  /** If true, the generator will skip this op when ctx.connected is false. */
  requiresConnected: boolean;
  /** If true, the engine fires the op and the chain advances immediately. */
  longRunning?: boolean;
  /** Returns JSON-serialisable params from the seeded RNG and current context. */
  generateParams(rng: SeededRandom, ctx: GenContext): Record<string, unknown>;
  /** Run the op against a live SSH connection. Throws on hard failure; should swallow expected errors. */
  execute(conn: SSHConnection, params: Record<string, unknown>): Promise<void>;
}

export interface Action {
  name: string;
  primitives: string[];
  /** When true, the chain generator may permute the primitive order within this action. */
  unordered?: boolean;
  /** The .adn file path the action was extracted from (e.g. "features/file-operations.md"). */
  source: string;
}

export interface Persona {
  name: string;
  /** Action name -> relative weight; missing entry = 0. */
  weights: Record<string, number>;
  chainLengthRange: [number, number];
}

export interface Fault {
  name: string;
  weight: number;
  /** If set, the fault is skipped when the container does not advertise these caps. */
  requiresCaps?: string[];
  inject(server: ChaosServerConfig, params: Record<string, unknown>): Promise<void>;
  recover(server: ChaosServerConfig, params: Record<string, unknown>): Promise<void>;
  generateParams(rng: SeededRandom): Record<string, unknown>;
}

export interface Snapshot {
  timestamp: number;
  data: Record<string, unknown>;
}

export interface Violation {
  invariant: string;
  detail: string;
  before?: Snapshot;
  after?: Snapshot;
}

export interface Invariant {
  name: string;
  whenToCheck: 'after-each-op' | 'after-session' | 'both';
  snapshot(conn: SSHConnection): Promise<Snapshot>;
  check(before: Snapshot, after: Snapshot): Violation[];
}

export interface Chain {
  persona: string;
  startDelayMs: number;
  actions: string[];
  ops: ChainOp[];
}

export interface PerServerSession {
  server: { label: string; os: string; port: number };
  chains: Chain[];
  fault: ScheduledFault | null;
}

export interface ScheduledFault {
  name: string;
  atMs: number;
  params: Record<string, unknown>;
  recoveredAtMs?: number;
}

export interface Session {
  seed: number;
  topology: Topology;
  perServerSessions: PerServerSession[];
}

export type RunOutcome =
  | 'passed'
  | { violation: string; chain: number; opIndex: number; detail: string; serverLabel?: string }
  | { exception: string };

export interface RunResult {
  run_id: string;
  timestamp: string;
  seed: number;
  mode: ChaosMode;
  topology: Topology;
  perServerSessions: PerServerSession[];
  outcome: RunOutcome;
  duration_ms: number;
  primitives_exercised: string[];
  actions_used: string[];
  faults_injected: string[];
  invariant_checks: number;
  invariant_violations: Violation[];
}
