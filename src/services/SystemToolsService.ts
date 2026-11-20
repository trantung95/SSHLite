import * as vscode from 'vscode';
import { SSHConnection } from '../connection/SSHConnection';
import { assertCapability } from '../utils/capabilityGuard';
import { CredentialService } from './CredentialService';
import { infoLog } from '../utils/diagnosticLog';

/** Thrown when the user dismisses the sudo password prompt. Callers should treat it as a silent cancel. */
export class SudoCancelledError extends Error {
  constructor() {
    super('Sudo cancelled: no password provided');
    this.name = 'SudoCancelledError';
  }
}

function isSudoAuthFailure(err: unknown): boolean {
  return /incorrect password/i.test((err as Error)?.message ?? '');
}

export interface ProcessEntry {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

export interface ServiceEntry {
  name: string;
  load: string;
  active: string;
  sub: string;
  description: string;
}

/**
 * System-level actions layered on top of `ServerMonitorService`'s read-only
 * displays: interactive process kill and systemctl start/stop/restart.
 */
export class SystemToolsService {
  private static _instance: SystemToolsService;

  private constructor() {}

  static getInstance(): SystemToolsService {
    if (!SystemToolsService._instance) {
      SystemToolsService._instance = new SystemToolsService();
    }
    return SystemToolsService._instance;
  }

  parseProcessOutput(output: string): ProcessEntry[] {
    const rawLines = output.trim().split('\n');
    if (rawLines.length < 2) { return []; }
    const headerLine = rawLines[0].trim().toLowerCase();
    const dataLines = rawLines.slice(1);
    const entries: ProcessEntry[] = [];

    // Detect format by checking header:
    // GNU ps -eo:       "  PID USER %CPU %MEM COMMAND"  → pid first, 5+ cols with cpu/mem
    // GNU ps aux Linux: "USER         PID %CPU ..."     → user first, cpu at col 2
    // busybox ps aux:   "PID   USER     TIME  COMMAND"  → pid first, no cpu/mem (TIME at col 2)
    const userFirst = headerLine.startsWith('user');
    const isBusybox = !userFirst && (headerLine.includes('time') && !headerLine.includes('%cpu') && !headerLine.includes('pcpu'));

    for (const line of dataLines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) { continue; }

      let pid: number;
      let user: string;
      let cpu = 0;
      let mem = 0;
      let command: string;

      if (userFirst) {
        // GNU ps aux: USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
        user = parts[0];
        pid = Number(parts[1]);
        cpu = parseFloat(parts[2]) || 0;
        mem = parseFloat(parts[3]) || 0;
        command = parts.slice(10).join(' ') || parts[parts.length - 1];
      } else if (isBusybox) {
        // busybox ps aux: PID USER TIME COMMAND (no cpu/mem)
        pid = Number(parts[0]);
        user = parts[1];
        // skip TIME at parts[2], command starts at parts[3]
        command = parts.slice(3).join(' ') || parts[2];
      } else {
        // GNU ps -eo: PID USER %CPU %MEM COMMAND
        pid = Number(parts[0]);
        user = parts[1];
        cpu = parseFloat(parts[2]) || 0;
        mem = parseFloat(parts[3]) || 0;
        command = parts.slice(4).join(' ');
      }

      if (!Number.isFinite(pid) || pid <= 0) { continue; }
      entries.push({ pid, user, cpu, mem, command });
    }
    return entries;
  }

  parseServiceOutput(output: string): ServiceEntry[] {
    const entries: ServiceEntry[] = [];
    for (const raw of output.split('\n')) {
      const parts = raw.trim().split(/\s+/);
      if (parts.length < 4) { continue; }
      if (!parts[0].endsWith('.service')) { continue; }
      entries.push({
        name: parts[0],
        load: parts[1],
        active: parts[2],
        sub: parts[3],
        description: parts.slice(4).join(' '),
      });
    }
    return entries;
  }

