import { Fault } from '../ChaosTypes';
import { dockerExecIn } from './dockerExec';

export const netemFault: Fault = {
  name: 'netem',
  weight: 2,
  requiresCaps: ['NET_ADMIN'],
  generateParams: (rng) => ({
    delay_ms: rng.int(50, 400),
    loss_pct: rng.int(0, 10),
  }),
  async inject(server, params) {
    await dockerExecIn(server.container, [
      'tc', 'qdisc', 'add', 'dev', 'eth0', 'root', 'netem',
      'delay', `${params.delay_ms}ms`,
      'loss', `${params.loss_pct}%`,
    ]);
  },
  async recover(server) {
    await dockerExecIn(server.container, ['tc', 'qdisc', 'del', 'dev', 'eth0', 'root']);
  },
};
