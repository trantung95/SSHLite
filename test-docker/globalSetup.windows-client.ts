/**
 * Jest Global Setup for Windows-client → Linux-server cross-coverage tests.
 *
 * Reuses the multi-OS Docker stack (Alpine, Ubuntu, Debian, Fedora, Rocky on
 * ports 2210-2214). Tests are gated to run only when process.platform === 'win32'
 * — but containers are still brought up so the gate logic itself is testable
 * everywhere (the gate just causes individual tests to skip).
 */

import { spawnSync } from 'child_process';
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
    if (ok) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`SSH not available on ${config.os} (${config.host}:${config.port}) after ${maxRetries} retries`);
}

export default async function globalSetup(): Promise<void> {
  console.log(`\n[Windows-Client Setup] Host platform: ${process.platform}`);
  console.log('[Windows-Client Setup] Starting multi-OS SSH containers (Alpine/Ubuntu/Debian/Fedora/Rocky)...');

  const result = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--build'], {
    stdio: 'pipe',
    timeout: 300000,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error('[Windows-Client Setup] Failed to start containers:', result.stderr || result.error?.message);
    throw new Error(`docker compose up failed (exit ${result.status})`);
  }

  console.log('[Windows-Client Setup] Containers started. Waiting for SSH readiness...');

  await Promise.all(
    SERVERS.map(async (server) => {
      await waitForSSH(server);
      console.log(`[Windows-Client Setup] ${server.os} (port ${server.port}) ready`);
    })
  );

  console.log('[Windows-Client Setup] All 5 OS servers ready.\n');
}
