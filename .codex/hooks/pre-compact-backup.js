'use strict';

const fs = require('fs');
const path = require('path');

let payload;
try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

const repoRoot = path.resolve(__dirname, '..', '..');
const files = [];
function collect(directory) {
  if (!fs.existsSync(directory)) return;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(fullPath);
    else if (entry.isFile()) {
      try { files.push({ path: fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs }); } catch { /* File changed during hook. */ }
    }
  }
}

for (const directory of ['.adn', 'docs', 'src']) collect(path.join(repoRoot, directory));
const recent = files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 6)
  .map((file) => path.relative(repoRoot, file.path).replace(/\\/g, '/'));
const checkpoint = [
  '# Codex context checkpoint',
  '',
  `Trigger: ${payload.trigger || 'unknown'}`,
  `Turn: ${payload.turn_id || 'unknown'}`,
  `Saved: ${new Date().toISOString()}`,
  '',
  'Recently changed project files:',
  ...recent.map((file) => `- ${file}`),
  ''
].join('\n');

fs.writeFileSync(path.join(repoRoot, '.codex', '_context_checkpoint.md'), checkpoint, 'utf8');
