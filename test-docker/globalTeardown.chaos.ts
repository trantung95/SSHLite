/**
 * Jest Global Teardown for Chaos Bug Discovery Tests
 *
 * Cleans up temporary chaos test directories on containers.
 * Leaves containers running -- they are shared infrastructure.
 */

import { execSync } from 'child_process';
import * as path from 'path';

const BASIC_COMPOSE = path.join(__dirname, 'docker-compose.yml');
const MULTIOS_COMPOSE = path.join(__dirname, 'docker-compose.multios.yml');

const CONTAINERS = [
  'sshlite-test-server-1',
  'sshlite-test-server-2',
  'sshlite-test-server-3',
  'sshlite-os-alpine',
  'sshlite-os-ubuntu',
  'sshlite-os-debian',
  'sshlite-os-fedora',
  'sshlite-os-rocky',
];

export default async function globalTeardown(): Promise<void> {
  console.log('\n[Chaos Teardown] Cleaning up chaos test artifacts...');

  // Clean up chaos test directories on each container
  for (const container of CONTAINERS) {
    try {
      execSync(
        `docker exec ${container} sh -c "rm -rf /home/testuser/chaos-* /tmp/chaos-* 2>/dev/null || true"`,
        { stdio: 'pipe', timeout: 5000 }
      );
    } catch {
      // Container may not be running, ignore
    }
  }

  console.log('[Chaos Teardown] Cleanup complete. Containers left running.');
}
