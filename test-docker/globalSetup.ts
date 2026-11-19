/**
 * Jest Global Setup for Docker SSH Tests
 *
 * Automatically starts Docker containers and waits for SSH
 * to become available on all 3 servers before tests run.
 */

import { execSync } from 'child_process';
import { Client } from 'ssh2';
import * as path from 'path';
import * as net from 'net';

const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');

const SERVERS = [
  { host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' },
  { host: '127.0.0.1', port: 2202, username: 'testuser', password: 'testpass' },
  { host: '127.0.0.1', port: 2203, username: 'admin', password: 'adminpass' },
  // v0.8.14: sudo-configured server for the stderr-sync protocol integration test.
  { host: '127.0.0.1', port: 2204, username: 'usernopasswd', password: 'nopw' },
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

/** Resolve true once the FTP server on `port` sends its `220` greeting. */
function ftpGreets(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let buf = '';
    const done = (ok: boolean) => {
      clearTimeout(timer);
      sock.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 3000);
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.startsWith('220')) done(true);
    });
    sock.on('error', () => done(false));
  });
}

async function waitForFtp(port: number, attempts: number): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (await ftpGreets(port)) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * vsftpd (2207) must greet before the FTP suites run. Setup used to wait for SSH
 * only, so a vsftpd that died on a cold start made 53 FTP tests fail with
 * ECONNREFUSED and no clue why. Restart it once; if it still does not greet,
 * fail here with its logs. pure-ftpd (2208) is left to connectWithRetry: it
 * refuses connections for 30-90 s while it generates its TLS material.
 */
async function ensureVsftpd(): Promise<void> {
  if (await waitForFtp(2207, 30)) return;
  console.log('[Docker Setup] vsftpd (2207) not greeting after 30 s, restarting it...');
  execSync(`docker compose -f "${COMPOSE_FILE}" restart ftp`, { stdio: 'pipe', timeout: 60000 });
  if (await waitForFtp(2207, 30)) return;
  let logs = '';
  try {
    logs = execSync('docker logs --tail 50 sshlite-test-ftp 2>&1', { stdio: 'pipe', timeout: 15000 }).toString();
  } catch { /* container gone */ }
  throw new Error(`vsftpd on 127.0.0.1:2207 never sent its 220 greeting.\n${logs}`);
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

  await ensureVsftpd();
  console.log('[Docker Setup] vsftpd (port 2207) ready');

  console.log('[Docker Setup] All servers ready.\n');
}
