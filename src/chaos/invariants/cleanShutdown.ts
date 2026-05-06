import { Invariant } from '../ChaosTypes';
import { ConnectionState } from '../../types';

/**
 * v0.8.0 baseline: stub that registers the invariant slot. The rich
 * post-disconnect-error contract check (verifying that ops on a disconnected
 * connection throw the documented error type rather than hanging or silently
 * swallowing) lands in v0.8.1 once we identify the exact error class to require.
 */
export const cleanShutdownInvariant: Invariant = {
  name: 'cleanShutdown',
  whenToCheck: 'after-each-op',
  async snapshot(conn) {
    return {
      timestamp: Date.now(),
      data: { state: (conn as any).state ?? ConnectionState.Disconnected },
    };
  },
  check() {
    return [];
  },
};
