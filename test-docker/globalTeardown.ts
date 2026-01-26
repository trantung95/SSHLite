/**
 * Jest Global Teardown for Docker SSH Tests
 *
 * Automatically stops and removes Docker containers after tests complete.
 */

import { execSync } from 'child_process';
import * as path from 'path';

const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');

export default async function globalTeardown(): Promise<void> {
  console.log('\n[Docker Teardown] Stopping SSH test containers...');

  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" down`, {
      stdio: 'pipe',
      timeout: 30000,
    });
    console.log('[Docker Teardown] Containers stopped and removed.');
  } catch (err: any) {
    console.error('[Docker Teardown] Failed to stop containers:', err.stderr?.toString() || err.message);
    // Don't throw — teardown failures shouldn't fail the test run
  }
}
