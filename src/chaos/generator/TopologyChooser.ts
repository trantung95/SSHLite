import { SeededRandom } from '../chaos-helpers';
import { Topology } from '../ChaosTypes';

export class TopologyChooser {
  constructor(private rng: SeededRandom, private weights: Record<Topology, number>) {}

  pick(): Topology {
    const r = this.rng.next();
    let acc = 0;
    for (const t of ['A', 'B', 'C', 'D'] as Topology[]) {
      acc += this.weights[t];
      if (r < acc) return t;
    }
    return 'A';
  }
}
