/**
 * SSHConnection sudo state-machine unit tests.
 *
 * Exercises the new stderr-sync protocol introduced to fix a bug where the
 * password was written to stdin unconditionally — leaking the password into
 * the saved file whenever sudo was NOPASSWD or had a warm credential cache.
 *
 * What is verified here (mock-only, no real SSH):
 *  - Password is ONLY written when sudo emits the PROMPT sentinel on stderr.
 *  - Payload is ONLY written after the READY sentinel appears.
 *  - When sudo is cached/NOPASSWD (READY without PROMPT), password is never written.
 *  - Wrong password / not-in-sudoers / sudo-not-installed surface as classified errors.
 *  - The constructed shell command contains exactly one PROMPT and one READY
 *    token bound to the same 16-hex nonce.
 *  - `runAsUser` is validated and embedded as `sudo -u <user>`.
 *
 * The real wire behaviour (NOPASSWD vs. password-sudo, file content equality)
 * is covered by the docker integration suite — this file is the cheap unit-level
 * regression net.
 */

import { EventEmitter } from 'events';
import { ConnectionState, SFTPError } from '../types';
import { createMockHostConfig } from '../__mocks__/testHelpers';

jest.mock('ssh2', () => ({
  Client: jest.fn().mockImplementation(() => ({
    on: jest.fn().mockReturnThis(),
    connect: jest.fn(),
    end: jest.fn(),
    destroy: jest.fn(),
  })),
}));

jest.mock('../services/CredentialService', () => ({
  CredentialService: {
    getInstance: jest.fn().mockReturnValue({
      getCredentialPassword: jest.fn().mockResolvedValue(undefined),
      listCredentials: jest.fn().mockReturnValue([]),
    }),
  },
}));

import { SSHConnection } from './SSHConnection';

/**
 * Minimal ClientChannel-shaped fake. Records every `write()` call as a Buffer
 * and exposes `stderr` + EventEmitter behaviour so tests can drive the protocol.
 */
class FakeChannel extends EventEmitter {
  public stderr = new EventEmitter();
  public writes: Buffer[] = [];
  public ended = false;
  public destroyed = false;

  write(chunk: string | Buffer): boolean {
    this.writes.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return true;
  }
  end(): void { this.ended = true; }
  destroy(): void { this.destroyed = true; }
}

interface SudoExecRawResult { stdout: Buffer; stderr: string; code: number; }
type SudoExecRawFn = (
  command: string,
  password: string,
  stdinPayload?: Buffer | string,
  options?: { runAsUser?: string }
) => Promise<SudoExecRawResult>;

/** Helper: extract the nonce from a sudo command string built by _sudoExecRaw. */
function extractNonce(sudoCmd: string): string {
  const m = sudoCmd.match(/SSHLITE_SUDO_PASS:([0-9a-f]{16}):/);
  if (!m) { throw new Error(`No PROMPT token in: ${sudoCmd}`); }
  return m[1];
}

