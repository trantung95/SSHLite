/**
 * Multi-OS sudo protocol tests.
 *
 * Validates that the v0.8.15 stderr-sync sudo protocol in
 * `SSHConnection._sudoExecRaw` works identically across the 5 supported
 * distributions (Alpine, Ubuntu, Debian, Fedora, Rocky). Each distro ships
 * with a slightly different `sudo` binary (BusyBox-adjacent vs. mainline
 * Sudo) and slightly different shell defaults, so a regression in any one
 * would slip through Alpine-only tests.
 *
 * The critical case here is the original-bug case: NOPASSWD sudo with a
 * deliberately bogus password. If the protocol regresses to writing the
 * password unconditionally, the saved file's first line will contain the
 * bogus password — verified absent by every distro test below.
 *
 * Servers used: CI_SERVERS (ports 2230-2234) from multios-helpers.ts.
 * Each container has `usernopasswd` (NOPASSWD: ALL) and `userpasswd` (ALL)
 * provisioned during image build (see Dockerfile.*-keys).
 *
 * Run:
 *   npm run test:ci   # spins up multi-OS via docker-compose.ci.yml
 */

import { SSHConnection } from '../connection/SSHConnection';
import {
  CI_SERVERS,
  OSServerConfig,
  createTestConnection,
  safeDisconnect,
  setupCredentialServiceMock,
  setupVscodeMocks,
} from './multios-helpers';

beforeAll(() => {
  setupCredentialServiceMock();
  setupVscodeMocks();
});

const SUDO_PROTOCOL_TIMEOUT = 60_000;

describe.each(CI_SERVERS)('Sudo protocol on $os', (server: OSServerConfig) => {
  // ─────────────────────────────────────────────────────────────────────────
  // The regression-critical case: NOPASSWD sudo with a bogus password.
  // Across every distro, the saved file content MUST equal the payload and
  // the bogus password string MUST NOT appear in it.
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'NOPASSWD save preserves payload exactly; password does not leak into file',
    async () => {
      const conn = await createTestConnection(server, 'password', {
        username: 'usernopasswd',
        password: 'nopw',
      });
      try {
        const file = `/tmp/sshlite-multios-nopw-${server.hostname}-${Date.now()}.txt`;
        const payload = Buffer.from(`hello-from-${server.hostname}\n`);
        const PASSWORD_SENTINEL = `LEAK-SENTINEL-${server.hostname}-XYZ`;

        await conn.sudoWriteFile(file, payload, PASSWORD_SENTINEL);

        const onDisk = await conn.readFile(file);
        expect(onDisk.toString('utf-8')).toBe(payload.toString('utf-8'));
        expect(onDisk.toString('utf-8')).not.toContain(PASSWORD_SENTINEL);

        // Cleanup
        await conn.sudoDeleteFile(file, PASSWORD_SENTINEL);
      } finally {
        await safeDisconnect(conn);
      }
    },
    SUDO_PROTOCOL_TIMEOUT,
  );

  // ─────────────────────────────────────────────────────────────────────────
  // Password sudo with the correct password works on every distro (exercises
  // the PROMPT-detection branch under each distro's `sudo` binary, which can
  // differ in the exact prompt format / banner text).
  // ─────────────────────────────────────────────────────────────────────────
  it(
    'password sudo writes file content with correct password',
    async () => {
      const conn = await createTestConnection(server, 'password', {
        username: 'userpasswd',
        password: 'pwsecret',
      });
      try {
        const file = `/tmp/sshlite-multios-pw-${server.hostname}-${Date.now()}.txt`;
        const payload = Buffer.from(`pw-from-${server.hostname}\n`);

        await conn.sudoWriteFile(file, payload, 'pwsecret');

        const onDisk = await conn.readFile(file);
        expect(onDisk.toString('utf-8')).toBe(payload.toString('utf-8'));
        expect(onDisk.toString('utf-8')).not.toContain('pwsecret');

        await conn.sudoDeleteFile(file, 'pwsecret');
      } finally {
        await safeDisconnect(conn);
      }
    },
    SUDO_PROTOCOL_TIMEOUT,
  );
});
