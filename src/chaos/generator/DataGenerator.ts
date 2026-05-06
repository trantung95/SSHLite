import { SeededRandom } from '../chaos-helpers';

const WEIRD_NAME_PARTS = ['hello world', 'unicode-tag', 'a b c', 'name(1)', 'CRLF\r\n'];

export class DataGenerator {
  constructor(private rng: SeededRandom) {}

  randomPath(): string {
    const weird = this.rng.int(0, 99) < 8;
    const tag = this.rng.int(0, 0xffffff).toString(16);
    if (weird) {
      const part = WEIRD_NAME_PARTS[this.rng.int(0, WEIRD_NAME_PARTS.length - 1)];
      return `/tmp/chaos-${part}-${tag}`;
    }
    return `/tmp/chaos-${tag}`;
  }

  randomBytes(n: number): Buffer {
    return this.rng.bytes(n);
  }
}
