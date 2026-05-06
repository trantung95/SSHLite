import { DataGenerator } from '../../chaos/generator/DataGenerator';
import { TopologyChooser } from '../../chaos/generator/TopologyChooser';
import { ChainGenerator } from '../../chaos/generator/ChainGenerator';
import { FaultScheduler } from '../../chaos/generator/FaultScheduler';
import { SessionGenerator } from '../../chaos/generator/SessionGenerator';
import { SeededRandom } from '../../chaos/chaos-helpers';
import { Action, Persona } from '../../chaos/ChaosTypes';

const ACTIONS: Action[] = [
  { name: 'Edit a file', primitives: ['readFile', 'writeFile'], source: 'features/test.md' },
  { name: 'Browse files', primitives: ['listFiles', 'stat'], source: 'features/test.md' },
];
const EDITOR: Persona = { name: 'editor', weights: { 'Edit a file': 5, 'Browse files': 1 }, chainLengthRange: [3, 5] };

const SERVERS: any[] = [
  { label: 's1', os: 'Alpine', host: '127.0.0.1', port: 2201, username: 'u', password: 'p', hostname: 's1', shell: 'ash', group: 'basic', container: 'c1' },
  { label: 's2', os: 'Alpine', host: '127.0.0.1', port: 2202, username: 'u', password: 'p', hostname: 's2', shell: 'ash', group: 'basic', container: 'c2' },
];

describe('DataGenerator', () => {
  it('produces deterministic random paths for same seed', () => {
    const a = new DataGenerator(new SeededRandom(42));
    const b = new DataGenerator(new SeededRandom(42));
    for (let i = 0; i < 10; i++) {
      expect(a.randomPath()).toBe(b.randomPath());
    }
  });

  it('produces deterministic random bytes', () => {
    const a = new DataGenerator(new SeededRandom(7));
    const b = new DataGenerator(new SeededRandom(7));
    expect(a.randomBytes(64).equals(b.randomBytes(64))).toBe(true);
  });
});

describe('TopologyChooser', () => {
  const W = { A: 0.50, B: 0.25, C: 0.17, D: 0.08 };
  it('returns a valid topology', () => {
    const c = new TopologyChooser(new SeededRandom(0), W);
    expect(['A', 'B', 'C', 'D']).toContain(c.pick());
  });
  it('matches weight distribution within 5pp over 5000 trials', () => {
    const counts: Record<string, number> = { A: 0, B: 0, C: 0, D: 0 };
    for (let i = 0; i < 5000; i++) {
      const c = new TopologyChooser(new SeededRandom(i + 1), W);
      counts[c.pick()]++;
    }
    expect(Math.abs(counts.A / 5000 - 0.50)).toBeLessThan(0.05);
    expect(Math.abs(counts.B / 5000 - 0.25)).toBeLessThan(0.05);
    expect(Math.abs(counts.C / 5000 - 0.17)).toBeLessThan(0.05);
    expect(Math.abs(counts.D / 5000 - 0.08)).toBeLessThan(0.05);
  });
});

describe('ChainGenerator', () => {
  it('generates a chain with persona, actions, and ops', () => {
    const g = new ChainGenerator(new SeededRandom(1), ACTIONS);
    const chain = g.generate(EDITOR);
    expect(chain.persona).toBe('editor');
    expect(chain.ops.length).toBeGreaterThan(0);
    // Engine owns the shared connection lifecycle; chains do not auto-prepend
    // connect or auto-append disconnect.
    for (const op of chain.ops) {
      expect(['readFile', 'writeFile', 'listFiles', 'stat']).toContain(op.primitive);
    }
  });
  it('drops weights for unknown actions', () => {
    const personaWithStrayAction: Persona = {
      name: 'x',
      weights: { 'Edit a file': 1, 'Nonexistent': 100 },
      chainLengthRange: [2, 3],
    };
    const g = new ChainGenerator(new SeededRandom(1), ACTIONS);
    const chain = g.generate(personaWithStrayAction);
    for (const a of chain.actions) expect(['Edit a file']).toContain(a);
  });
  it('is deterministic for same seed', () => {
    const a = new ChainGenerator(new SeededRandom(99), ACTIONS).generate(EDITOR);
    const b = new ChainGenerator(new SeededRandom(99), ACTIONS).generate(EDITOR);
    expect(a).toEqual(b);
  });
});

describe('FaultScheduler', () => {
  it('respects fault rate within 5pp over 5000 trials', () => {
    const RATE = 0.30;
    let withFault = 0;
    for (let i = 0; i < 5000; i++) {
      const s = new FaultScheduler(new SeededRandom(i + 1), RATE);
      if (s.maybePickFault()) withFault++;
    }
    expect(Math.abs(withFault / 5000 - RATE)).toBeLessThan(0.05);
  });
  it('returns a fault with name + atMs + params when picked', () => {
    const s = new FaultScheduler(new SeededRandom(7), 1.0);
    const f = s.maybePickFault()!;
    expect(typeof f.name).toBe('string');
    expect(f.atMs).toBeGreaterThanOrEqual(50);
    expect(f.atMs).toBeLessThanOrEqual(500);
  });
});

describe('SessionGenerator', () => {
  it('topology A produces 1 perServerSession', () => {
    const g = new SessionGenerator({
      servers: SERVERS,
      actions: ACTIONS,
      faultRate: 0,
      topologyWeights: { A: 1, B: 0, C: 0, D: 0 },
      chainsPerServerRange: [1, 1],
      fanoutServerRange: [2, 2],
      fanInUserRange: [2, 2],
    });
    const s = g.generate(new SeededRandom(0), 0);
    expect(s.topology).toBe('A');
    expect(s.perServerSessions.length).toBe(1);
  });

  it('topology B produces 2-N perServerSessions', () => {
    const g = new SessionGenerator({
      servers: SERVERS,
      actions: ACTIONS,
      faultRate: 0,
      topologyWeights: { A: 0, B: 1, C: 0, D: 0 },
      chainsPerServerRange: [1, 1],
      fanoutServerRange: [2, 2],
      fanInUserRange: [2, 2],
    });
    const s = g.generate(new SeededRandom(0), 0);
    expect(s.topology).toBe('B');
    expect(s.perServerSessions.length).toBe(2);
  });

  it('is deterministic for same seed', () => {
    const opts = {
      servers: SERVERS,
      actions: ACTIONS,
      faultRate: 0.5,
      topologyWeights: { A: 0.5, B: 0.5, C: 0, D: 0 },
      chainsPerServerRange: [1, 2] as [number, number],
      fanoutServerRange: [2, 2] as [number, number],
      fanInUserRange: [2, 2] as [number, number],
    };
    const a = new SessionGenerator(opts).generate(new SeededRandom(7), 7);
    const b = new SessionGenerator(opts).generate(new SeededRandom(7), 7);
    expect(a).toEqual(b);
  });
});
