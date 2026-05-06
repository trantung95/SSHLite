import { PrimitiveOp, GenContext } from '../../ChaosTypes';
import { SeededRandom } from '../../chaos-helpers';

function randomPath(rng: SeededRandom): string {
  const tag = rng.int(0, 0xffffff).toString(16);
  return `/tmp/chaos-${tag}`;
}

function pickKnownOrRandom(rng: SeededRandom, ctx: GenContext): string {
  if (ctx.knownPaths.length > 0 && rng.int(0, 99) < 70) {
    return ctx.knownPaths[rng.int(0, ctx.knownPaths.length - 1)];
  }
  return randomPath(rng);
}

function deterministicBytes(seed: number, len: number): Buffer {
  const rng = new SeededRandom(seed);
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) buf[i] = rng.int(0, 255);
  return buf;
}

export const filePrimitives: PrimitiveOp[] = [
  {
    name: 'writeFile',
    surface: 'sshOps',
    weight: 4,
    requiresConnected: true,
    generateParams: (rng) => ({
      path: randomPath(rng),
      bytesLen: rng.int(0, 4096),
      bytesSeed: rng.int(0, 0xffffff),
    }),
    async execute(conn, params) {
      const bytes = deterministicBytes(params.bytesSeed as number, params.bytesLen as number);
      await conn.writeFile(params.path as string, bytes);
    },
  },
  {
    name: 'readFile',
    surface: 'sshOps',
    weight: 4,
    requiresConnected: true,
    generateParams: (rng, ctx) => ({ path: pickKnownOrRandom(rng, ctx) }),
    async execute(conn, params) {
      try { await conn.readFile(params.path as string); } catch { /* may not exist */ }
    },
  },
  {
    name: 'listFiles',
    surface: 'sshOps',
    weight: 3,
    requiresConnected: true,
    generateParams: (rng) => ({ path: rng.int(0, 1) === 0 ? '/tmp' : '/etc' }),
    async execute(conn, params) {
      try { await conn.listFiles(params.path as string); } catch { /* ignore */ }
    },
  },
  {
    name: 'mkdir',
    surface: 'sshOps',
    weight: 2,
    requiresConnected: true,
    generateParams: (rng) => ({ path: randomPath(rng) }),
    async execute(conn, params) {
      try { await conn.mkdir(params.path as string); } catch { /* may exist */ }
    },
  },
  {
    name: 'rename',
    surface: 'sshOps',
    weight: 1,
    requiresConnected: true,
    generateParams: (rng, ctx) => ({
      from: pickKnownOrRandom(rng, ctx),
      to: randomPath(rng),
    }),
    async execute(conn, params) {
      try { await conn.rename(params.from as string, params.to as string); } catch { /* may not exist */ }
    },
  },
  {
    name: 'deleteFile',
    surface: 'sshOps',
    weight: 1,
    requiresConnected: true,
    generateParams: (rng, ctx) => ({ path: pickKnownOrRandom(rng, ctx) }),
    async execute(conn, params) {
      try { await conn.deleteFile(params.path as string); } catch { /* may not exist */ }
    },
  },
  {
    name: 'stat',
    surface: 'sshOps',
    weight: 2,
    requiresConnected: true,
    generateParams: (rng, ctx) => ({ path: pickKnownOrRandom(rng, ctx) }),
    async execute(conn, params) {
      try { await conn.stat(params.path as string); } catch { /* may not exist */ }
    },
  },
  {
    name: 'fileExists',
    surface: 'sshOps',
    weight: 2,
    requiresConnected: true,
    generateParams: (rng, ctx) => ({ path: pickKnownOrRandom(rng, ctx) }),
    async execute(conn, params) {
      await conn.fileExists(params.path as string);
    },
  },
];
