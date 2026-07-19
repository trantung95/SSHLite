'use strict';

const fs = require('fs');

try { JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: 'SSH Lite: read AGENTS.md and the relevant .adn/ documentation before changing code. Run scripts/verify-ai-infra.ps1 after AI infrastructure changes.'
  }
}));
