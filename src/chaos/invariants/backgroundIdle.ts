import { Invariant, Violation } from '../ChaosTypes';
import { SSHConnection } from '../../connection/SSHConnection';

/**
 * Background-idle invariant: after a session ends, no `readFile`-class SSH op
 * should fire during a short settle window.
 *
 * Why this exists: the click-during-search regression (see CHANGELOG) was a
 * 1Hz file-watcher poll re-downloading an unchanged file every second. It ran
 * passively in the background between chain ops — none of the existing
 * invariants (listenerLeak, activityCount, semaphoreFloor, cleanShutdown)
 * watched for that pattern, so chaos missed the bug entirely. This invariant
 * watches the global `readFile` counter on `SSHConnection` and fails if
 * background reads happen during the settle window.
 *
 * Why count only `readFile`: stat-based polls are cheap and expected (the
 * post-fix watcher does one stat per second per watched file). The pathology
 * was the full-file re-download, which goes through `readFile` /
 * `readFileChunked` / `readFileTail` — all of which bump the counter.
 *
 * Threshold: 1 readFile in 1 s is allowed (covers in-flight teardown reads
 * and the immediate refresh fired on visibility regain). Anything beyond
 * that is background pressure that didn't exist when the session ended.
 */

const SETTLE_MS = 1000;
const ALLOWED_READS_IN_SETTLE = 1;

export const backgroundIdleInvariant: Invariant = {
  name: 'backgroundIdle',
  whenToCheck: 'after-session',
  async snapshot() {
    const start = SSHConnection.chaosReadFileCount;
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    const end = SSHConnection.chaosReadFileCount;
    return {
      timestamp: Date.now(),
      data: { settleStart: start, settleEnd: end, settleMs: SETTLE_MS },
    };
  },
  check(_before, after) {
    const start = after.data.settleStart as number;
    const end = after.data.settleEnd as number;
    const delta = end - start;
    const v: Violation[] = [];
    if (delta > ALLOWED_READS_IN_SETTLE) {
      v.push({
        invariant: 'backgroundIdle',
        detail: `${delta} background readFile ops in ${SETTLE_MS}ms after session end (allowed ${ALLOWED_READS_IN_SETTLE}). Likely a passive timer or watcher leaking work; check FileService.refreshSingleFile and SSHConnection.readFile call sites.`,
        after,
      });
    }
    return v;
  },
};
