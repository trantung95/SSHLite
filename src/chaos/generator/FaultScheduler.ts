import { SeededRandom } from '../chaos-helpers';
import { FAULTS } from '../faults';
import { ScheduledFault } from '../ChaosTypes';

export class FaultScheduler {
  constructor(private rng: SeededRandom, private faultRate: number) {}

  maybePickFault(estimatedSessionMs = 5000): ScheduledFault | null {
    if (this.rng.next() >= this.faultRate) return null;

    const totalWeight = FAULTS.reduce((s, f) => s + f.weight, 0);
    const r = this.rng.int(0, totalWeight - 1);
    let acc = 0;
    let chosen = FAULTS[0];
    for (const f of FAULTS) {
      acc += f.weight;
      if (r < acc) { chosen = f; break; }
    }

    const lo = Math.floor(estimatedSessionMs * 0.2);
    const hi = Math.floor(estimatedSessionMs * 0.8);
    return {
      name: chosen.name,
      atMs: this.rng.int(lo, hi),
      params: chosen.generateParams(this.rng),
    };
  }
}
