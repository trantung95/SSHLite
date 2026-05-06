import { Invariant, Violation } from '../ChaosTypes';

const LISTENER_THRESHOLD = 10;

export const listenerLeakInvariant: Invariant = {
  name: 'listenerLeak',
  whenToCheck: 'after-session',
  async snapshot(conn) {
    const counts: Record<string, number> = {};
    const c = conn as any;
    const client = c._client ?? c.client;
    if (client && typeof client.eventNames === 'function') {
      for (const ev of client.eventNames()) {
        counts[`client.${String(ev)}`] = client.listenerCount(ev);
      }
    }
    return { timestamp: Date.now(), data: { counts } };
  },
  check(before, after) {
    const v: Violation[] = [];
    const a = after.data.counts as Record<string, number>;
    for (const [name, count] of Object.entries(a)) {
      if (count > LISTENER_THRESHOLD) {
        v.push({
          invariant: 'listenerLeak',
          detail: `listener ${name} count=${count} exceeds threshold ${LISTENER_THRESHOLD}`,
          before, after,
        });
      }
    }
    return v;
  },
};