/**
 * Flush pending microtasks so the awaited `_execChannel` promise resolves and
 * `_sudoExecRaw` has time to attach its event handlers to the fake stream
 * before tests emit data into it.
 */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('SSHConnection._sudoExecRaw — stderr-sync state machine', () => {
  let connection: SSHConnection;
  let channel: FakeChannel;
  let capturedCommand: string;
  let execChannelSpy: jest.SpyInstance;

  const PASSWORD = 'p4ssw0rd-must-not-leak';

  beforeEach(() => {
    const host = createMockHostConfig({ host: '10.0.0.1', port: 22, username: 'tester' });
    connection = new SSHConnection(host);

    // Bypass the guard in _sudoExecRaw that requires an active SSH client.
    (connection as any)._client = {};
    connection.state = ConnectionState.Connected;

    channel = new FakeChannel();
    capturedCommand = '';
    execChannelSpy = jest
      .spyOn(connection as any, '_execChannel')
      .mockImplementation(async (...args: unknown[]) => {
        capturedCommand = args[0] as string;
        return channel;
      });
  });

  afterEach(() => {
    (connection as any)._client = null;
    connection.dispose();
    jest.restoreAllMocks();
  });

  function call(
    command: string,
    payload?: Buffer | string,
    options?: { runAsUser?: string },
  ): Promise<SudoExecRawResult> {
    const sudoExecRaw = (connection as any)._sudoExecRaw.bind(connection) as SudoExecRawFn;
    return sudoExecRaw(command, PASSWORD, payload, options);
  }

  describe('shell command construction', () => {
    it('embeds a 16-hex nonce in both PROMPT and READY tokens', async () => {
      const promise = call("tee 'x' > /dev/null");
      await flush();

      const nonce = extractNonce(capturedCommand);
      expect(nonce).toMatch(/^[0-9a-f]{16}$/);
      expect(capturedCommand).toContain(`SSHLITE_SUDO_PASS:${nonce}:`);
      expect(capturedCommand).toContain(`SSHLITE_SUDO_READY:${nonce}:`);
      expect(capturedCommand.match(/SSHLITE_SUDO_PASS:/g)?.length).toBe(1);
      expect(capturedCommand.match(/SSHLITE_SUDO_READY:/g)?.length).toBe(1);

      // Settle the call so the test does not leak a pending promise.
      channel.stderr.emit('data', Buffer.from(`SSHLITE_SUDO_READY:${nonce}:`));
      channel.emit('close', 0);
      await promise;
    });

    it('uses a fresh nonce on every invocation', async () => {
      const nonces: string[] = [];
      for (let i = 0; i < 3; i++) {
        const p = call('cat /tmp/x');
        await flush();
        const n = extractNonce(capturedCommand);
        nonces.push(n);
        channel.stderr.emit('data', Buffer.from(`SSHLITE_SUDO_READY:${n}:`));
        channel.emit('close', 0);
        await p;
        channel = new FakeChannel();
      }
      expect(new Set(nonces).size).toBe(3);
    });

    it('embeds sudo -u <user> when runAsUser is provided', async () => {
      const promise = call('cat /tmp/x', undefined, { runAsUser: 'www-data' });
      await flush();
      expect(capturedCommand).toMatch(/^sudo -u www-data -S /);

      channel.stderr.emit('data', Buffer.from(`SSHLITE_SUDO_READY:${extractNonce(capturedCommand)}:`));
      channel.emit('close', 0);
      await promise;
    });

    it('omits -u <user> when runAsUser is not provided', async () => {
      const promise = call('cat /tmp/x');
      await flush();
      expect(capturedCommand).toMatch(/^sudo -S /);
      expect(capturedCommand).not.toContain('-u ');

      channel.stderr.emit('data', Buffer.from(`SSHLITE_SUDO_READY:${extractNonce(capturedCommand)}:`));
      channel.emit('close', 0);
      await promise;
    });

    it('rejects invalid runAsUser (shell metacharacters)', async () => {
      // Validation throws synchronously inside the async function before
      // `_execChannel` is even called → no flush needed.
      await expect(call('cat /tmp/x', undefined, { runAsUser: 'bad;rm -rf /' })).rejects.toThrow(SFTPError);
      await expect(call('cat /tmp/x', undefined, { runAsUser: '$(whoami)' })).rejects.toThrow(SFTPError);
      await expect(call('cat /tmp/x', undefined, { runAsUser: '' })).rejects.toThrow(SFTPError);
    });
  });

  describe('happy path: password-sudo', () => {
    it('writes password ONLY after PROMPT, payload ONLY after READY', async () => {
      const payload = Buffer.from('hello world\n');
      const promise = call("tee '/etc/file' > /dev/null", payload);
      await flush();
      const nonce = extractNonce(capturedCommand);

      // Step 1: sudo emits PROMPT → password gets written exactly once.
      expect(channel.writes.length).toBe(0);
      channel.stderr.emit('data', Buffer.from(`SSHLITE_SUDO_PASS:${nonce}:`));

      expect(channel.writes.length).toBe(1);
      expect(channel.writes[0].toString()).toBe(`${PASSWORD}\n`);
      expect(channel.ended).toBe(false);

      // Step 2: inner shell emits READY → payload gets written + stdin closed.
      channel.stderr.emit('data', Buffer.from(`SSHLITE_SUDO_READY:${nonce}:`));

      expect(channel.writes.length).toBe(2);
      expect(channel.writes[1]).toEqual(payload);
      expect(channel.ended).toBe(true);

      channel.emit('data', Buffer.from(''));
      channel.emit('close', 0);

      const result = await promise;
      expect(result.code).toBe(0);
    });
  });

  describe('cached / NOPASSWD sudo (regression test for the bug)', () => {
    it('writes payload directly when READY appears without PROMPT, NEVER writing password', async () => {
      const payload = Buffer.from('cfg=1\n');
      const promise = call("tee '/etc/file' > /dev/null", payload);
      await flush();
      const nonce = extractNonce(capturedCommand);

      // sudo skipped the prompt entirely (NOPASSWD or cached creds).
      channel.stderr.emit('data', Buffer.from(`SSHLITE_SUDO_READY:${nonce}:`));

      // Critical assertion: only the payload was ever written — no password leak.
      expect(channel.writes.length).toBe(1);
      expect(channel.writes[0]).toEqual(payload);
      expect(channel.writes.every((b) => !b.toString().includes(PASSWORD))).toBe(true);
      expect(channel.ended).toBe(true);

      channel.emit('close', 0);
      await expect(promise).resolves.toMatchObject({ code: 0 });
    });

    it('handles READY arriving in the same chunk as trailing real stderr', async () => {
      const payload = Buffer.from('x');
      const promise = call('cat /tmp/x', payload);
      await flush();
      const nonce = extractNonce(capturedCommand);

      channel.stderr.emit('data', Buffer.from(`SSHLITE_SUDO_READY:${nonce}:cmd-warning: foo\n`));
      channel.emit('close', 0);

      const result = await promise;
      expect(result.stderr).toContain('cmd-warning: foo');
      expect(result.stderr).not.toContain('SSHLITE_SUDO_READY');
    });
  });

  describe('error paths', () => {
    it('rejects with "incorrect password" when sudo prints Sorry, try again.', async () => {
      const promise = call("tee 'x' > /dev/null", Buffer.from('data'));
      await flush();
      const nonce = extractNonce(capturedCommand);

      channel.stderr.emit('data', Buffer.from(`SSHLITE_SUDO_PASS:${nonce}:`));
      channel.stderr.emit('data', Buffer.from('Sorry, try again.\n'));

      await expect(promise).rejects.toThrow('Sudo authentication failed: incorrect password');
      expect(channel.destroyed).toBe(true);
    });

    it('rejects with "incorrect password" on repeat PROMPT after first attempt', async () => {
      const promise = call("tee 'x' > /dev/null", Buffer.from('data'));
      await flush();
      const nonce = extractNonce(capturedCommand);

      channel.stderr.emit('data', Buffer.from(`SSHLITE_SUDO_PASS:${nonce}:`));
      channel.stderr.emit('data', Buffer.from(`SSHLITE_SUDO_PASS:${nonce}:`));

      await expect(promise).rejects.toThrow('Sudo authentication failed: incorrect password');
      // Password written exactly once, not on the retry attempt.
      expect(channel.writes.filter((b) => b.toString().includes(PASSWORD)).length).toBe(1);
    });

    it('rejects with "not in the sudoers" when sudo says user is not authorized', async () => {
      const promise = call('cat /etc/shadow');
      await flush();
      channel.stderr.emit('data', Buffer.from('tester is not in the sudoers file. This incident will be reported.\n'));
      channel.emit('close', 1);

      await expect(promise).rejects.toThrow(/not in the sudoers/i);
    });

    it('rejects with "sudo is not installed" when shell reports command not found', async () => {
      const promise = call('cat /etc/x');
      await flush();
      channel.stderr.emit('data', Buffer.from('sh: sudo: not found\n'));
      channel.emit('close', 127);

      await expect(promise).rejects.toThrow(/sudo is not installed/i);
    });

    it('rejects on stream error', async () => {
      const promise = call('cat /tmp/x');
      await flush();
      channel.emit('error', new Error('socket reset'));
      await expect(promise).rejects.toThrow('Sudo stream error: socket reset');
    });
  });

  describe('timeout', () => {
    it('rejects after 60s if sudo never responds', async () => {
      jest.useFakeTimers({ doNotFake: ['setImmediate'] });
      const promise = call('cat /tmp/x');
      // Pre-attach the rejection expectation so unhandled rejection warnings
      // don't fire when the timer triggers.
      const expectation = expect(promise).rejects.toThrow(/sudo did not respond within 60s/);
      await flush();
      jest.advanceTimersByTime(60_000);
      await expectation;
      expect(channel.destroyed).toBe(true);
      jest.useRealTimers();
    });
  });
});
