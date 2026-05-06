import { SeededRandom } from '../chaos-helpers';
import { FAULTS } from '../faults';
import { ScheduledFault } from '../ChaosTypes';

export class FaultScheduler {
  constructor(private rng: SeededRandom, private faultRate: number) {}

  maybePickFault(_estimatedSessionMs = 2000): ScheduledFault | null {
    if (this.rng.next() >= this.faultRate) return null;

    const totalWeight = FAULTS.reduce((s, f) => s + f.weight, 0);
    const r = this.rng.int(0, totalWeight - 1);
    let acc = 0;
    let chosen = FAULTS[0];
    for (const f of FAULTS) {
      acc += f.weight;
      if (r < acc) { chosen = f; break; }
    }

    // Fire faults early in the session (50-500 ms). Typical sessions complete
    // in ~1.5-2.5 s, so fault timers scheduled later are likely to be cancelled
    // by session completion before they fire. Early injection ensures faults
    // actually disturb chain execution rather than being a no-op.
    return {
      name: chosen.name,
      atMs: this.rng.int(50, 500),
      params: chosen.generateParams(this.rng),
    };
  }
}
