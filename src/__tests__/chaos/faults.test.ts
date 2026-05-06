import { FAULTS, faultByName } from '../../chaos/faults';
import { SeededRandom } from '../../chaos/chaos-helpers';

describe('faults registry', () => {
  it('has 4 faults in v0.8.0 baseline', () => {
    expect(FAULTS.length).toBe(4);
  });

  it('every fault has a unique name', () => {
    const names = FAULTS.map(f => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('every fault generates JSON-serialisable params from a seeded RNG', () => {
    for (const f of FAULTS) {
      const params = f.generateParams(new SeededRandom(0));
      expect(JSON.parse(JSON.stringify(params))).toEqual(params);
    }
  });

  it('faultByName resolves known and returns undefined for unknown', () => {
    expect(faultByName('dockerPause')).toBeDefined();
    expect(faultByName('not-a-fault')).toBeUndefined();
  });

  it('netem declares NET_ADMIN cap requirement', () => {
    expect(faultByName('netem')!.requiresCaps).toContain('NET_ADMIN');
  });
});
