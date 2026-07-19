'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let payload;
try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

const repoRoot = path.resolve(__dirname, '..', '..');
const commandText = String(payload.tool_input?.command || '');
const messages = [];
function run(script, successMessage) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', script)], { cwd: repoRoot, stdio: 'ignore' });
  if (result.status !== 0) {
    process.stderr.write(`Codex hook failed: ${script}\n`);
    process.exit(result.status || 1);
  }
  messages.push(successMessage);
}

if (/package\.json/.test(commandText)) run('generate-commands-doc.js', 'Regenerated docs/COMMANDS.md.');
if (/\.adn[\\/](features|flow)[\\/]/.test(commandText)) run('build-chaos-catalog.js', 'Regenerated chaos catalog.');

if (messages.length > 0) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: messages.join(' ') }
  }));
}
