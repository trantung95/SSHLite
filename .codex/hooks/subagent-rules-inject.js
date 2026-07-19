'use strict';

const fs = require('fs');

try { JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SubagentStart',
    additionalContext: 'SSH Lite subagent: read AGENTS.md, preserve unrelated worktree changes, report evidence, and do not commit or push unless explicitly assigned.'
  }
}));
