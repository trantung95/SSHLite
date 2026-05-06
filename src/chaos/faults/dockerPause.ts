import { Fault } from '../ChaosTypes';
import { dockerCmd } from './dockerExec';

export const dockerPauseFault: Fault = {
  name: 'dockerPause',
  weight: 3,
  generateParams: () => ({}),
  async inject(server) {
    await dockerCmd(['pause', server.container]);
  },
  async recover(server) {
    await dockerCmd(['unpause', server.container]);
  },
};
