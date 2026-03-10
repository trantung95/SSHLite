/**
 * Jest Global Teardown for Chaos Bug Discovery Tests
 *
 * 1. Collects Docker container logs (before stopping — logs are lost after rm)
 * 2. Cleans up temporary chaos test directories
 * 3. Stops and removes only sshlite chaos containers by exact name
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

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

/**
 * Collect ALL Docker logs from all containers and append to logs/chaos-container-logs.txt.
 * Appends a final "TEARDOWN" section after the per-scenario logs already written by ChaosEngine.
 * Must run BEFORE stopping containers — logs are lost after docker rm.
 */
function collectContainerLogs(): void {
  const logsDir = path.resolve(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }

  const logFile = path.join(logsDir, 'chaos-container-logs.txt');
  const sections: string[] = [];
  const timestamp = new Date().toISOString();

  sections.push('');
  sections.push('='.repeat(80));
  sections.push(`FINAL CONTAINER LOGS (TEARDOWN) — ${timestamp}`);
  sections.push('='.repeat(80));
  sections.push('');

  for (const container of CONTAINERS) {
    sections.push('─'.repeat(60));
    sections.push(`Container: ${container}`);
    sections.push('─'.repeat(60));
    try {
      const logs = execSync(`docker logs ${container} 2>&1`, {
        stdio: 'pipe',
        timeout: 15000,
        maxBuffer: 10 * 1024 * 1024, // 10MB per container
      }).toString().trim();
      sections.push(logs || '(empty)');
    } catch {
      sections.push('(container not running or logs unavailable)');
    }
    sections.push('');
  }

  // Append to existing file (ChaosEngine writes per-scenario logs first)
  fs.appendFileSync(logFile, sections.join('\n'), 'utf-8');
  console.log(`[Chaos Teardown] Final container logs appended to ${logFile}`);
}

export default async function globalTeardown(): Promise<void> {
  // Collect container logs FIRST (before cleanup and stop)
  console.log('\n[Chaos Teardown] Collecting container logs...');
  collectContainerLogs();

  // Clean up chaos test directories on each container (while still running)
  console.log('[Chaos Teardown] Cleaning up chaos test artifacts...');
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

  // Stop and remove only sshlite chaos containers by exact name
  console.log('[Chaos Teardown] Stopping chaos containers...');
  for (const container of CONTAINERS) {
    try {
      execSync(`docker stop ${container}`, { stdio: 'pipe', timeout: 10000 });
    } catch { /* not running */ }
    try {
      execSync(`docker rm ${container}`, { stdio: 'pipe', timeout: 5000 });
    } catch { /* already removed */ }
  }

  console.log('[Chaos Teardown] All chaos containers stopped and removed.');
}
