import { PRIMITIVES, primitiveByName, PRIMITIVE_NAMES } from '../../chaos/primitives';
import { SeededRandom } from '../../chaos/chaos-helpers';

describe('primitive registry', () => {
  it('has unique primitive names', () => {
    const names = PRIMITIVES.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('primitiveByName resolves a known primitive', () => {
    expect(primitiveByName('connect')).toBeDefined();
    expect(primitiveByName('writeFile')).toBeDefined();
    expect(primitiveByName('saveCredential')).toBeDefined();
  });

  it('primitiveByName returns undefined for unknown', () => {
    expect(primitiveByName('definitely-not-a-primitive')).toBeUndefined();
  });

  it('PRIMITIVE_NAMES exposes the same set', () => {
    expect(PRIMITIVE_NAMES.size).toBe(PRIMITIVES.length);
    expect(PRIMITIVE_NAMES.has('connect')).toBe(true);
  });

  it('registry covers ssh and service surfaces', () => {
    const surfaces = new Set(PRIMITIVES.map(p => p.surface));
    expect(surfaces.has('sshOps')).toBe(true);
    expect(surfaces.has('serviceOps')).toBe(true);
  });

  it('every primitive returns serialisable params from a seeded RNG', () => {
    const ctx = { knownPaths: ['/tmp/chaos-known'], connected: true };
    for (const p of PRIMITIVES) {
      const params = p.generateParams(new SeededRandom(42), ctx);
      expect(JSON.parse(JSON.stringify(params))).toEqual(params);
    }
  });

  it('contains the expected v0.8.0 baseline ops', () => {
    const expected = ['connect', 'disconnect', 'dispose', 'runShort', 'runLong', 'runFailing', 'shell',
      'writeFile', 'readFile', 'listFiles', 'mkdir', 'rename', 'deleteFile', 'stat', 'fileExists',
      'saveCredential', 'retrieveCredential', 'deleteCredential'];
    for (const name of expected) {
      expect(primitiveByName(name)).toBeDefined();
    }
  });
});
