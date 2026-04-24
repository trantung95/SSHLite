/**
 * Channel semaphore E2E tests
 *
 * Requires Docker: `docker compose -f test/e2e/docker-compose.yml up -d`
 *
 * These tests use real SSH connections (via SSHConnection + CommandGuard) and verify:
 * A. Terminal waits for slot and opens once a search slot frees
 * B. Search adapts concurrency and all commands complete
 * C. Multi-server isolation — server A saturation does not block server B
 * D. Per-user isolation (same host, different connection IDs)
 * E. removeSemaphore on disconnect — queued waiters rejected
 *
 * Run: npx jest --config jest.e2e.config.js --no-coverage
 * Skip if Docker unavailable: tests auto-skip via beforeAll check.
 */

import * as net from 'net';
import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../../src/connection/SSHConnection';
import { CommandGuard } from '../../src/services/CommandGuard';
import { ActivityService } from '../../src/services/ActivityService';
import { CredentialService } from '../../src/services/CredentialService';
import { ChannelSemaphore } from '../../src/services/ChannelSemaphore';
import { IHostConfig } from '../../src/types';
import { SavedCredential } from '../../src/services/CredentialService';

// ─── Docker SSH server configuration ──────────────────────────────────────────

const SSH_HOST = '127.0.0.1';
const SSH_PORT = 2222;
const SSH_USER = 'testuser';
const SSH_PASS = 'testpass';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Check if the Docker SSH server is reachable
 */
function isDockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: SSH_HOST, port: SSH_PORT }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(2000);
    socket.on('error', () => resolve(false));
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

/** In-memory known-hosts store (persists across the test run so the host-key dialog
 *  only fires once and subsequent connections skip the prompt). */
const _knownHosts: Record<string, unknown> = {};

/**
 * Set up vscode mocks so SSHConnection can connect without UI interaction.
 * - globalState: in-memory Memento that stores the Docker server's host key
 *   after first-connect auto-accept.
 * - showInformationMessage → 'Yes, Connect' (new-host key acceptance)
 * - showWarningMessage → 'Accept New Key' (changed-host key acceptance)
 * - showQuickPick → 'No, use only for this session' (save-password dialog)
 */
