import { Invariant, Violation } from '../ChaosTypes';
import { ConnectionState } from '../../types';

export const sessionTeardownInvariant: Invariant = {
  name: 'sessionTeardown',
  whenToCheck: 'after-session',
  async snapshot(conn) {
    return { timestamp: Date.now(), data: { state: (conn as any).state ?? ConnectionState.Disconnected } };
  },
  check(_before, after) {
    const v: Violation[] = [];
    const state = after.data.state as ConnectionState;
    if (state !== ConnectionState.Disconnected) {
      v.push({
        invariant: 'sessionTeardown',
        detail: `connection not back to Disconnected at session end (state=${state})`,
        after,
      });
    }
    return v;
  },
};
