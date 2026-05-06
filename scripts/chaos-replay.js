#!/usr/bin/env node
/**
 * chaos-replay.js
 *
 * Replays a recorded chaos run by run_id (or full JSON line) against the live
 * Docker stack. Usage: npm run chaos:replay -- <run-id>
 *
 * Note: this is a thin wrapper around the compiled TypeScript. It assumes the
 * project has been compiled (`npm run compile`) so out/chaos/replay/ChaosReplayer.js exists.
 */

const path = require('path');

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run chaos:replay -- <run-id|json-line>');
  process.exit(2);
}

(async () => {
  const compiled = path.resolve(__dirname, '..', 'out', 'chaos', 'replay', 'ChaosReplayer.js');
  let mod;
  try {
    mod = require(compiled);
  } catch {
    console.error(`Compiled output not found at ${compiled}. Run 'npm run compile' first.`);
    process.exit(1);
  }
  try {
    await mod.replayFromArg(arg);
  } catch (err) {
    console.error('[replay] error:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
