/**
 * Jest global setup for the isolated native-search-tools docker suite.
 * Starts the search-tools (2207) and busybox (2208) servers and waits for SSH.
 */

import { execSync } from 'child_process';
import { Client } from 'ssh2';
import * as path from 'path';

const COMPOSE_FILE = path.join(__dirname, 'docker-compose.search-tools.yml');

const SERVERS = [
  { host: '127.0.0.1', port: 2207, username: 'testuser', password: 'testpass' },
  { host: '127.0.0.1', port: 2208, username: 'testuser', password: 'testpass' },
];

function tryConnect(config: typeof SERVERS[0]): Promise<boolean> {
  return new Promise((resolve) => {
    const client = new Client();
    const timeout = setTimeout(() => { client.end(); resolve(false); }, 3000);
    client.on('ready', () => { clearTimeout(timeout); client.end(); resolve(true); });
    client.on('error', () => { clearTimeout(timeout); resolve(false); });
    client.connect({ host: config.host, port: config.port, username: config.username, password: config.password, readyTimeout: 3000 });
  });
}

async function waitForSSH(config: typeof SERVERS[0], maxRetries = 40, delayMs = 1000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    if (await tryConnect(config)) return;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`SSH not available on ${config.host}:${config.port} after ${maxRetries} retries`);
}

export default async function globalSetup(): Promise<void> {
  console.log('\n[Search-Tools Docker] Building + starting servers...');
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" up -d --build`, { stdio: 'pipe', timeout: 240000 });
  } catch (err: any) {
    console.error('[Search-Tools Docker] Failed to start:', err.stderr?.toString() || err.message);
    throw err;
  }
  await Promise.all(SERVERS.map(async (s, i) => {
    await waitForSSH(s);
    console.log(`[Search-Tools Docker] Server ${i + 1} (port ${s.port}) ready`);
  }));
  console.log('[Search-Tools Docker] Ready.\n');
}
