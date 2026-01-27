/**
 * Jest Global Setup for Multi-OS Docker SSH Tests
 *
 * Starts SSH containers running 5 different Linux distributions
 * and waits for SSH to be ready on all of them.
 */

import { execSync } from 'child_process';
import { Client } from 'ssh2';
import * as path from 'path';

const COMPOSE_FILE = path.join(__dirname, 'docker-compose.multios.yml');

const SERVERS = [
  { host: '127.0.0.1', port: 2210, username: 'testuser', password: 'testpass', os: 'alpine' },
  { host: '127.0.0.1', port: 2211, username: 'testuser', password: 'testpass', os: 'ubuntu' },
  { host: '127.0.0.1', port: 2212, username: 'testuser', password: 'testpass', os: 'debian' },
  { host: '127.0.0.1', port: 2213, username: 'testuser', password: 'testpass', os: 'fedora' },
  { host: '127.0.0.1', port: 2214, username: 'testuser', password: 'testpass', os: 'rocky' },
];

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

async function waitForSSH(config: typeof SERVERS[0], maxRetries = 40, delayMs = 1500): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    const ok = await tryConnect(config);
    if (ok) {
      return;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`SSH not available on ${config.os} (${config.host}:${config.port}) after ${maxRetries} retries`);
}

export default async function globalSetup(): Promise<void> {
  console.log('\n[Multi-OS Setup] Starting SSH containers for 5 Linux distributions...');

  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" up -d --build`, {
      stdio: 'pipe',
      timeout: 300000, // 5 minutes for building all images
    });
  } catch (err: any) {
    console.error('[Multi-OS Setup] Failed to start containers:', err.stderr?.toString() || err.message);
    throw err;
  }

  console.log('[Multi-OS Setup] Containers started. Waiting for SSH readiness...');

  await Promise.all(
    SERVERS.map(async (server) => {
      await waitForSSH(server);
      console.log(`[Multi-OS Setup] ${server.os} (port ${server.port}) ready`);
    })
  );

  console.log('[Multi-OS Setup] All 5 OS servers ready.\n');
}
