/**
 * Jest Global Setup for Docker SSH Tests
 *
 * Automatically starts Docker containers and waits for SSH
 * to become available on all 3 servers before tests run.
 */

import { execSync } from 'child_process';
import { Client } from 'ssh2';
import * as path from 'path';

const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');

const SERVERS = [
  { host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' },
  { host: '127.0.0.1', port: 2202, username: 'testuser', password: 'testpass' },
  { host: '127.0.0.1', port: 2203, username: 'admin', password: 'adminpass' },
];

/** Try to connect to an SSH server, resolve true if successful */
function tryConnect(config: typeof SERVERS[0]): Promise<boolean> {
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

/** Wait until SSH is available on a server, with retries */
async function waitForSSH(config: typeof SERVERS[0], maxRetries = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const ok = await tryConnect(config);
    if (ok) {
      return;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`SSH not available on ${config.host}:${config.port} after ${maxRetries} retries`);
}

export default async function globalSetup(): Promise<void> {
  console.log('\n[Docker Setup] Starting SSH test containers...');

  // Start containers
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" up -d --build`, {
      stdio: 'pipe',
      timeout: 120000,
    });
  } catch (err: any) {
    console.error('[Docker Setup] Failed to start containers:', err.stderr?.toString() || err.message);
    throw err;
  }

  console.log('[Docker Setup] Containers started. Waiting for SSH readiness...');

  // Wait for all 3 servers to accept SSH connections
  await Promise.all(
    SERVERS.map(async (server, i) => {
      await waitForSSH(server);
      console.log(`[Docker Setup] Server ${i + 1} (port ${server.port}) ready`);
    })
  );

  console.log('[Docker Setup] All servers ready.\n');
}
