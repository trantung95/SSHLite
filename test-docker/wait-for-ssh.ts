/**
 * Wait for SSH readiness on all CI Docker containers.
 * Used by GitHub Actions workflow before running integration tests.
 */
import { Client } from 'ssh2';

const SERVERS = [
  { host: '127.0.0.1', port: 2230, username: 'testuser', password: 'testpass', os: 'alpine' },
  { host: '127.0.0.1', port: 2231, username: 'testuser', password: 'testpass', os: 'ubuntu' },
  { host: '127.0.0.1', port: 2232, username: 'testuser', password: 'testpass', os: 'debian' },
  { host: '127.0.0.1', port: 2233, username: 'testuser', password: 'testpass', os: 'fedora' },
  { host: '127.0.0.1', port: 2234, username: 'testuser', password: 'testpass', os: 'rocky' },
];

const MAX_RETRIES = 40;
const RETRY_DELAY_MS = 1500;

function tryConnect(server: typeof SERVERS[0]): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const timeout = setTimeout(() => {
      client.end();
      reject(new Error('Connection timeout'));
    }, 3000);

    client.on('ready', () => {
      clearTimeout(timeout);
      client.end();
      resolve();
    });
    client.on('error', (err) => {
      clearTimeout(timeout);
      client.end();
      reject(err);
    });
    client.connect({
      host: server.host,
      port: server.port,
      username: server.username,
      password: server.password,
      readyTimeout: 3000,
      hostVerifier: () => true,
    } as any);
  });
}

async function waitForServer(server: typeof SERVERS[0]): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await tryConnect(server);
      console.log(`  [OK] ${server.os} (port ${server.port}) - ready`);
      return;
    } catch {
      if (attempt === MAX_RETRIES) {
        throw new Error(`${server.os} (port ${server.port}) failed after ${MAX_RETRIES} attempts`);
      }
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
    }
  }
}

async function main(): Promise<void> {
  console.log('Waiting for SSH readiness on CI containers...');
  await Promise.all(SERVERS.map(waitForServer));
  console.log('All 5 SSH servers are ready.');
}

main().catch((err) => {
  console.error('Failed to connect to SSH servers:', err.message);
  process.exit(1);
});
