import { Fault } from '../ChaosTypes';
import { dockerPauseFault } from './dockerPause';
import { netemFault } from './netem';
import { sshdSignalFault } from './sshdSignal';
import { diskFillFault } from './diskFill';

export const FAULTS: Fault[] = [
  dockerPauseFault,
  netemFault,
  sshdSignalFault,
  diskFillFault,
];

const byName = new Map(FAULTS.map(f => [f.name, f]));

export function faultByName(name: string): Fault | undefined {
  return byName.get(name);
}
