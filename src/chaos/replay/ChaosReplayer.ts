/**
 * Chaos Replayer
 *
 * Loads a recorded {seed, session} from logs/chaos-results.jsonl and
 * re-executes it deterministically. The replayer skips the generator and
 * walks the recorded ops directly, honouring start delays and fault timing.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RunResult, Chain } from '../ChaosTypes';
import { primitiveByName } from '../primitives';
import { faultByName } from '../faults';
import { createChaosConnection, safeChaosDisconnect } from '../chaos-helpers';
import { ALL_CHAOS_SERVERS } from '../ChaosConfig';
import { SSHConnection } from '../../connection/SSHConnection';

export function findRunInJsonl(jsonlContent: string, runId: string): RunResult | null {
  for (const line of jsonlContent.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.run_id === runId) return obj;
    } catch { /* skip malformed lines */ }
  }
  return null;
}

export async function replayRun(run: RunResult): Promise<void> {
  const startedAt = Date.now();
  console.log(`[replay] run_id=${run.run_id} seed=${run.seed} topology=${run.topology}`);

  await Promise.all(run.perServerSessions.map(async (pss) => {
    const cfg = ALL_CHAOS_SERVERS.find(s => s.label === pss.server.label);
    if (!cfg) {
      console.warn(`[replay] unknown server label: ${pss.server.label}`);
      return;
    }

    let conn: SSHConnection | null = null;
    try {
      conn = await createChaosConnection(cfg);
    } catch (err) {
      console.error(`[replay] connect failed for ${pss.server.label}: ${(err as Error).message}`);
      return;
    }

    let faultTimer: NodeJS.Timeout | undefined;
    let injected = false;
    if (pss.fault) {
      const f = faultByName(pss.fault.name);
      if (f) {
        const remaining = pss.fault.atMs - (Date.now() - startedAt);
        faultTimer = setTimeout(async () => {
          try { await f.inject(cfg, pss.fault!.params); injected = true; } catch { /* swallow */ }
        }, Math.max(0, remaining));
      }
    }

    try {
      await Promise.all(pss.chains.map(c => replayChain(conn!, c)));
    } finally {
      if (faultTimer) clearTimeout(faultTimer);
      if (pss.fault && injected) {
        const f = faultByName(pss.fault.name);
        if (f) { try { await f.recover(cfg, pss.fault.params); } catch { /* swallow */ } }
      }
      await safeChaosDisconnect(conn);
    }
  }));

  console.log(`[replay] done run_id=${run.run_id} duration_ms=${Date.now() - startedAt}`);
}

async function replayChain(conn: SSHConnection, chain: Chain): Promise<void> {
  if (chain.startDelayMs > 0) await new Promise(r => setTimeout(r, chain.startDelayMs));
  for (const op of chain.ops) {
    const prim = primitiveByName(op.primitive);
    if (!prim) continue;
    try {
      if (prim.longRunning) prim.execute(conn, op.params).catch(() => {});
      else await prim.execute(conn, op.params);
    } catch { /* swallow */ }
  }
}

export async function replayFromArg(arg: string): Promise<void> {
  let run: RunResult | null = null;
  try {
    run = JSON.parse(arg);
    if (run && typeof (run as RunResult).run_id === 'string') {
      await replayRun(run!);
      return;
    }
  } catch { /* not JSON; treat as run_id */ }

  const logsPath = path.resolve(__dirname, '../../../logs/chaos-results.jsonl');
  if (!fs.existsSync(logsPath)) throw new Error(`Logs file not found: ${logsPath}`);
  const content = fs.readFileSync(logsPath, 'utf8');
  const found = findRunInJsonl(content, arg);
  if (!found) throw new Error(`No run found for id "${arg}" in ${logsPath}`);
  await replayRun(found);
}
