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

describe('backgroundIdle invariant (per-connection counter)', () => {
  // Regression: chaos runs sessions on several servers at once. The invariant used
  // the global SSHConnection.chaosReadFileCount, so a server whose session had ended
  // was blamed for reads made by servers still running their chains.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { backgroundIdleInvariant } = require('../../chaos/invariants/backgroundIdle');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { SSHConnection } = require('../../connection/SSHConnection');

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  async function settle(own: { chaosReadFileCount: number }, during: () => void) {
    const p = backgroundIdleInvariant.snapshot(own as any);
    during();
    await jest.advanceTimersByTimeAsync(1000);
    const after = await p;
    return backgroundIdleInvariant.check(after, after);
  }

  it('ignores reads made on OTHER connections during the settle window', async () => {
    const own = { chaosReadFileCount: 5 };
    const other = { chaosReadFileCount: 0 };
    const v = await settle(own, () => {
      other.chaosReadFileCount += 30;
      SSHConnection.chaosReadFileCount += 30;
    });
    expect(v).toEqual([]);
  });

  it('allows one in-flight read on its own connection', async () => {
    const own = { chaosReadFileCount: 0 };
    expect(await settle(own, () => { own.chaosReadFileCount += 1; })).toEqual([]);
  });

  it('flags background reads on its own connection', async () => {
    const own = { chaosReadFileCount: 0 };
    const v = await settle(own, () => { own.chaosReadFileCount += 4; });
    expect(v).toHaveLength(1);
    expect(v[0].invariant).toBe('backgroundIdle');
    expect(v[0].detail).toContain('4 background readFile ops');
  });
});
