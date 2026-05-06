import { PERSONAS } from '../../chaos/catalog/personas';

describe('personas', () => {
  it('has 6 personas in v0.8.0 baseline', () => {
    expect(PERSONAS.length).toBe(6);
  });

  it('every persona has positive total weight', () => {
    for (const p of PERSONAS) {
      const total = Object.values(p.weights).reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(0);
    }
  });

  it('every persona has chainLengthRange [min,max] with 1<=min<=max<=10', () => {
    for (const p of PERSONAS) {
      const [min, max] = p.chainLengthRange;
      expect(min).toBeGreaterThanOrEqual(1);
      expect(min).toBeLessThanOrEqual(max);
      expect(max).toBeLessThanOrEqual(10);
    }
  });

  it('persona names are unique', () => {
    const names = PERSONAS.map(p => p.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
