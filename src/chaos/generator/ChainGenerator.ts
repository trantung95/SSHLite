import { SeededRandom } from '../chaos-helpers';
import { Action, Chain, ChainOp, GenContext, Persona } from '../ChaosTypes';
import { primitiveByName } from '../primitives';

export class ChainGenerator {
  constructor(private rng: SeededRandom, private actions: Action[]) {}

  generate(persona: Persona): Chain {
    const known = new Map(this.actions.map(a => [a.name, a]));
    const usable = Object.entries(persona.weights)
      .filter(([name]) => known.has(name))
      .map(([name, weight]) => ({ name, weight }));

    if (usable.length === 0) {
      return { persona: persona.name, startDelayMs: 0, actions: [], ops: [] };
    }

    const totalWeight = usable.reduce((s, e) => s + e.weight, 0);
    const length = this.rng.int(persona.chainLengthRange[0], persona.chainLengthRange[1]);
    const ctx: GenContext = { knownPaths: [], connected: false };
    const chosenActions: string[] = [];
    const ops: ChainOp[] = [];

    // Begin with connect to ground the chain.
    ops.push({ primitive: 'connect', params: {} });
    ctx.connected = true;

    for (let i = 0; i < length; i++) {
      const action = this.drawAction(usable, totalWeight);
      chosenActions.push(action.name);
      const def = known.get(action.name)!;
      for (const primName of def.primitives) {
        const prim = primitiveByName(primName);
        if (!prim) continue;
        if (prim.requiresConnected && !ctx.connected) continue;
        const params = prim.generateParams(this.rng, ctx);
        ops.push({ primitive: primName, params });
        if (primName === 'writeFile' && typeof params.path === 'string') ctx.knownPaths.push(params.path);
        if (primName === 'mkdir' && typeof params.path === 'string') ctx.knownPaths.push(params.path);
        if (primName === 'disconnect' || primName === 'dispose') ctx.connected = false;
      }
    }

    if (ctx.connected) {
      ops.push({ primitive: 'disconnect', params: {} });
    }

    return {
      persona: persona.name,
      startDelayMs: this.rng.int(0, 500),
      actions: chosenActions,
      ops,
    };
  }

  private drawAction(weighted: { name: string; weight: number }[], total: number): { name: string; weight: number } {
    const r = this.rng.int(0, total - 1);
    let acc = 0;
    for (const w of weighted) {
      acc += w.weight;
      if (r < acc) return w;
    }
    return weighted[0];
  }
}
