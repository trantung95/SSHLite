/**
 * Jest Global Setup for Chaos Bug Discovery Tests
 *
 * Starts BOTH basic (ports 2201-2203) AND multi-OS (ports 2210-2214) containers.
 * All 8 servers are needed for chaos testing across multiple OS and server configs.
 */

import { execSync } from 'child_process';
import { Client } from 'ssh2';
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
    // Check if containers are already running
    const ps = execSync(`docker compose -f "${composeFile}" ps --format json`, {
      stdio: 'pipe',
      timeout: 10000,
    }).toString();
    const running = ps.trim().length > 0;
    if (running) {
      console.log(`[Chaos Setup] ${label} containers already running, skipping start`);
      return;
    }
  } catch {
    // Containers not running, start them
  }

  execSync(`docker compose -f "${composeFile}" up -d --build`, {
    stdio: 'pipe',
    timeout: 300000,
  });
}

export default async function globalSetup(): Promise<void> {
  console.log('\n[Chaos Setup] Starting SSH containers for bug discovery testing...');
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

  console.log('[Chaos Setup] All containers started. Waiting for SSH readiness...');

  await Promise.all(
    ALL_SERVERS.map(async (server) => {
      await waitForSSH(server);
      console.log(`[Chaos Setup] ${server.label} (port ${server.port}) ready`);
    })
  );

  console.log('[Chaos Setup] All 8 servers ready.\n');
}
