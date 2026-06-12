/**
 * Jest global teardown for the isolated native-search-tools docker suite.
 */

import { execSync } from 'child_process';
import * as path from 'path';

const COMPOSE_FILE = path.join(__dirname, 'docker-compose.search-tools.yml');

export default async function globalTeardown(): Promise<void> {
  try {
    execSync(`docker compose -f "${COMPOSE_FILE}" down --remove-orphans`, { stdio: 'pipe', timeout: 60000 });
    console.log('[Search-Tools Docker] Stopped.');
  } catch (err: any) {
    console.error('[Search-Tools Docker] Teardown error:', err.stderr?.toString() || err.message);
  }
}
