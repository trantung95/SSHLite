import { Fault } from '../ChaosTypes';
import { dockerExecIn } from './dockerExec';

export const sshdSignalFault: Fault = {
  name: 'sshdSignal',
  weight: 2,
  generateParams: () => ({}),
  async inject(server) {
    await dockerExecIn(server.container, ['pkill', '-STOP', 'sshd']);
  },
  async recover(server) {
    await dockerExecIn(server.container, ['pkill', '-CONT', 'sshd']);
  },
};
