import { PrimitiveOp } from '../../ChaosTypes';
import { SeededRandom } from '../../chaos-helpers';

const SHORT_CMDS = ['pwd', 'id', 'whoami', 'hostname', 'date', 'uname -a', 'echo chaos'];
const LONG_CMDS  = ['sleep 1 && echo done', 'find / -maxdepth 2 -type d 2>/dev/null | head -20', 'ls -la /etc | head -30'];
const FAILING_CMDS = ['false', 'cat /no/such/file', 'cd /not/here', 'unknownCmd-zzz'];

function pickCmd(arr: string[], rng: SeededRandom): string {
  return arr[rng.int(0, arr.length - 1)];
}

const sshExec = 'exec';

export const runPrimitives: PrimitiveOp[] = [
  {
    name: 'runShort',
    surface: 'sshOps',
    weight: 5,
    requiresConnected: true,
    generateParams: (rng) => ({ cmd: pickCmd(SHORT_CMDS, rng) }),
    async execute(conn, params) {
      await (conn as any)[sshExec](params.cmd as string);
    },
  },
  {
    name: 'runLong',
    surface: 'sshOps',
    weight: 1,
    requiresConnected: true,
    longRunning: true,
    generateParams: (rng) => ({ cmd: pickCmd(LONG_CMDS, rng) }),
    async execute(conn, params) {
      await (conn as any)[sshExec](params.cmd as string);
    },
  },
  {
    name: 'runFailing',
    surface: 'sshOps',
    weight: 1,
    requiresConnected: true,
    generateParams: (rng) => ({ cmd: pickCmd(FAILING_CMDS, rng) }),
    async execute(conn, params) {
      try { await (conn as any)[sshExec](params.cmd as string); } catch { /* expected */ }
    },
  },
  {
    name: 'shell',
    surface: 'sshOps',
    weight: 1,
    requiresConnected: true,
    longRunning: true,
    generateParams: () => ({}),
    async execute(conn) {
      const ch = await conn.shell();
      ch.end();
    },
  },
];
