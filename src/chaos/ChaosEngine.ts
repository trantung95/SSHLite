/**
 * Chaos Engine - session orchestrator
 *
 * Generates random user-like sessions across multiple topologies, runs
 * concurrent chains against real Docker SSH containers, injects real
 * environment-level faults at random offsets, checks universal invariants
 * around every primitive op, and writes replay-grade JSONL.
 */

import * as path from 'path';
import { randomUUID } from 'crypto';
import { ChaosRunConfig, ChaosServerConfig } from './ChaosConfig';
import {
  Session, RunResult, Snapshot, Violation, Chain,
  ScheduledFault,
} from './ChaosTypes';
import { ChaosLogger } from './ChaosLogger';
import { SessionGenerator } from './generator/SessionGenerator';
import { loadCatalog } from './catalog/loader';
import { primitiveByName } from './primitives';
import { faultByName } from './faults';
import { INVARIANTS_AFTER_OP, INVARIANTS_AFTER_SESSION } from './invariants';
import { createChaosConnection, safeChaosDisconnect, SeededRandom } from './chaos-helpers';
import { SSHConnection } from '../connection/SSHConnection';

export class ChaosEngine {
  private logger: ChaosLogger;
  private sessionGen: SessionGenerator;

  constructor(private config: ChaosRunConfig) {
    this.logger = new ChaosLogger(path.resolve(__dirname, '../../logs/chaos-results.jsonl'));
    const repoRoot = path.resolve(__dirname, '../..');
    const catalog = loadCatalog(repoRoot);
    this.sessionGen = new SessionGenerator({
      servers: config.servers,
      actions: catalog.actions,
      faultRate: config.faultRate,
      topologyWeights: config.topologyWeights,
      chainsPerServerRange: config.chainsPerServerRange,
      fanoutServerRange: config.fanoutServerRange,
      fanInUserRange: config.fanInUserRange,
    });
  }

  async run(): Promise<RunResult[]> {
    const results: RunResult[] = [];
    const startedAt = Date.now();
    let i = 0;
    while (Date.now() - startedAt < this.config.globalBudgetMs) {
      const seed = this.config.seed + i++;
      const session = this.sessionGen.generate(new SeededRandom(seed), seed);
      const result = await this.executeSession(seed, session);
      this.logger.write(result);
      results.push(result);
    }
    return results;
  }

  private async executeSession(seed: number, session: Session): Promise<RunResult> {
    const startedAt = Date.now();
    const exercised = new Set<string>();
    const actionsUsed = new Set<string>();
    const faultsInjected: string[] = [];
    let invariantChecks = 0;
    const violations: Violation[] = [];
    let outcome: RunResult['outcome'] = 'passed';

    try {
      await Promise.all(session.perServerSessions.map(async (pss) => {
        const serverCfg = this.config.servers.find(s => s.label === pss.server.label);
        if (!serverCfg) return;

        let conn: SSHConnection | null = null;
        try {
          conn = await createChaosConnection(serverCfg);
        } catch (err) {
          violations.push({
            invariant: 'connect',
            detail: `failed to connect to ${pss.server.label}: ${(err as Error).message}`,
          });
          return;
        }

        const sessionStartSnapshots = new Map<string, Snapshot>();
        for (const inv of INVARIANTS_AFTER_SESSION) {
          sessionStartSnapshots.set(inv.name, await inv.snapshot(conn));
        }

        let faultTimer: NodeJS.Timeout | undefined;
        let injected = false;
        if (pss.fault) {
          const f = faultByName(pss.fault.name);
          if (f) {
            faultTimer = setTimeout(async () => {
              try {
                await f.inject(serverCfg, pss.fault!.params);
                injected = true;
                faultsInjected.push(f.name);
              } catch {
                // best-effort; failure logged but session continues
              }
            }, pss.fault.atMs);
          }
        }

        try {
          await Promise.all(
            pss.chains.map((c, idx) =>
              this.runChain(conn!, c, idx, exercised, actionsUsed, violations, () => invariantChecks++, pss.server.label)
            )
          );
        } finally {
          if (faultTimer) clearTimeout(faultTimer);
          if (pss.fault && injected) {
            const f = faultByName(pss.fault.name);
            if (f) {
              try { await f.recover(serverCfg, pss.fault.params); } catch { /* best-effort */ }
              (pss.fault as ScheduledFault).recoveredAtMs = Date.now() - startedAt;
            }
          }

          for (const inv of INVARIANTS_AFTER_SESSION) {
            const before = sessionStartSnapshots.get(inv.name)!;
            try {
              const after = await inv.snapshot(conn);
              invariantChecks++;
              for (const v of inv.check(before, after)) violations.push(v);
            } catch { /* invariant snapshot failure is non-fatal */ }
          }

          await safeChaosDisconnect(conn);
        }
      }));
    } catch (err) {
      outcome = { exception: (err as Error).message };
    }

    if (outcome === 'passed' && violations.length > 0) {
      const v = violations[0];
      outcome = { violation: v.invariant, chain: 0, opIndex: 0, detail: v.detail };
    }

    return {
      run_id: randomUUID(),
      timestamp: new Date().toISOString(),
      seed,
      mode: this.config.mode,
      topology: session.topology,
      perServerSessions: session.perServerSessions,
      outcome,
      duration_ms: Date.now() - startedAt,
      primitives_exercised: Array.from(exercised),
      actions_used: Array.from(actionsUsed),
      faults_injected: faultsInjected,
      invariant_checks: invariantChecks,
      invariant_violations: violations,
    };
  }

  private async runChain(
    conn: SSHConnection,
    chain: Chain,
    chainIdx: number,
    exercised: Set<string>,
    actionsUsed: Set<string>,
    violations: Violation[],
    bumpChecks: () => void,
    serverLabel: string,
  ): Promise<void> {
    if (chain.startDelayMs > 0) await new Promise(r => setTimeout(r, chain.startDelayMs));
    for (const a of chain.actions) actionsUsed.add(a);

    for (let opIdx = 0; opIdx < chain.ops.length; opIdx++) {
      const op = chain.ops[opIdx];
      const prim = primitiveByName(op.primitive);
      if (!prim) continue;

      const before = new Map<string, Snapshot>();
      for (const inv of INVARIANTS_AFTER_OP) {
        try { before.set(inv.name, await inv.snapshot(conn)); } catch { /* skip */ }
      }

      try {
        if (prim.longRunning) {
          prim.execute(conn, op.params).catch(() => { /* fire-and-forget */ });
        } else {
          await prim.execute(conn, op.params);
        }
      } catch { /* per-op error: chain continues */ }

      exercised.add(op.primitive);

      for (const inv of INVARIANTS_AFTER_OP) {
        const beforeSnap = before.get(inv.name);
        if (!beforeSnap) continue;
        try {
          const after = await inv.snapshot(conn);
          bumpChecks();
          for (const v of inv.check(beforeSnap, after)) {
            violations.push({ ...v, detail: `${v.detail} [chain=${chainIdx} op=${opIdx} server=${serverLabel}]` });
          }
        } catch { /* skip */ }
      }
    }
  }
}
