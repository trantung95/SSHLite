import { PrimitiveOp, GenContext } from '../../ChaosTypes';
import { FileService } from '../../../services/FileService';
import { SeededRandom } from '../../chaos-helpers';

/**
 * Primitive that exercises the FileService.openRemoteFile path — the missing
 * surface that allowed the click-during-search regression to slip past chaos.
 * openRemoteFile triggers `startFileWatch`, which on servers without
 * inotifywait/fswatch falls back to a 1 Hz `refreshSingleFile` poll loop. If
 * that loop ever re-introduces background readFile traffic on unchanged
 * files, the `backgroundIdle` invariant will catch it.
 */

function randomPath(rng: SeededRandom): string {
  const tag = rng.int(0, 0xffffff).toString(16);
  return `/tmp/chaos-${tag}`;
}

function pickKnownOrRandom(rng: SeededRandom, ctx: GenContext): string {
  if (ctx.knownPaths.length > 0 && rng.int(0, 99) < 80) {
    return ctx.knownPaths[rng.int(0, ctx.knownPaths.length - 1)];
  }
  return randomPath(rng);
}

export const fileServiceOps: PrimitiveOp[] = [
  {
    name: 'openRemoteFile',
    surface: 'serviceOps',
    weight: 2,
    requiresConnected: true,
    generateParams: (rng, ctx) => ({ path: pickKnownOrRandom(rng, ctx) }),
    async execute(conn, params) {
      const remotePath = params.path as string;
      const remoteFile = {
        name: remotePath.split('/').pop() || remotePath,
        path: remotePath,
        isDirectory: false,
        size: 0,
        modifiedTime: Date.now(),
        connectionId: conn.id,
      };
      try {
        await FileService.getInstance().openRemoteFile(conn, remoteFile);
      } catch {
        // The path may not exist on the server, or VS Code mocks may reject
        // the showTextDocument call; either way the primitive should swallow
        // the error so the chain can continue. The invariant catches the
        // failure mode we actually care about (background readFile leaks).
      }
    },
  },
];
