import { INVARIANTS, INVARIANTS_AFTER_OP, INVARIANTS_AFTER_SESSION } from '../../chaos/invariants';
import { sshStateMachineInvariant } from '../../chaos/invariants/sshStateMachine';
import { activityCountInvariant } from '../../chaos/invariants/activityCount';
import { semaphoreFloorInvariant } from '../../chaos/invariants/semaphoreFloor';
import { sessionTeardownInvariant } from '../../chaos/invariants/sessionTeardown';
import { ConnectionState } from '../../types';

describe('invariants registry', () => {
  it('has 7 invariants (v0.8.0 baseline of 6 + backgroundIdle added with the click-during-search fix)', () => {
    expect(INVARIANTS.length).toBe(7);
  });

  it('every invariant has a unique name', () => {
    const names = INVARIANTS.map(i => i.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('partitions sum to >= total (some may be both)', () => {
    expect(INVARIANTS_AFTER_OP.length + INVARIANTS_AFTER_SESSION.length).toBeGreaterThanOrEqual(INVARIANTS.length);
  });
});

describe('sshStateMachine invariant', () => {
  it('passes for a valid state', () => {
    const before = { timestamp: 0, data: { state: ConnectionState.Disconnected } };
    const after = { timestamp: 0, data: { state: ConnectionState.Connected } };
    expect(sshStateMachineInvariant.check(before, after)).toEqual([]);
  });

  it('flags an invalid state', () => {
    const before = { timestamp: 0, data: { state: ConnectionState.Disconnected } };
    const after = { timestamp: 0, data: { state: 'banana' as any } };
    expect(sshStateMachineInvariant.check(before, after).length).toBe(1);
  });
});

describe('activityCount invariant', () => {
  it('passes when count stays the same', () => {
    const before = { timestamp: 0, data: { running: 0 } };
    const after = { timestamp: 0, data: { running: 0 } };
    expect(activityCountInvariant.check(before, after)).toEqual([]);
  });

  it('flags growth in count after session', () => {
    const before = { timestamp: 0, data: { running: 1 } };
    const after = { timestamp: 0, data: { running: 5 } };
    expect(activityCountInvariant.check(before, after).length).toBe(1);
  });
});

describe('semaphoreFloor invariant', () => {
  it('passes for non-negative counts', () => {
    const before = { timestamp: 0, data: { active: 0, available: 8 } };
    const after = { timestamp: 0, data: { active: 2, available: 6 } };
    expect(semaphoreFloorInvariant.check(before, after)).toEqual([]);
  });

  it('flags negative active count', () => {
    const before = { timestamp: 0, data: { active: 0, available: 8 } };
    const after = { timestamp: 0, data: { active: -1, available: 8 } };
    expect(semaphoreFloorInvariant.check(before, after).length).toBe(1);
  });
});

describe('sessionTeardown invariant', () => {
  it('passes when state is Disconnected (chains chose to disconnect)', () => {
    const before = { timestamp: 0, data: { state: ConnectionState.Connected } };
    const after = { timestamp: 0, data: { state: ConnectionState.Disconnected } };
    expect(sessionTeardownInvariant.check(before, after)).toEqual([]);
  });

  it('passes when state is Connected (engine still owns the shared connection)', () => {
    const before = { timestamp: 0, data: { state: ConnectionState.Connected } };
    const after = { timestamp: 0, data: { state: ConnectionState.Connected } };
    expect(sessionTeardownInvariant.check(before, after)).toEqual([]);
  });

  it('flags transient state (Reconnecting) at session end', () => {
    const before = { timestamp: 0, data: { state: ConnectionState.Connected } };
    const after = { timestamp: 0, data: { state: ConnectionState.Reconnecting } };
    expect(sessionTeardownInvariant.check(before, after).length).toBe(1);
  });

  it('flags Error state at session end', () => {
    const before = { timestamp: 0, data: { state: ConnectionState.Connected } };
    const after = { timestamp: 0, data: { state: ConnectionState.Error } };
    expect(sessionTeardownInvariant.check(before, after).length).toBe(1);
  });
});
