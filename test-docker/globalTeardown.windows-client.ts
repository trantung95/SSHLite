/**
 * Jest Global Teardown for Windows-client cross-coverage tests.
 *
 * Stops the multi-OS SSH containers. Mirrors globalTeardown.multios.ts but uses
 * spawnSync instead of execSync (no shell-injection surface, hook-friendly).
 */

import { spawnSync } from 'child_process';
import * as path from 'path';

const COMPOSE_FILE = path.join(__dirname, 'docker-compose.multios.yml');

export default async function globalTeardown(): Promise<void> {
  console.log('\n[Windows-Client Teardown] Stopping multi-OS SSH containers...');

  const result = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'down'], {
    stdio: 'pipe',
    timeout: 60000,
    shell: process.platform === 'win32',
    encoding: 'utf8',
  });
  if (result.status === 0) {
    console.log('[Windows-Client Teardown] All containers stopped and removed.');
  } else {
    console.error('[Windows-Client Teardown] Failed to stop containers:', result.stderr || result.error?.message);
  }
}
