/**
 * Jest global setup for the e2e suite (`npm run test:e2e`).
 *
 * The e2e tests skip themselves when nothing listens on 127.0.0.1:2222. With no
 * script starting their container, the suite "passed" for months while running
 * nothing, and two real failures (one a terminal channel leak in the product)
 * went unseen. Setup now starts the container and waits for a real SSH login,
 * so a run either exercises the server or fails here.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import { Client } from 'ssh2';

const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');

function canLogin(): Promise<boolean> {
  return new Promise((resolve) => {
    const c = new Client();
    const timer = setTimeout(() => { c.end(); resolve(false); }, 4000);
    c.on('ready', () => { clearTimeout(timer); c.end(); resolve(true); });
    c.on('error', () => { clearTimeout(timer); resolve(false); });
    c.connect({ host: '127.0.0.1', port: 2222, username: 'testuser', password: 'testpass', readyTimeout: 4000 });
  });
}

export default async function globalSetup(): Promise<void> {
  console.log('\n[E2E Setup] Starting the e2e SSH container (port 2222)...');
  execSync(`docker compose -f "${COMPOSE_FILE}" up -d`, { stdio: 'pipe', timeout: 600000 });
  for (let i = 0; i < 60; i++) {
    if (await canLogin()) {
      console.log('[E2E Setup] SSH login on 2222 works.\n');
      return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('[E2E Setup] No SSH login on 127.0.0.1:2222 after 60 s');
}