function setupVscodeMocks(): void {
  setGlobalState({
    get: <T>(key: string, def?: T) => (_knownHosts[key] as T) ?? (def as T),
    update: async (k: string, v: unknown) => { _knownHosts[k] = v; },
    keys: () => Object.keys(_knownHosts),
  } as vscode.Memento);

  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
  (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('No, use only for this session');
}

/**
 * Set up CredentialService singleton so SSHConnection.buildAuthConfig() can
 * resolve the password without prompting the user.
 */
function setupCredentialService(password: string = SSH_PASS): void {
  (CredentialService as any)._instance = undefined;
  (CredentialService as any)._instance = {
    getCredentialSecret: jest.fn().mockResolvedValue(password),
    getOrPrompt: jest.fn().mockResolvedValue(password),
    deleteAll: jest.fn(),
    setSessionCredential: jest.fn(),
    initialize: jest.fn(),
  };
}

/**
 * Create and connect an SSHConnection to the Docker server.
 */
async function makeConnection(
  overrides: Partial<IHostConfig> = {}
): Promise<SSHConnection> {
  const host: IHostConfig = {
    id: 'e2e-sem-test',
    name: 'Docker-SSH-Test',
    host: SSH_HOST,
    port: SSH_PORT,
    username: SSH_USER,
    source: 'saved',
    ...overrides,
  };
  const cred: SavedCredential = {
    id: 'e2e-sem-cred',
    label: 'pw',
    type: 'password',
  };
  const conn = new SSHConnection(host, cred);
  await conn.connect();
  return conn;
}

/**
 * Safely disconnect a connection, ignoring errors (connection may already be gone).
 */
async function safeDisconnect(conn: SSHConnection): Promise<void> {
  try {
    await conn.disconnect();
  } catch {
    // Ignore — connection may already be dead
  }
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('Channel semaphore E2E', () => {
  let dockerAvailable = false;

  beforeAll(async () => {
    setupVscodeMocks();
    dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      console.warn('Docker SSH server not available — skipping channel-semaphore e2e tests.');
      console.warn('Start with: docker compose -f test/e2e/docker-compose.yml up -d');
    }
  }, 10_000);

  beforeEach(() => {
    // Reset singletons so each test gets a fresh CommandGuard (fresh semaphore map)
    (CommandGuard as any)._instance = undefined;
    (ActivityService as any)._instance = undefined;
    setupCredentialService();
  });

  /** Helper: skip wrapper (matches cross-server-search pattern) */
  function skipIfNoDocker(): boolean {
    return !dockerAvailable;
  }

  // ─── Scenario A: Terminal waits for slot and opens once a search slot frees ──

  it('Scenario A: shell waits in queue while slots are full, resolves when a slot frees', async () => {
    if (skipIfNoDocker()) { return; }

    const conn = await makeConnection();
    const guard = CommandGuard.getInstance();
    const sem: ChannelSemaphore = (guard as any).getSemaphore(conn.id);

    // Force a tiny slot budget so the test runs fast
    (sem as any)._maxSlots = 2;
    (sem as any)._initialMax = 2;

    try {
      // Hold both slots with real commands that run for 2 seconds.
      // Do NOT await — let them run in background while we test queuing.
      const hold1 = guard.exec(conn, 'sleep 2');
      const hold2 = guard.exec(conn, 'sleep 2');

      // Give the SSH execs one event-loop tick to acquire their slots before we
      // attempt to open a shell.
      await new Promise<void>(r => setImmediate(r));

      // Both slots should now be taken
      expect(sem.activeCount).toBe(2);

      // Opening a shell must queue (no slot available)
      const shellStart = Date.now();
      const shellPromise = guard.openShell(conn);

      // Verify it is actually waiting (not resolved immediately)
      expect(sem.queued).toBe(1);

      // Wait for both sleeps to complete → slots freed → shell should resolve
      const [channel] = await Promise.all([shellPromise, hold1, hold2]);

      const waited = Date.now() - shellStart;
      // Shell should have had to wait (> 500 ms — the sleep commands run for 2 s)
      expect(waited).toBeGreaterThan(500);

      // Close the shell channel to release the slot
      channel.end();

      // Verify no slot leak (allow time for the channel-close event to propagate)
      await new Promise(r => setTimeout(r, 100));
      expect(sem.activeCount).toBe(0);

    } finally {
      await safeDisconnect(conn);
    }
  }, 15_000);

  // ─── Scenario B: Search queue drains and adaptive recovery after failures ────

  it('Scenario B: search queue drains and adaptive recovery after failures', async () => {
    if (!dockerAvailable) { return; }
    const guard = CommandGuard.getInstance();
    const conn = await makeConnection();
    const sem = (guard as any).getSemaphore(conn.id);

    try {
      // Part 1: verify queue drains with limited concurrency
      (sem as any)._maxSlots = 2;
      (sem as any)._initialMax = 2;
      const results = await Promise.all(
        Array.from({ length: 5 }, () => guard.exec(conn, 'echo ok'))
      );
      expect(results.every((r: string) => r.includes('ok'))).toBe(true);
      expect(sem.activeCount).toBe(0);

      // Part 2: verify adaptive recovery — reduceMax then 5 successes → increaseMax
      const maxBefore = sem.maxSlots;
      sem.reduceMax(); // simulate a prior failure
      expect(sem.maxSlots).toBe(maxBefore - 1);
      for (let i = 0; i < 5; i++) {
        await guard.exec(conn, 'echo recover');
      }
      expect(sem.maxSlots).toBe(maxBefore); // recovered back
      expect(sem.activeCount).toBe(0);
    } finally {
      await safeDisconnect(conn);
    }
  }, 30_000);

  // ─── Scenario C: Server A saturation does not block server B ─────────────────

  it('Scenario C: saturating connA semaphore does not block connB', async () => {
    if (skipIfNoDocker()) { return; }

    // Two independent SSHConnections — each gets its own ChannelSemaphore because
    // semaphores are keyed by connection.id (host:port:username).
    // SSHConnection.id is computed as "host:port:username" in the constructor, so both
    // connections would share the same semaphore by default. Override id after connect
    // to force CommandGuard to treat them as distinct servers.
    const connA = await makeConnection({ id: 'e2e-sem-A', name: 'Docker-A' });
    Object.defineProperty(connA, 'id', { get: () => 'e2e-semA:2222:testuser', configurable: true });

    const connB = await makeConnection({ id: 'e2e-sem-B', name: 'Docker-B' });
    Object.defineProperty(connB, 'id', { get: () => 'e2e-semB:2222:testuser', configurable: true });

    const guard = CommandGuard.getInstance();

    const semA: ChannelSemaphore = (guard as any).getSemaphore(connA.id);
    const semB: ChannelSemaphore = (guard as any).getSemaphore(connB.id);

    // Force A to single slot
    (semA as any)._maxSlots = 1;
    (semA as any)._initialMax = 1;

    try {
      // Saturate A with a long-running command (don't await)
      const holdA = guard.exec(connA, 'sleep 5');

      // Give A a tick to acquire its slot
      await new Promise<void>(r => setImmediate(r));
      expect(semA.activeCount).toBe(1);

      // B should be completely unaffected — must complete quickly
      const start = Date.now();
      const resultB = await guard.exec(connB, 'echo hello');
      const elapsed = Date.now() - start;

      expect(resultB.trim()).toBe('hello');
      // Should complete well within 3 seconds (not blocked by A's 5-second sleep)
      expect(elapsed).toBeLessThan(3_000);

      // Semaphore B must be idle
      expect(semB.activeCount).toBe(0);

      // Let A finish to avoid orphaned SSH processes
      await holdA;

    } finally {
      await Promise.all([safeDisconnect(connA), safeDisconnect(connB)]);
    }
  }, 20_000);

  // ─── Scenario D: Per-user isolation (same host, different SSHConnection IDs) ─

  it('Scenario D: two connections with distinct IDs have independent semaphores', async () => {
    if (skipIfNoDocker()) { return; }

    // SSHConnection.id is computed as "host:port:username" — both connections would
    // share the same semaphore without the override below.  Override id after connect
    // so CommandGuard creates independent ChannelSemaphore instances for each.
    const conn1 = await makeConnection({ id: 'e2e-user-alice', name: 'Alice-Conn' });
    Object.defineProperty(conn1, 'id', { get: () => 'e2e-semC:2222:testuser', configurable: true });

    const conn2 = await makeConnection({ id: 'e2e-user-bob',   name: 'Bob-Conn' });
    Object.defineProperty(conn2, 'id', { get: () => 'e2e-semD:2222:testuser', configurable: true });

    const guard = CommandGuard.getInstance();
    const sem1: ChannelSemaphore = (guard as any).getSemaphore(conn1.id);
    const sem2: ChannelSemaphore = (guard as any).getSemaphore(conn2.id);

    // Different semaphore objects (keyed by different IDs)
    expect(sem1).not.toBe(sem2);

    // Saturate conn1 to a single slot
    (sem1 as any)._maxSlots = 1;
    (sem1 as any)._initialMax = 1;

    try {
      const holdConn1 = guard.exec(conn1, 'sleep 5');

      await new Promise<void>(r => setImmediate(r));
      expect(sem1.activeCount).toBe(1);

      // conn2 must proceed immediately despite conn1 being saturated
      const result = await guard.exec(conn2, 'echo isolated');
      expect(result.trim()).toBe('isolated');
      expect(sem2.activeCount).toBe(0);

      await holdConn1;
      expect(sem1.activeCount).toBe(0);

    } finally {
      await Promise.all([safeDisconnect(conn1), safeDisconnect(conn2)]);
    }
  }, 20_000);

  // ─── Scenario E: removeSemaphore rejects all queued waiters with 'Connection closed' ─

  it('Scenario E: queued exec rejects with "Connection closed" after removeSemaphore', async () => {
    if (skipIfNoDocker()) { return; }

    const conn = await makeConnection();
    const guard = CommandGuard.getInstance();
    const sem: ChannelSemaphore = (guard as any).getSemaphore(conn.id);

    // Single slot — easy to saturate
    (sem as any)._maxSlots = 1;
    (sem as any)._initialMax = 1;

    try {
      // Hold the only slot with a long-running command
      const holdSlot = guard.exec(conn, 'sleep 10');

      // Give the hold command one tick to acquire the slot
      await new Promise<void>(r => setImmediate(r));
      expect(sem.activeCount).toBe(1);

      // Queue a second exec — it must wait
      const queuedExec = guard.exec(conn, 'echo should-not-run');
      expect(sem.queued).toBe(1);

      // Simulate disconnect: destroy the semaphore so queued waiters get rejected
      guard.removeSemaphore(conn.id);

      // The queued exec must reject with 'Connection closed'
      await expect(queuedExec).rejects.toThrow('Connection closed');

      // Clean up the hold (it will also error once connection is dropped)
      try { await holdSlot; } catch { /* expected */ }

    } finally {
      await safeDisconnect(conn);
    }
  }, 15_000);
});