  async listProcesses(connection: SSHConnection, limit = 100): Promise<ProcessEntry[]> {
    assertCapability(connection, 'supportsExec');
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 5000));
    // Try GNU ps with cpu/mem first; capture exit code separately so || fallback works correctly.
    // Busybox ps does not support %cpu/%mem columns, so we fall back to ps aux.
    const cmd = `{ ps -eo pid,user,%cpu,%mem,comm 2>/dev/null && true || ps aux 2>/dev/null; } | head -${safeLimit + 1}`;
    const out = await connection.exec(cmd);
    return this.parseProcessOutput(out);
  }

  async listServices(connection: SSHConnection): Promise<ServiceEntry[]> {
    assertCapability(connection, 'supportsExec');
    const out = await connection.exec(
      'systemctl list-units --type=service --no-pager --plain --state=loaded 2>/dev/null || true'
    );
    return this.parseServiceOutput(out);
  }

  async killProcess(connection: SSHConnection, pid: number, useSudo: boolean, signal: string = 'TERM'): Promise<void> {
    assertCapability(connection, 'supportsExec');
    if (!Number.isFinite(pid) || pid <= 0 || pid > 2 ** 22) {
      throw new Error(`Invalid PID: ${pid}`);
    }
    if (!/^[A-Z0-9]+$/.test(signal)) {
      throw new Error(`Invalid signal: ${signal}`);
    }
    const cmd = `kill -${signal} ${pid}`;
    if (useSudo) {
      await this.sudoWithPassword(connection, (pw) => connection.sudoExec(cmd, pw));
    } else {
      await connection.exec(cmd);
    }
  }

  async runServiceAction(
    connection: SSHConnection,
    serviceName: string,
    action: 'status' | 'start' | 'stop' | 'restart',
    useSudo: boolean
  ): Promise<string> {
    assertCapability(connection, 'supportsExec');
    if (!/^[a-zA-Z0-9@._\-:]+$/.test(serviceName)) {
      throw new Error(`Invalid service name: ${serviceName}`);
    }
    const cmd = `systemctl ${action} ${serviceName}`;
    if (useSudo) {
      return this.sudoWithPassword(connection, (pw) => connection.sudoExec(cmd, pw));
    }
    return connection.exec(cmd);
  }

  /**
   * Run a sudo operation, obtaining the password the same way file saves do:
   * "Sudo All" password, then the per-host cache, else try without a password
   * first (NOPASSWD / cached sudo timestamp need no prompt), and only prompt
   * when sudo reports an authentication failure. A wrong password clears the
   * cache and is re-prompted once. The password is never logged.
   */
  private async sudoWithPassword<T>(connection: SSHConnection, op: (password: string) => Promise<T>): Promise<T> {
    const credService = CredentialService.getInstance();
    const hostId = connection.host.id;
    const host = connection.host.name;

    let known: string | null = connection.sudoPassword || credService.getSudoPasswordCached(hostId) || null;
    let prompted = false;
    if (!known) {
      // Probe with `sudo -n` (never reads a password) instead of sending an
      // empty one: sudo counts an empty password as a failed attempt in
      // auth.log and pam_faillock, so probing that way could lock the account.
      const probe = await connection.exec('sudo -n true 2>/dev/null && echo SSHLITE_NOPASSWD || echo SSHLITE_NEEDPW').catch(() => '');
      if (!probe.includes('SSHLITE_NOPASSWD')) {
        infoLog('system-tools', 'sudo/auth-needed', { host, hadPassword: false, reason: 'probe' });
        const entered = await credService.promptSudoPassword(host);
        if (!entered) { throw new SudoCancelledError(); }
        prompted = true;
        known = entered;
        if (vscode.workspace.getConfiguration('sshLite').get<boolean>('cacheSudoPassword', false)) {
          credService.cacheSudoPassword(hostId, entered);
        }
      }
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const result = await op(known ?? '');
        infoLog('system-tools', 'sudo/ok', { host, prompted });
        return result;
      } catch (err) {
        if (!isSudoAuthFailure(err)) { throw err; }
        if (known) { credService.clearSudoPassword(hostId); }
        if (prompted && attempt >= 2) { throw err; }
        infoLog('system-tools', 'sudo/auth-needed', { host, hadPassword: !!known });
        const entered = await credService.promptSudoPassword(host);
        if (!entered) { throw new SudoCancelledError(); }
        prompted = true;
        known = entered;
        if (vscode.workspace.getConfiguration('sshLite').get<boolean>('cacheSudoPassword', false)) {
          credService.cacheSudoPassword(hostId, entered);
        }
      }
    }
    throw new Error('Sudo authentication failed: incorrect password');
  }
}
