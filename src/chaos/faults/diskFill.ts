import { Fault } from '../ChaosTypes';
import { dockerExecIn } from './dockerExec';

export const diskFillFault: Fault = {
  name: 'diskFill',
  weight: 1,
  generateParams: (rng) => ({ mb: rng.int(50, 500) }),
  async inject(server, params) {
    const mb = params.mb as number;
    await dockerExecIn(server.container, [
      'sh', '-c',
      `dd if=/dev/zero of=/var/log/chaos-fill bs=1M count=${mb} 2>/dev/null || true`,
    ]);
  },
  async recover(server) {
    await dockerExecIn(server.container, ['rm', '-f', '/var/log/chaos-fill']);
  },
};
