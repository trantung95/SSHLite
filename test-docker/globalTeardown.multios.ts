/**
 * Jest Global Teardown for Multi-OS Docker SSH Tests
 *
 * Stops and removes all multi-OS SSH containers.
 */

import { execSync } from 'child_process';
import * as path from 'path';

const COMPOSE_FILE = path.join(__dirname, 'docker-compose.multios.yml');

export default async function globalTeardown(): Promise<void> {
  console.log('\n[Multi-OS Teardown] Stopping SSH containers...');

  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" down`, {
      stdio: 'pipe',
      timeout: 60000,
    });
    console.log('[Multi-OS Teardown] All containers stopped and removed.');
  } catch (err: any) {
    console.error('[Multi-OS Teardown] Failed to stop containers:', err.stderr?.toString() || err.message);
  }
}
