/**
 * Jest Global Setup for Chaos Bug Discovery Tests
 *
 * Starts BOTH basic (ports 2201-2203) AND multi-OS (ports 2210-2214) containers.
 * All 8 servers are needed for chaos testing across multiple OS and server configs.
 */

import { execSync } from 'child_process';
import { Client } from 'ssh2';
import * as fs from 'fs';
import * as path from 'path';

const BASIC_COMPOSE = path.join(__dirname, 'docker-compose.yml');
const MULTIOS_COMPOSE = path.join(__dirname, 'docker-compose.multios.yml');

const ALL_SERVERS = [
  // Basic servers (Alpine)
  { host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass', label: 'basic-1' },
  { host: '127.0.0.1', port: 2202, username: 'testuser', password: 'testpass', label: 'basic-2' },
  { host: '127.0.0.1', port: 2203, username: 'admin', password: 'adminpass', label: 'basic-3' },
  // Multi-OS servers
  { host: '127.0.0.1', port: 2210, username: 'testuser', password: 'testpass', label: 'alpine' },
  { host: '127.0.0.1', port: 2211, username: 'testuser', password: 'testpass', label: 'ubuntu' },
  { host: '127.0.0.1', port: 2212, username: 'testuser', password: 'testpass', label: 'debian' },
  { host: '127.0.0.1', port: 2213, username: 'testuser', password: 'testpass', label: 'fedora' },
  { host: '127.0.0.1', port: 2214, username: 'testuser', password: 'testpass', label: 'rocky' },
];

function tryConnect(config: typeof ALL_SERVERS[0]): Promise<boolean> {
  return new Promise((resolve) => {
    const client = new Client();
    const timeout = setTimeout(() => {
      client.end();
      resolve(false);
    }, 3000);

    client.on('ready', () => {
      clearTimeout(timeout);
      client.end();
      resolve(true);
    });
    client.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });

    client.connect({
      host: config.host,
      port: config.port,
      username: config.username,
      password: config.password,
      readyTimeout: 3000,
    });
  });
}

async function waitForSSH(config: typeof ALL_SERVERS[0], maxRetries = 40, delayMs = 1500): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const ok = await tryConnect(config);
    if (ok) {
      return;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`SSH not available on ${config.label} (${config.host}:${config.port}) after ${maxRetries} retries`);
}

function startCompose(composeFile: string, label: string): void {
  try {
    // Get the services defined in THIS compose file, then check if they're running.
    // Both compose files share the same project dir ("test-docker"), so a plain
    // `docker compose ps` returns containers from ALL stacks — we must filter by service.
    const services = execSync(`docker compose -f "${composeFile}" config --services`, {
      stdio: 'pipe',
      timeout: 10000,
    }).toString().trim().split('\n').filter(Boolean);

    if (services.length > 0) {
      const ps = execSync(
        `docker compose -f "${composeFile}" ps --status running --format "{{.Service}}"`,
        { stdio: 'pipe', timeout: 10000 }
      ).toString().trim().split('\n').filter(Boolean);

      const runningServices = new Set(ps);
      const allRunning = services.every(s => runningServices.has(s));
      if (allRunning) {
        console.log(`[Chaos Setup] ${label} containers already running, skipping start`);
        return;
      }
    }
  } catch {
    // Containers not running, start them
  }

  execSync(`docker compose -f "${composeFile}" up -d --build`, {
    stdio: 'pipe',
    timeout: 300000,
  });
}

/**
 * Stop only sshlite chaos test containers by name.
 * Uses `docker stop` + `docker rm` with exact container names — never touches
 * containers from other projects or compose stacks.
 */
const CHAOS_CONTAINERS = [
  'sshlite-test-server-1',
  'sshlite-test-server-2',
  'sshlite-test-server-3',
  'sshlite-os-alpine',
  'sshlite-os-ubuntu',
  'sshlite-os-debian',
  'sshlite-os-fedora',
  'sshlite-os-rocky',
];

function stopChaosContainers(): void {
  for (const name of CHAOS_CONTAINERS) {
    try {
      execSync(`docker stop ${name}`, { stdio: 'pipe', timeout: 10000 });
    } catch { /* not running */ }
    try {
      execSync(`docker rm ${name}`, { stdio: 'pipe', timeout: 5000 });
    } catch { /* already removed */ }
  }
}

/**
 * Clean up log files from previous runs so each run starts fresh.
 * Clears both logs/chaos-*.txt and test-docker/logs/<container>/sshd.log.
 */
function cleanLogs(): void {
  // Clean logs/chaos-container-logs.txt and logs/chaos-results.jsonl
  const logsDir = path.resolve(__dirname, '..', 'logs');
  for (const file of ['chaos-container-logs.txt']) {
    const filePath = path.join(logsDir, file);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  // Clean test-docker/logs/<container>/sshd.log (volume-mounted logs)
  const dockerLogsDir = path.join(__dirname, 'logs');
  if (fs.existsSync(dockerLogsDir)) {
    for (const dir of fs.readdirSync(dockerLogsDir)) {
      const logFile = path.join(dockerLogsDir, dir, 'sshd.log');
      if (fs.existsSync(logFile)) {
        fs.unlinkSync(logFile);
      }
    }
  }
}

export default async function globalSetup(): Promise<void> {
  console.log('\n[Chaos Setup] Cleaning logs from previous run...');
  cleanLogs();

  console.log('[Chaos Setup] Starting SSH containers for bug discovery testing...');
  console.log('[Chaos Setup] Starting basic containers (ports 2201-2203)...');

  try {
    startCompose(BASIC_COMPOSE, 'Basic');
  } catch (err: any) {
    console.error('[Chaos Setup] Failed to start basic containers:', err.stderr?.toString() || err.message);
    throw err;
  }

  console.log('[Chaos Setup] Starting multi-OS containers (ports 2210-2214)...');

  try {
    startCompose(MULTIOS_COMPOSE, 'Multi-OS');
  } catch (err: any) {
    console.error('[Chaos Setup] Failed to start multi-OS containers:', err.stderr?.toString() || err.message);
    throw err;
  }

  // Register signal handlers for abnormal termination only (Ctrl+C, VS Code close mid-test).
  // Normal completion is handled by globalTeardown.chaos.ts — these are the safety net.
  // Only stops containers by exact name (sshlite-*), never touches other projects.
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    console.log('\n[Chaos Setup] Process interrupted — stopping chaos containers...');
    stopChaosContainers();
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  console.log('[Chaos Setup] All containers started. Waiting for SSH readiness...');

  await Promise.all(
    ALL_SERVERS.map(async (server) => {
      await waitForSSH(server);
      console.log(`[Chaos Setup] ${server.label} (port ${server.port}) ready`);
    })
  );

  console.log('[Chaos Setup] All 8 servers ready.\n');
}
