#!/usr/bin/env node
/**
 * build-chaos-catalog.js
 *
 * Regenerates src/chaos/catalog/{actions,flows,commands}.json
 * from .adn/features/, .adn/flow/, and package.json.
 *
 * Run: node scripts/build-chaos-catalog.js
 * Auto-run: configured as a Claude Code hook on .adn/features/*.md saves (see .claude/settings.json)
 *
 * Parsing logic must stay in lock-step with src/chaos/catalog/builder.ts
 * (the TypeScript version used at test time). The drift test in
 * src/__tests__/chaos/catalogDrift.test.ts compares the TS in-memory output
 * to the on-disk JSON; any divergence fails the test.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function parseUserActions(md, source) {
  const lines = md.split('\n');
  const actions = [];
  let inSection = false;
  let pastHeader = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+User Actions/i.test(line)) {
      inSection = true; pastHeader = false; continue;
    }
    if (inSection && /^##\s+/.test(line) && !/User Actions/i.test(line)) {
      inSection = false; pastHeader = false; continue;
    }
    if (!inSection) continue;

    const noPipes = line.replace(/\|/g, '');
    if (line.startsWith('|') && /^[\s\-:]+$/.test(noPipes)) {
      pastHeader = true; continue;
    }
    if (!pastHeader) continue;
    if (!line.startsWith('|')) continue;

    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;
    const name = cells[0];
    const primitivesCell = cells[1];
    const notesCell = cells[2] || '';
    const primitives = primitivesCell.split(',').map(s => s.trim()).filter(Boolean);
    if (!name || primitives.length === 0) continue;

    const action = { name, primitives, source };
    if (/\bunordered\b/i.test(notesCell)) action.unordered = true;
    actions.push(action);
  }
  return actions;
}

function parseFlows(md, source) {
  const lines = md.split('\n');
  const flows = [];
  let inFlow = false;
  let steps = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+(Flow|Steps)\b/i.test(line)) {
      if (inFlow && steps.length > 0) flows.push({ name: source, steps });
      inFlow = true; steps = []; continue;
    }
    if (inFlow && /^##\s+/.test(line)) {
      if (steps.length > 0) flows.push({ name: source, steps });
      inFlow = false; steps = []; continue;
    }
    if (!inFlow) continue;
    const m = line.match(/^\d+\.\s+(.+)$/);
    if (m) steps.push(m[1]);
  }
  if (inFlow && steps.length > 0) flows.push({ name: source, steps });
  return flows;
}

function parseCommands(pkg) {
  const cmds = (pkg.contributes && pkg.contributes.commands) || [];
  return cmds
    .filter(c => typeof c.command === 'string' && typeof c.title === 'string')
    .map(c => ({ id: c.command, title: c.title }));
}

function buildCatalog(repoRoot) {
  const featuresDir = path.join(repoRoot, '.adn', 'features');
  const flowDir = path.join(repoRoot, '.adn', 'flow');
  const pkgPath = path.join(repoRoot, 'package.json');

  const actions = [];
  if (fs.existsSync(featuresDir)) {
    const files = fs.readdirSync(featuresDir).filter(n => n.endsWith('.md')).sort();
    for (const f of files) {
      const md = fs.readFileSync(path.join(featuresDir, f), 'utf8');
      actions.push(...parseUserActions(md, `features/${f}`));
    }
  }

  const flows = [];
  if (fs.existsSync(flowDir)) {
    const files = fs.readdirSync(flowDir).filter(n => n.endsWith('.md')).sort();
    for (const f of files) {
      const md = fs.readFileSync(path.join(flowDir, f), 'utf8');
      flows.push(...parseFlows(md, `flow/${f}`));
    }
  }

  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const commands = parseCommands(pkg);
  return { actions, flows, commands };
}

function writeCatalog(repoRoot, result) {
  const dir = path.join(repoRoot, 'src', 'chaos', 'catalog');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'actions.json'), JSON.stringify(result.actions, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(result.flows, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'commands.json'), JSON.stringify(result.commands, null, 2) + '\n');
}

const result = buildCatalog(root);
writeCatalog(root, result);
console.log(`[catalog] actions=${result.actions.length} flows=${result.flows.length} commands=${result.commands.length}`);
