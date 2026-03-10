/**
 * Chaos Bug Discovery Module - Container Health Monitor
 *
 * Monitors Docker containers in real-time during chaos test runs.
 * Detects dead/exited containers immediately, collects logs, and
 * auto-analyzes the cause of death.
 *
 * Uses async child_process.exec to avoid blocking the Node.js event loop
 * during polling cycles.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { ChaosServerConfig } from './ChaosConfig';

const execAsync = promisify(exec);

/** Maps server labels to their Docker container names */
const SERVER_CONTAINER_MAP: Record<string, string> = {
  // Basic servers (docker-compose.yml)
  'prod-server': 'sshlite-test-server-1',
  'staging-server': 'sshlite-test-server-2',
  'dev-server': 'sshlite-test-server-3',
  // Multi-OS servers (docker-compose.multios.yml)
  'alpine-server': 'sshlite-os-alpine',
  'ubuntu-server': 'sshlite-os-ubuntu',
  'debian-server': 'sshlite-os-debian',
  'fedora-server': 'sshlite-os-fedora',
  'rocky-server': 'sshlite-os-rocky',
};

export interface ContainerStatus {
  name: string;
  serverLabel: string;
  status: 'running' | 'exited' | 'dead' | 'not_found' | 'error';
  exitCode?: number;
  startedAt?: string;
  finishedAt?: string;
  restartCount?: number;
}

export interface ContainerDeathEvent {
  timestamp: number;
  container: string;
  serverLabel: string;
  exitCode: number;
  lastLogs: string;
  analysis: string;
}

export interface ContainerHealthReport {
  monitored: number;
  healthy: number;
  dead: number;
  deaths: ContainerDeathEvent[];
  containerStatuses: ContainerStatus[];
}

export class ContainerHealthMonitor {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private deaths: ContainerDeathEvent[] = [];
  private monitoredContainers: Map<string, string> = new Map(); // serverLabel -> containerName
  private pollIntervalMs: number;
  private onDeathCallback?: (event: ContainerDeathEvent) => void;
  private lastKnownStatuses: Map<string, string> = new Map(); // containerName -> status
  private checking = false; // Guard against overlapping poll cycles
  private stopped = false; // Guard against double stop() calls

  constructor(servers: ChaosServerConfig[], pollIntervalMs = 5000) {
    this.pollIntervalMs = pollIntervalMs;
    for (const server of servers) {
      const containerName = SERVER_CONTAINER_MAP[server.label];
      if (containerName) {
        this.monitoredContainers.set(server.label, containerName);
      }
    }
  }

  /**
   * Register a callback that fires immediately when a container death is detected.
   */
  onDeath(callback: (event: ContainerDeathEvent) => void): void {
    this.onDeathCallback = callback;
  }

  /**
   * Start real-time monitoring. Polls container status at the configured interval.
   */
  start(): void {
    if (this.pollInterval) return;
    this.stopped = false;

    // Initial async check (fire and forget)
    this.checkAll();

    this.pollInterval = setInterval(() => {
      this.checkAll();
    }, this.pollIntervalMs);

    console.log(`[ContainerHealth] Monitoring ${this.monitoredContainers.size} containers (poll: ${this.pollIntervalMs}ms)`);
  }

  /**
   * Stop monitoring and return the health report.
   * Safe to call multiple times — second call returns cached last-known statuses.
   */
  stop(): ContainerHealthReport {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // On second call, return report from cached statuses without re-querying Docker
    if (this.stopped) {
      return this.buildReportFromCache();
    }
    this.stopped = true;

    // Build report from last known statuses (no new Docker calls needed)
    return this.buildReportFromCache();
  }

  /**
   * Build health report from cached last-known statuses.
   */
  private buildReportFromCache(): ContainerHealthReport {
    const statuses: ContainerStatus[] = [];
    for (const [serverLabel, containerName] of this.monitoredContainers) {
      const cachedStatus = this.lastKnownStatuses.get(containerName) || 'error';
      statuses.push({
        name: containerName,
        serverLabel,
        status: cachedStatus as ContainerStatus['status'],
      });
    }

    const healthy = statuses.filter(s => s.status === 'running').length;
    const dead = statuses.filter(s => s.status !== 'running').length;

    return {
      monitored: statuses.length,
      healthy,
      dead,
      deaths: this.deaths,
      containerStatuses: statuses,
    };
  }

