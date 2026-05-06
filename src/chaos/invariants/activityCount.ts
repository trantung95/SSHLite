import { Invariant, Violation } from '../ChaosTypes';
import { ActivityService } from '../../services/ActivityService';

export const activityCountInvariant: Invariant = {
  name: 'activityCount',
  whenToCheck: 'after-session',
  async snapshot() {
    let running = 0;
    try {
      const svc = ActivityService.getInstance();
      running = svc.getRunningActivities().length;
    } catch {
      // Service may not be initialised in some paths; treat as 0.
    }
    return { timestamp: Date.now(), data: { running } };
  },
  check(before, after) {
    const v: Violation[] = [];
    if ((after.data.running as number) > (before.data.running as number)) {
      v.push({
        invariant: 'activityCount',
        detail: `running activities went from ${before.data.running} to ${after.data.running} after session`,
        before, after,
      });
    }
    return v;
  },
};
