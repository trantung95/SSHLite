import { Invariant, Violation } from '../ChaosTypes';

export const semaphoreFloorInvariant: Invariant = {
  name: 'semaphoreFloor',
  whenToCheck: 'after-each-op',
  async snapshot(conn) {
    const sem = (conn as any).semaphore;
    return {
      timestamp: Date.now(),
      data: {
        active: sem?.activeCount ?? 0,
        available: sem?.available ?? 0,
      },
    };
  },
  check(_before, after) {
    const v: Violation[] = [];
    if ((after.data.active as number) < 0) {
      v.push({ invariant: 'semaphoreFloor', detail: `active slot count went negative: ${after.data.active}`, after });
    }
    if ((after.data.available as number) < 0) {
      v.push({ invariant: 'semaphoreFloor', detail: `available slot count went negative: ${after.data.available}`, after });
    }
    return v;
  },
};
