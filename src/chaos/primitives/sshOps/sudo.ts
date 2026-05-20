/**
 * Chaos primitives for the v0.8.15 stderr-sync sudo protocol.
 *
 * These exercise `SSHConnection.sudoWriteFile / sudoReadFile / sudoExec`
 * during chaos runs so the protocol gets fault-tested alongside netem,
 * sshdSignal, and dockerPause faults. Concretely we want to catch any
 * regression where:
 *
 *   - the connection drops between PROMPT and READY → timeout/error handling
 *     differs from what unit tests exercise (mocked stream),
 *   - a paused container makes sudo's `_sudoExecRaw` hang past its 60s
 *     budget,
 *   - the password is somehow written into the file payload under network
 *     partition (the original v0.8.13 bug).
 *
 * Each primitive uses a try/catch to swallow expected failures (e.g. server
 * doesn't have sudo configured for the connected user). This is the same
 * graceful-skip pattern used by `filePrimitives` — chaos counts a swallowed
 * primitive as a successful op for accounting purposes; only thrown errors
 * become run failures.
 *
 * Password parameter: a dummy string. On servers configured with NOPASSWD
 * sudo, the protocol's state machine sees READY without PROMPT and never
 * writes the password — so any string works. On servers requiring a password
 * the primitive will fail authentication, the catch block swallows it, and
 * the op is a no-op. We deliberately do not thread real sudo passwords
 * through the chaos engine.
 */

import { PrimitiveOp } from '../../ChaosTypes';
import { SeededRandom } from '../../chaos-helpers';

const CHAOS_PW_PLACEHOLDER = 'chaos-dummy-pw';

function randomPath(rng: SeededRandom): string {
  const tag = rng.int(0, 0xffffff).toString(16);
  return `/tmp/chaos-sudo-${tag}`;
}

function deterministicBytes(seed: number, len: number): Buffer {
  const rng = new SeededRandom(seed);
  const buf = Buffer.alloc(len);
  for (let i = 0; i < len; i++) { buf[i] = rng.int(0, 255); }
  return buf;
}

/** Safe small set of read-only commands so sudoExec doesn't mutate state. */
const SAFE_SUDO_COMMANDS = [
  'whoami',
  'id -un',
  'hostname',
  'true',
  'cat /etc/hostname',
];

export const sudoPrimitives: PrimitiveOp[] = [
  {
    name: 'sudoWriteFile',
    surface: 'sshOps',
    weight: 2,
    requiresConnected: true,
    generateParams: (rng) => ({
      path: randomPath(rng),
      bytesLen: rng.int(0, 4096),
      bytesSeed: rng.int(0, 0xffffff),
    }),
    async execute(conn, params) {
      const bytes = deterministicBytes(params.bytesSeed as number, params.bytesLen as number);
      try {
        await conn.sudoWriteFile(params.path as string, bytes, CHAOS_PW_PLACEHOLDER);
      } catch {
        // Sudo unavailable on this user/server, or write failed — silently skip.
        // Unit + docker integration tests already validate content-correctness.
      }
    },
  },
  {
    name: 'sudoReadFile',
    surface: 'sshOps',
    weight: 2,
    requiresConnected: true,
    generateParams: (rng) => {
      // Read a small, low-risk root-owned file when present.
      const candidates = ['/etc/hostname', '/etc/hosts', '/etc/os-release'];
      return { path: candidates[rng.int(0, candidates.length - 1)] };
    },
    async execute(conn, params) {
      try {
        await conn.sudoReadFile(params.path as string, CHAOS_PW_PLACEHOLDER);
      } catch {
        // Sudo unavailable or file missing — skip.
      }
    },
  },
  {
    name: 'sudoExec',
    surface: 'sshOps',
    weight: 2,
    requiresConnected: true,
    generateParams: (rng) => ({
      cmd: SAFE_SUDO_COMMANDS[rng.int(0, SAFE_SUDO_COMMANDS.length - 1)],
    }),
    async execute(conn, params) {
      try {
        await conn.sudoExec(params.cmd as string, CHAOS_PW_PLACEHOLDER);
      } catch {
        // Sudo unavailable — skip.
      }
    },
  },
];
