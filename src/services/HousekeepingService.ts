// @author hybr8
import * as path from 'path';
import * as fs from 'fs';
import { infoLog, diagLog } from '../utils/diagnosticLog';

/**
 * HousekeepingService — periodic cleanup of stale junk left by SSH Lite features.
 *
 * Runs a one-shot sweep at activation and is re-invoked by FileService's existing
 * hourly cleanup timer (no new polling loop). It is rule-driven so new features
 * can register what they leave behind: each rule scans a directory for entries
 * whose name starts with a prefix and which are older than a max age, and removes
 * the stale ones. Delegates let it also invoke existing per-feature cleanups
 * (e.g. FileService.cleanupOldTempFiles).
 *
 * LITE: only removes entries older than a threshold + matching a known prefix;
 * never touches in-use files; event/activation-driven, not a fresh timer.
 */

export interface SweepRule {
  /** Directory to scan (non-recursive). */
  dir: string;
  /** Only entries whose name starts with this prefix are eligible. */
  prefix: string;
  /** Entries younger than this (by mtime) are kept. */
  maxAgeMs: number;
  /** Whether to match directories or files. */
  kind: 'dir' | 'file';
}

/** Minimal fs surface used here (injectable for tests). */
export interface HousekeepingFsApi {
  existsSync(p: string): boolean;
  readdirSync(dir: string): string[];
  statSync(p: string): { mtimeMs: number; isDirectory(): boolean };
  rmSync(p: string, opts: { recursive?: boolean; force?: boolean }): void;
}

const defaultFsApi: HousekeepingFsApi = {
  existsSync: (p) => fs.existsSync(p),
  readdirSync: (dir) => fs.readdirSync(dir),
  statSync: (p) => fs.statSync(p),
  rmSync: (p, opts) => fs.rmSync(p, opts),
};

export interface HousekeepingOptions {
  rules: SweepRule[];
  /** Existing per-feature cleanups to invoke after the rule sweep. */
  delegates?: Array<() => void | Promise<void>>;
  now?: () => number;
  fsApi?: HousekeepingFsApi;
}

export class HousekeepingService {
  private readonly rules: SweepRule[];
  private readonly delegates: Array<() => void | Promise<void>>;
  private readonly now: () => number;
  private readonly fsApi: HousekeepingFsApi;
  private running = false;

  constructor(opts: HousekeepingOptions) {
    this.rules = opts.rules;
    this.delegates = opts.delegates ?? [];
    this.now = opts.now ?? (() => Date.now());
    this.fsApi = opts.fsApi ?? defaultFsApi;
  }

  /** Run a full sweep. Re-entrancy-guarded so overlapping triggers are safe. */
  async sweep(): Promise<{ removed: number }> {
    if (this.running) {
      return { removed: 0 };
    }
    this.running = true;
    let removed = 0;
    try {
      for (const rule of this.rules) {
        removed += this.sweepRule(rule);
      }
      for (const delegate of this.delegates) {
        try {
          await delegate();
        } catch (err) {
          diagLog('housekeeping', 'delegate-failed', { error: (err as Error).message });
        }
      }
    } finally {
      this.running = false;
    }
    infoLog('housekeeping', 'sweep', { removed });
    return { removed };
  }

  private sweepRule(rule: SweepRule): number {
    if (!this.fsApi.existsSync(rule.dir)) {
      return 0;
    }
    let names: string[];
    try {
      names = this.fsApi.readdirSync(rule.dir);
    } catch (err) {
      diagLog('housekeeping', 'readdir-failed', { dir: rule.dir, error: (err as Error).message });
      return 0;
    }
    let removed = 0;
    const cutoff = this.now() - rule.maxAgeMs;
    for (const name of names) {
      if (!name.startsWith(rule.prefix)) {
        continue;
      }
      const full = path.join(rule.dir, name);
      let st: { mtimeMs: number; isDirectory(): boolean };
      try {
        st = this.fsApi.statSync(full);
      } catch {
        continue;
      }
      const isDir = st.isDirectory();
      if (rule.kind === 'dir' && !isDir) {
        continue;
      }
      if (rule.kind === 'file' && isDir) {
        continue;
      }
      if (st.mtimeMs >= cutoff) {
        continue; // still fresh / possibly in use
      }
      try {
        this.fsApi.rmSync(full, { recursive: true, force: true });
        removed++;
      } catch (err) {
        diagLog('housekeeping', 'remove-failed', { path: full, error: (err as Error).message });
      }
    }
    return removed;
  }
}