  /**
   * Check all monitored containers and detect new deaths.
   * Async — does not block the event loop.
   */
  private async checkAll(): Promise<void> {
    // Guard against overlapping poll cycles
    if (this.checking) return;
    this.checking = true;

    try {
      // Parallelize container status checks to avoid serial 5s×N blind spot
      const entries = Array.from(this.monitoredContainers.entries());
      const results = await Promise.all(
        entries.map(async ([serverLabel, containerName]) => ({
          serverLabel,
          containerName,
          status: await this.getContainerStatus(containerName, serverLabel),
        }))
      );

      for (const { serverLabel, containerName, status } of results) {
        const previousStatus = this.lastKnownStatuses.get(containerName);
        this.lastKnownStatuses.set(containerName, status.status);

        // Detect transition from running to dead/exited
        if (status.status !== 'running' && previousStatus === 'running') {
          await this.handleDeath(containerName, serverLabel, status);
        }
        // Catch containers already dead on first check — but only for definitive
        // states ('exited'/'dead'), not transient errors ('error'/'not_found')
        if ((status.status === 'exited' || status.status === 'dead') && previousStatus === undefined) {
          await this.handleDeath(containerName, serverLabel, status);
        }
      }
    } finally {
      this.checking = false;
    }
  }

  /**
   * Handle a detected container death: collect logs, analyze, report.
   */
  private async handleDeath(containerName: string, serverLabel: string, status: ContainerStatus): Promise<void> {
    const lastLogs = await this.getContainerLogs(containerName, 50);
    const analysis = this.analyzeDeath(containerName, serverLabel, status, lastLogs);

    const event: ContainerDeathEvent = {
      timestamp: Date.now(),
      container: containerName,
      serverLabel,
      exitCode: status.exitCode ?? -1,
      lastLogs,
      analysis,
    };

    this.deaths.push(event);

    // Immediate console report
    console.error(`\n${'!'.repeat(70)}`);
    console.error(`  CONTAINER DEAD: ${containerName} (${serverLabel})`);
    console.error(`  Exit code: ${status.exitCode ?? 'unknown'}`);
    console.error(`  Analysis: ${analysis}`);
    console.error(`  Last logs:`);
    for (const line of lastLogs.split('\n').slice(-10)) {
      if (line.trim()) {
        console.error(`    ${line}`);
      }
    }
    console.error(`${'!'.repeat(70)}\n`);

    // Fire callback
    if (this.onDeathCallback) {
      this.onDeathCallback(event);
    }
  }

  /**
   * Get the status of a single Docker container (async).
   */
  private async getContainerStatus(containerName: string, serverLabel: string): Promise<ContainerStatus> {
    try {
      const { stdout } = await execAsync(
        `docker inspect --format "{{json .State}}" ${containerName}`,
        { timeout: 5000 }
      );

      const state = JSON.parse(stdout.trim());

      let status: ContainerStatus['status'] = 'running';
      if (state.Status === 'exited') status = 'exited';
      else if (state.Status === 'dead') status = 'dead';
      else if (state.Running === false) status = 'exited';

      return {
        name: containerName,
        serverLabel,
        status,
        exitCode: state.ExitCode,
        startedAt: state.StartedAt,
        finishedAt: state.FinishedAt,
        restartCount: state.RestartCount,
      };
    } catch (err) {
      const message = (err as Error).message || '';
      if (message.includes('No such object') || message.includes('not found')) {
        return { name: containerName, serverLabel, status: 'not_found' };
      }
      return { name: containerName, serverLabel, status: 'error' };
    }
  }

  /**
   * Get container logs. If tailLines is provided, returns last N lines; otherwise returns all logs.
   */
  private async getContainerLogs(containerName: string, tailLines?: number): Promise<string> {
    try {
      const tailArg = tailLines ? `--tail ${tailLines}` : '';
      const { stdout, stderr } = await execAsync(
        `docker logs ${tailArg} ${containerName}`,
        { timeout: 10000 }
      );
      return (stdout + stderr).trim();
    } catch {
      return '(failed to retrieve container logs)';
    }
  }

