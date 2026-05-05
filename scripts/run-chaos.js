#!/usr/bin/env node
/**
 * Cross-platform chaos-test runner.
 *
 * `npm run test:chaos:deep` previously used POSIX env-prefix syntax
 * (`CHAOS_TIMEOUT=900000 CHAOS_MODE=deep jest ...`) which fails on Windows
 * cmd.exe. This wrapper sets the env vars in Node and spawns jest portably.
 *
 * Usage: node scripts/run-chaos.js [mode] [extra-jest-args...]
 *   mode: "quick" (default) | "deep" | "tools"
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const mode = (process.argv[2] || 'quick').toLowerCase();
const extra = process.argv.slice(3);

const env = Object.assign({}, process.env);
const args = ['jest', '--config', 'jest.chaos.config.js', '--no-coverage'];

switch (mode) {
  case 'deep':
    env.CHAOS_TIMEOUT = '900000';
    env.CHAOS_MODE = 'deep';
    break;
  case 'tools':
    args.push('--testPathPatterns=chaos-ssh-tools');
    break;
  case 'quick':
    // defaults are fine
    break;
  default:
    console.error(`[run-chaos] Unknown mode "${mode}". Use quick | deep | tools.`);
    process.exit(2);
}

args.push(...extra);

// Windows requires shell:true to find npx.cmd; on POSIX shell:true is also fine.
const result = spawnSync('npx', args, {
  stdio: 'inherit',
  env,
  cwd: path.resolve(__dirname, '..'),
  shell: true,
});

if (result.error) {
  console.error('[run-chaos] Failed to spawn jest:', result.error.message);
  process.exit(1);
}
process.exit(result.status === null ? 1 : result.status);
