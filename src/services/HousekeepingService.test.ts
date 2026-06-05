import * as path from 'path';
import { HousekeepingService, HousekeepingFsApi, SweepRule } from './HousekeepingService';

const DIR = path.join('/tmp');

function makeFs(children: Record<string, { mtimeMs: number; isDir: boolean }>): HousekeepingFsApi & {
  rmSync: jest.Mock;
  removed: string[];
} {
  const removed: string[] = [];
  const byFull = new Map<string, { mtimeMs: number; isDir: boolean }>();
  for (const [name, e] of Object.entries(children)) {
    byFull.set(path.join(DIR, name), e);
  }
  return {
    removed,
    rmSync: jest.fn((p: string) => {
      removed.push(p);
      byFull.delete(p);
    }),
    existsSync: (p: string) => p === DIR || byFull.has(p),
    readdirSync: (d: string) => (d === DIR ? Object.keys(children) : []),
    statSync: (p: string) => {
      const e = byFull.get(p);
      if (!e) {
        throw new Error('ENOENT');
      }
      return { mtimeMs: e.mtimeMs, isDirectory: () => e.isDir };
    },
  };
}

describe('HousekeepingService', () => {
  const NOW = 1_000_000_000;
  const HOUR = 3600_000;

  it('removes stale dirs matching the prefix, keeps fresh ones', async () => {
    const fs = makeFs({
      'sshlite-diff-old': { mtimeMs: NOW - 5 * HOUR, isDir: true },
      'sshlite-diff-new': { mtimeMs: NOW - 1000, isDir: true },
      'other-thing': { mtimeMs: NOW - 99 * HOUR, isDir: true },
    });
    const rule: SweepRule = { dir: DIR, prefix: 'sshlite-diff-', maxAgeMs: 2 * HOUR, kind: 'dir' };
    const svc = new HousekeepingService({ rules: [rule], now: () => NOW, fsApi: fs });

    const { removed } = await svc.sweep();
    expect(removed).toBe(1);
    expect(fs.removed).toEqual([path.join(DIR, 'sshlite-diff-old')]);
  });

  it('does not remove files when rule.kind is dir', async () => {
    const fs = makeFs({
      'sshlite-diff-file': { mtimeMs: NOW - 99 * HOUR, isDir: false },
    });
    const rule: SweepRule = { dir: DIR, prefix: 'sshlite-diff-', maxAgeMs: HOUR, kind: 'dir' };
    const svc = new HousekeepingService({ rules: [rule], now: () => NOW, fsApi: fs });

    const { removed } = await svc.sweep();
    expect(removed).toBe(0);
    expect(fs.rmSync).not.toHaveBeenCalled();
  });

  it('skips a non-existent directory without throwing', async () => {
    const fs = makeFs({});
    const rule: SweepRule = { dir: path.join('/does/not/exist'), prefix: 'x', maxAgeMs: HOUR, kind: 'dir' };
    const svc = new HousekeepingService({ rules: [rule], now: () => NOW, fsApi: fs });
    await expect(svc.sweep()).resolves.toEqual({ removed: 0 });
  });

  it('invokes delegates after the rule sweep', async () => {
    const fs = makeFs({});
    const delegate = jest.fn();
    const svc = new HousekeepingService({ rules: [], delegates: [delegate], now: () => NOW, fsApi: fs });
    await svc.sweep();
    expect(delegate).toHaveBeenCalledTimes(1);
  });

  it('continues if a delegate throws', async () => {
    const fs = makeFs({});
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good = jest.fn();
    const svc = new HousekeepingService({ rules: [], delegates: [bad, good], now: () => NOW, fsApi: fs });
    await expect(svc.sweep()).resolves.toEqual({ removed: 0 });
    expect(good).toHaveBeenCalled();
  });

  it('is re-entrancy guarded', async () => {
    const fs = makeFs({});
    let resolveDelegate: () => void = () => {};
    const delegate = jest.fn(
      () =>
        new Promise<void>((r) => {
          resolveDelegate = r;
        })
    );
    const svc = new HousekeepingService({ rules: [], delegates: [delegate], now: () => NOW, fsApi: fs });

    const first = svc.sweep();
    const second = await svc.sweep(); // should no-op while first is running
    expect(second).toEqual({ removed: 0 });
    expect(delegate).toHaveBeenCalledTimes(1);

    resolveDelegate();
    await first;
  });
});
