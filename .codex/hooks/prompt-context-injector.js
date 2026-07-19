'use strict';

const fs = require('fs');
const path = require('path');

let payload;
try { payload = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }

const prompt = String(payload.prompt || '');
const tokens = new Set((prompt.toLowerCase().match(/\b[a-z][a-z0-9_]{3,}\b/g) || []).filter((token) => !new Set([
  'about', 'after', 'again', 'before', 'being', 'could', 'every', 'first', 'from', 'have', 'into', 'need', 'only', 'please', 'project', 'should', 'that', 'this', 'with', 'would', 'your'
]).has(token)));
const lessonsPath = path.resolve(__dirname, '..', '..', '.adn', 'lessons.md');
let matches = [];

if (tokens.size > 0 && fs.existsSync(lessonsPath)) {
  const sections = fs.readFileSync(lessonsPath, 'utf8').split(/^(?=## )/m);
  matches = sections.filter((section) => {
    if (!section.startsWith('## ')) return false;
    const lower = section.toLowerCase();
    return [...tokens].filter((token) => lower.includes(token)).length >= 2;
  }).slice(0, 3);
}

const additionalContext = matches.length
  ? `Relevant SSH Lite lessons from .adn/lessons.md:\n\n${matches.join('\n\n').trim()}`
  : 'SSH Lite: skim .adn/lessons.md for guidance relevant to this task before planning changes.';

process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext }
}));
