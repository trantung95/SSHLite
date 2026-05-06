/**
 * Chaos catalog builder
 *
 * Parses .adn/features/ + .adn/flow/ + package.json into the runtime catalog
 * (actions.json, flows.json, commands.json). Driven by `npm run chaos:catalog`.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Action } from '../ChaosTypes';

export interface CatalogCommand {
  id: string;
  title: string;
}

export interface CatalogFlow {
  name: string;
  steps: string[];
}

export interface BuildResult {
  actions: Action[];
  flows: CatalogFlow[];
  commands: CatalogCommand[];
}

export function parseUserActions(md: string, source: string): Action[] {
  const lines = md.split('\n');
  const actions: Action[] = [];
  let inSection = false;
  let pastHeader = false;

  for (const raw of lines) {
    const line = raw.trim();

    if (/^##\s+User Actions/i.test(line)) {
      inSection = true;
      pastHeader = false;
      continue;
    }
    if (inSection && /^##\s+/.test(line) && !/User Actions/i.test(line)) {
      inSection = false;
      pastHeader = false;
      continue;
    }
    if (!inSection) continue;

    // Detect the "|---|---|---|" separator row that marks end of header.
    const noPipes = line.replace(/\|/g, '');
    if (line.startsWith('|') && /^[\s\-:]+$/.test(noPipes)) {
      pastHeader = true;
      continue;
    }
    if (!pastHeader) continue;
    if (!line.startsWith('|')) continue;

    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 2) continue;

    const name = cells[0];
    const primitivesCell = cells[1];
    const notesCell = cells[2] ?? '';
    const primitives = primitivesCell.split(',').map(s => s.trim()).filter(Boolean);
    if (!name || primitives.length === 0) continue;

    const action: Action = { name, primitives, source };
    if (/\bunordered\b/i.test(notesCell)) action.unordered = true;
    actions.push(action);
  }

  return actions;
}

export function parseFlows(md: string, source: string): CatalogFlow[] {
  const lines = md.split('\n');
  const flows: CatalogFlow[] = [];
  let inFlow = false;
  let steps: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s+(Flow|Steps)\b/i.test(line)) {
      if (inFlow && steps.length > 0) flows.push({ name: source, steps });
      inFlow = true;
      steps = [];
      continue;
    }
    if (inFlow && /^##\s+/.test(line)) {
      if (steps.length > 0) flows.push({ name: source, steps });
      inFlow = false;
      steps = [];
      continue;
    }
    if (!inFlow) continue;

    const m = /^\d+\.\s+(.+)$/.exec(line);
    if (m) steps.push(m[1]);
  }
  if (inFlow && steps.length > 0) flows.push({ name: source, steps });
  return flows;
}

export function parseCommands(pkg: unknown): CatalogCommand[] {
  const obj = pkg as { contributes?: { commands?: Array<{ command?: string; title?: string }> } };
  const cmds = obj.contributes?.commands ?? [];
  return cmds
    .filter(c => typeof c.command === 'string' && typeof c.title === 'string')
    .map(c => ({ id: c.command as string, title: c.title as string }));
}

export function buildCatalog(repoRoot: string): BuildResult {
  const featuresDir = path.join(repoRoot, '.adn', 'features');
  const flowDir = path.join(repoRoot, '.adn', 'flow');
  const pkgPath = path.join(repoRoot, 'package.json');

  const actions: Action[] = [];
  if (fs.existsSync(featuresDir)) {
    const files = fs.readdirSync(featuresDir).filter(n => n.endsWith('.md')).sort();
    for (const f of files) {
      const md = fs.readFileSync(path.join(featuresDir, f), 'utf8');
      actions.push(...parseUserActions(md, `features/${f}`));
    }
  }

  const flows: CatalogFlow[] = [];
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

export function writeCatalog(repoRoot: string, result: BuildResult): void {
  const dir = path.join(repoRoot, 'src', 'chaos', 'catalog');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'actions.json'), JSON.stringify(result.actions, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'flows.json'), JSON.stringify(result.flows, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'commands.json'), JSON.stringify(result.commands, null, 2) + '\n');
}
