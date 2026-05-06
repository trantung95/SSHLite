import { Invariant } from '../ChaosTypes';
import { sshStateMachineInvariant } from './sshStateMachine';
import { listenerLeakInvariant } from './listenerLeak';
import { activityCountInvariant } from './activityCount';
import { semaphoreFloorInvariant } from './semaphoreFloor';
import { sessionTeardownInvariant } from './sessionTeardown';
import { cleanShutdownInvariant } from './cleanShutdown';

export const INVARIANTS: Invariant[] = [
  sshStateMachineInvariant,
  listenerLeakInvariant,
  activityCountInvariant,
  semaphoreFloorInvariant,
  sessionTeardownInvariant,
  cleanShutdownInvariant,
];

export const INVARIANTS_AFTER_OP = INVARIANTS.filter(i => i.whenToCheck === 'after-each-op' || i.whenToCheck === 'both');
export const INVARIANTS_AFTER_SESSION = INVARIANTS.filter(i => i.whenToCheck === 'after-session' || i.whenToCheck === 'both');
