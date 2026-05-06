import { SeededRandom } from '../chaos-helpers';
import { Action, Session, Topology, PerServerSession } from '../ChaosTypes';
import { ChaosServerConfig } from '../ChaosConfig';
import { TopologyChooser } from './TopologyChooser';
import { ChainGenerator } from './ChainGenerator';
import { FaultScheduler } from './FaultScheduler';
import { PERSONAS } from '../catalog/personas';

export interface SessionGenOptions {
  servers: ChaosServerConfig[];
  actions: Action[];
  faultRate: number;
  topologyWeights: Record<Topology, number>;
  chainsPerServerRange: [number, number];
  fanoutServerRange: [number, number];
  fanInUserRange: [number, number];
}

export class SessionGenerator {
  constructor(private opts: SessionGenOptions) {}

  generate(rng: SeededRandom, recordedSeed: number): Session {
    const topology = new TopologyChooser(rng, this.opts.topologyWeights).pick();
    const targets = this.pickServers(rng, topology);
    const perServerSessions: PerServerSession[] = [];
    const chainGen = new ChainGenerator(rng, this.opts.actions);
    const faultSched = new FaultScheduler(rng, this.opts.faultRate);

    for (const server of targets) {
      const k = rng.int(this.opts.chainsPerServerRange[0], this.opts.chainsPerServerRange[1]);
      const chains = [];
      for (let i = 0; i < k; i++) {
        const persona = PERSONAS[rng.int(0, PERSONAS.length - 1)];
        chains.push(chainGen.generate(persona));
      }
      perServerSessions.push({
        server: { label: server.label, os: server.os, port: server.port },
        chains,
        fault: faultSched.maybePickFault(),
      });
    }

    return {
      seed: recordedSeed,
      topology,
      perServerSessions,
    };
  }

  private pickServers(rng: SeededRandom, topology: Topology): ChaosServerConfig[] {
    const all = this.opts.servers;
    if (all.length === 0) return [];
    if (topology === 'A' || topology === 'C') {
      return [all[rng.int(0, all.length - 1)]];
    }
    const min = Math.min(this.opts.fanoutServerRange[0], all.length);
    const max = Math.min(this.opts.fanoutServerRange[1], all.length);
    const n = rng.int(min, max);
    const indices = rng.shuffle(all.map((_, i) => i));
    return indices.slice(0, n).map(i => all[i]);
  }
}