  /**
   * Collect all logs from a specific server's container.
   * Used for per-scenario log snapshots.
   */
  async collectLogsForServer(serverLabel: string): Promise<string> {
    const containerName = this.monitoredContainers.get(serverLabel);
    if (!containerName) return '(unknown container)';
    return this.getContainerLogs(containerName);
  }

  /**
   * Collect all logs from ALL monitored containers.
   * Returns a map of serverLabel -> full logs.
   */
  async collectAllLogs(): Promise<Map<string, string>> {
    const results = new Map<string, string>();
    const entries = Array.from(this.monitoredContainers.entries());
    const logs = await Promise.all(
      entries.map(async ([serverLabel, containerName]) => ({
        serverLabel,
        logs: await this.getContainerLogs(containerName),
      }))
    );
    for (const { serverLabel, logs: log } of logs) {
      results.set(serverLabel, log);
    }
    return results;
  }

  /**
   * Auto-analyze why a container died based on exit code and logs.
   */
  private analyzeDeath(
    _containerName: string,
    _serverLabel: string,
    status: ContainerStatus,
    logs: string
  ): string {
    const reasons: string[] = [];
    const exitCode = status.exitCode ?? -1;

    // Exit code analysis
    if (exitCode === 137) {
      reasons.push('OOM killed or received SIGKILL (exit 137) — container ran out of memory or was force-stopped');
    } else if (exitCode === 139) {
      reasons.push('Segfault (exit 139) — process crashed with SIGSEGV');
    } else if (exitCode === 143) {
      reasons.push('Graceful shutdown via SIGTERM (exit 143) — container was stopped externally');
    } else if (exitCode === 1) {
      reasons.push('Process error (exit 1) — sshd or entrypoint script failed');
    } else if (exitCode === 126) {
      reasons.push('Command not executable (exit 126) — permission or binary format issue');
    } else if (exitCode === 127) {
      reasons.push('Command not found (exit 127) — missing binary in container image');
    } else if (exitCode === 0) {
      reasons.push('Clean exit (exit 0) — process finished normally (unexpected for long-running sshd)');
    } else {
      reasons.push(`Unknown exit code ${exitCode}`);
    }

    // Log pattern analysis
    const logLower = logs.toLowerCase();
    if (logLower.includes('out of memory') || logLower.includes('oom')) {
      reasons.push('Log indicates OOM condition');
    }
    if (logLower.includes('segfault') || logLower.includes('segmentation fault')) {
      reasons.push('Log indicates segmentation fault');
    }
    if (logLower.includes('no space left on device')) {
      reasons.push('Log indicates disk full — too many chaos test files not cleaned up');
    }
    if (logLower.includes('too many open files') || logLower.includes('emfile')) {
      reasons.push('Log indicates file descriptor exhaustion — too many concurrent SSH channels');
    }
    if (logLower.includes('maxsessions') || logLower.includes('max sessions')) {
      reasons.push('Log indicates SSH max sessions exceeded');
    }
    if (logLower.includes('address already in use')) {
      reasons.push('Log indicates port conflict');
    }
    if (logLower.includes('fatal') || logLower.includes('panic')) {
      reasons.push('Log contains fatal/panic error');
    }

    // Chaos-specific analysis
    if (reasons.some(r => r.includes('OOM') || r.includes('memory'))) {
      reasons.push('CHAOS LIKELY CAUSE: Too many concurrent SSH connections or large file operations exhausted container memory');
    }
    if (reasons.some(r => r.includes('file descriptor'))) {
      reasons.push('CHAOS LIKELY CAUSE: Rapid scenario execution opened too many SSH channels without proper cleanup');
    }

    return reasons.join('; ');
  }

  /**
   * Pre-flight check: verify all containers are running before chaos starts.
   * Returns list of non-running containers. Synchronous wrapper for pre-run use.
   */
  async preFlightCheck(): Promise<ContainerStatus[]> {
    const statuses: ContainerStatus[] = [];
    for (const [serverLabel, containerName] of this.monitoredContainers) {
      statuses.push(await this.getContainerStatus(containerName, serverLabel));
    }
    // Populate lastKnownStatuses from pre-flight
    for (const s of statuses) {
      this.lastKnownStatuses.set(s.name, s.status);
    }
    return statuses.filter(s => s.status !== 'running');
  }
}
