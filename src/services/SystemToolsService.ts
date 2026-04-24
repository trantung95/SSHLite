import { SSHConnection } from '../connection/SSHConnection';

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
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 5000));
    // Try GNU ps with cpu/mem first; capture exit code separately so || fallback works correctly.
    // Busybox ps does not support %cpu/%mem columns, so we fall back to ps aux.
    const cmd = `{ ps -eo pid,user,%cpu,%mem,comm 2>/dev/null && true || ps aux 2>/dev/null; } | head -${safeLimit + 1}`;
    const out = await connection.exec(cmd);
    return this.parseProcessOutput(out);
  }

  async listServices(connection: SSHConnection): Promise<ServiceEntry[]> {
    const out = await connection.exec(
      'systemctl list-units --type=service --no-pager --plain --state=loaded 2>/dev/null || true'
    );
    return this.parseServiceOutput(out);
  }

  async killProcess(connection: SSHConnection, pid: number, useSudo: boolean, signal: string = 'TERM'): Promise<void> {
    if (!Number.isFinite(pid) || pid <= 0 || pid > 2 ** 22) {
      throw new Error(`Invalid PID: ${pid}`);
    }
    if (!/^[A-Z0-9]+$/.test(signal)) {
      throw new Error(`Invalid signal: ${signal}`);
    }
    const cmd = `kill -${signal} ${pid}`;
    if (useSudo) {
      await connection.sudoExec(cmd, connection.sudoPassword || '');
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
    if (!/^[a-zA-Z0-9@._\-:]+$/.test(serviceName)) {
      throw new Error(`Invalid service name: ${serviceName}`);
    }
    const cmd = `systemctl ${action} ${serviceName}`;
    if (useSudo) {
      return connection.sudoExec(cmd, connection.sudoPassword || '');
    }
    return connection.exec(cmd);
  }
}
