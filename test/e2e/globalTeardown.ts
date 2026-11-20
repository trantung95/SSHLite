/** Jest global teardown for the e2e suite: remove the container and its volumes. */

import { execSync } from 'child_process';
import * as path from 'path';

const COMPOSE_FILE = path.join(__dirname, 'docker-compose.yml');

export default async function globalTeardown(): Promise<void> {
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" down --volumes --remove-orphans`, { stdio: 'pipe', timeout: 60000 });
    console.log('\n[E2E Teardown] Container removed.');
  } catch (err: any) {
    console.error('[E2E Teardown] Failed to remove container:', err.stderr?.toString() || err.message);
  }
}
