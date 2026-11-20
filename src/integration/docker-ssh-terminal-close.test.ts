/**
 * Docker integration test: closing an SSH terminal must close its shell channel.
 *
 * Bug found by the e2e suite (channel-semaphore.e2e.ts Scenario A): the
 * pseudoterminal close handler called only `shell.end()`. That sends channel EOF,
 * but with a PTY sshd keeps the shell running, so the channel never emits
 * 'close'. Every closed terminal then
 *   - kept its CommandGuard semaphore slot forever (enough open/close cycles and
 *     terminals, searches and exec calls queue until they time out), and
 *   - left a bash process holding a /dev/pts entry on the server.
 * The fix closes the channel (`end()` + `close()`), which makes sshd hang up the
 * shell with SIGHUP.
 *
 * Drives the real TerminalService pseudoterminal and CommandGuard.openShell
 * against a real sshd (2202), and counts PTYs inside the container.
 *
 * Run: npm run test:docker
 */

import { execSync } from 'child_process';
import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { CommandGuard } from '../services/CommandGuard';
import { ActivityService } from '../services/ActivityService';
import { TerminalService } from '../services/TerminalService';
import { ChannelSemaphore } from '../services/ChannelSemaphore';
import { CredentialService, SavedCredential } from '../services/CredentialService';
import { IHostConfig } from '../types';

const CONTAINER = 'hybr8-prod-api-01';
const SERVER = { id: 'term-close', host: '127.0.0.1', port: 2202, username: 'testuser', password: 'testpass' };

const _knownHosts: Record<string, unknown> = {};

function setupMocks(): void {
  setGlobalState({
    get: <T>(key: string, def?: T) => (_knownHosts[key] as T) ?? (def as T),
    update: async (k: string, v: unknown) => { _knownHosts[k] = v; },
    keys: () => Object.keys(_knownHosts),
  } as vscode.Memento);
  (CredentialService as any)._instance = {
    getCredentialSecret: jest.fn().mockResolvedValue(SERVER.password),
    getOrPrompt: jest.fn().mockResolvedValue(SERVER.password),
    initialize: jest.fn(),
  };
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
}

async function connect(): Promise<SSHConnection> {
  const host: IHostConfig = { id: SERVER.id, name: 'api', host: SERVER.host, port: SERVER.port, username: SERVER.username, source: 'saved' };
  const cred: SavedCredential = { id: SERVER.id + '-pw', label: 'pw', type: 'password' };
  const c = new SSHConnection(host, cred);
  await c.connect();
  return c;
}

/** Number of PTYs allocated inside the container (one per live interactive shell). */
function ptyCount(): number {
  const out = execSync(`docker exec ${CONTAINER} sh -c "ls /dev/pts | grep -c '^[0-9]' || true"`, { stdio: 'pipe' }).toString().trim();
  return parseInt(out, 10) || 0;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) { return true; }
    await new Promise((r) => setTimeout(r, 100));
  }
  return cond();
}

/** Open a terminal through the real command path and return its pseudoterminal. */
async function openTerminal(conn: SSHConnection): Promise<{ pty: vscode.Pseudoterminal; channel: any }> {
  let pty: vscode.Pseudoterminal | undefined;
  (vscode.window.createTerminal as jest.Mock).mockImplementationOnce((opts: { pty: vscode.Pseudoterminal }) => {
    pty = opts.pty;
    return { show: jest.fn(), dispose: jest.fn(), sendText: jest.fn() };
  });
  const channel = await CommandGuard.getInstance().openShell(conn, { term: 'xterm' });
  await TerminalService.getInstance().createTerminal(conn, channel);
  pty!.open({ rows: 24, columns: 80 });
  return { pty: pty!, channel };
}

describe('Docker: closing a terminal closes its SSH shell (semaphore slot + remote PTY)', () => {
  let conn: SSHConnection;
  let sem: ChannelSemaphore;

  beforeAll(() => { setupMocks(); });

  beforeEach(async () => {
    (CommandGuard as any)._instance = undefined;
    (ActivityService as any)._instance = undefined;
    (TerminalService as any)._instance = undefined;
    conn = await connect();
    sem = (CommandGuard.getInstance() as any).getSemaphore(conn.id);
  });

  afterEach(async () => {
    try { await conn.disconnect(); } catch { /* ignore */ }
  });

  it('closing one terminal releases its slot and hangs up the remote shell', async () => {
    const before = ptyCount();
    const { pty, channel } = await openTerminal(conn);
    expect(sem.activeCount).toBe(1);
    expect(await waitFor(() => ptyCount() === before + 1, 3000)).toBe(true);

    const closed = new Promise<void>((r) => channel.once('close', () => r()));
    pty.close();
    await closed;

    expect(sem.activeCount).toBe(0);
    expect(TerminalService.getInstance().getTerminalCount(conn.id)).toBe(0);
    expect(await waitFor(() => ptyCount() === before, 3000)).toBe(true);
  }, 20000);

  it('opening and closing more terminals than there are slots never blocks', async () => {
    // Before the fix, slot N+1 waited for SHELL_TIMEOUT_MS and failed.
    (sem as any)._maxSlots = 2;
    (sem as any)._initialMax = 2;
    const before = ptyCount();

    for (let i = 0; i < 5; i++) {
      const { pty, channel } = await openTerminal(conn);
      const closed = new Promise<void>((r) => channel.once('close', () => r()));
      pty.close();
      await closed;
    }

    expect(sem.activeCount).toBe(0);
    expect(sem.queued).toBe(0);
    expect(await waitFor(() => ptyCount() === before, 3000)).toBe(true);
  }, 30000);
});
