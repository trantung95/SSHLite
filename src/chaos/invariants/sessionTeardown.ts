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
    // The engine owns the shared connection — at session end the state should
    // be either Connected (chains finished without disconnecting) or
    // Disconnected (chains chose to disconnect, or the connection was lost).
    // Transient states (Connecting, Reconnecting) and Error indicate the
    // session left the connection in an unstable shape.
    const STABLE = new Set<ConnectionState>([ConnectionState.Connected, ConnectionState.Disconnected]);
    if (!STABLE.has(state)) {
      v.push({
        invariant: 'sessionTeardown',
        detail: `connection in unstable state at session end (state=${state})`,
        after,
      });
    }
    return v;
  },
};
