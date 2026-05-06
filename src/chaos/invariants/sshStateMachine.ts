import { Invariant, Violation } from '../ChaosTypes';
import { ConnectionState } from '../../types';

const VALID_STATES = new Set<ConnectionState>([
  ConnectionState.Disconnected,
  ConnectionState.Connecting,
  ConnectionState.Connected,
  ConnectionState.Reconnecting,
  ConnectionState.Error,
]);

export const sshStateMachineInvariant: Invariant = {
  name: 'sshStateMachine',
  whenToCheck: 'after-each-op',
  async snapshot(conn) {
    return { timestamp: Date.now(), data: { state: (conn as any).state ?? ConnectionState.Disconnected } };
  },
  check(_before, after) {
    const v: Violation[] = [];
    const state = after.data.state as ConnectionState;
    if (!VALID_STATES.has(state)) {
      v.push({ invariant: 'sshStateMachine', detail: `connection in invalid state: ${state}`, after });
    }
    return v;
  },
};
