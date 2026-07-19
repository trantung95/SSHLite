'use strict';

const fs = require('fs');

try { JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

process.stdout.write(JSON.stringify({
  systemMessage: 'Context was compacted. Re-read AGENTS.md, inspect .codex/_context_checkpoint.md if present, and verify assumptions before continuing.'
}));
