#!/usr/bin/env node
/**
 * generate-commands-doc.js
 *
 * Reads package.json contributes.commands, menus, and keybindings and writes
 * docs/COMMANDS.md — a user-facing guide to every command in SSH Lite (SSH Tools).
 *
 * Run: node scripts/generate-commands-doc.js
 * Auto-run: configured as a Claude Code hook on package.json saves (see .claude/settings.json)
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const { commands, menus, keybindings } = pkg.contributes;

// ── Build lookup maps ─────────────────────────────────────────────────────────

// command id → { title, category, icon }
const cmdMap = {};
for (const cmd of commands) {
  cmdMap[cmd.command] = cmd;
}

// command id → array of { when, group, view } from view/item/context + view/title
const menuMap = {};
const viewTitleMenus = menus['view/title'] || [];
const itemContextMenus = menus['view/item/context'] || [];

for (const entry of [...viewTitleMenus, ...itemContextMenus]) {
  if (!menuMap[entry.command]) { menuMap[entry.command] = []; }
  menuMap[entry.command].push(entry);
}

// command id → keybinding string
const keybindMap = {};
for (const kb of keybindings || []) {
  if (!keybindMap[kb.command]) { keybindMap[kb.command] = []; }
  const combo = kb.mac ? `${kb.key} / ${kb.mac} (Mac)` : kb.key;
  keybindMap[kb.command].push(combo);
}

// ── Group commands by category ────────────────────────────────────────────────

const groups = {};
for (const [id, cmd] of Object.entries(cmdMap)) {
  const cat = cmd.category || 'Other';
  if (!groups[cat]) { groups[cat] = []; }
  groups[cat].push({ id, ...cmd });
}

// Desired category order
const categoryOrder = [
  'SSH Lite',
  'SSH Tools',
  'Other',
];

const orderedCategories = [
  ...categoryOrder.filter((c) => groups[c]),
  ...Object.keys(groups).filter((c) => !categoryOrder.includes(c)),
];

// ── Describe where a command surfaces ────────────────────────────────────────

function surfaceFor(id) {
  const surfaces = [];
  const kbs = keybindMap[id];
  if (kbs && kbs.length > 0) { surfaces.push('Keybinding: ' + kbs.join(', ')); }
  const entries = menuMap[id] || [];
  const inViewTitle = entries.some((e) => viewTitleMenus.includes(e));
  const inItemContext = entries.some((e) => itemContextMenus.includes(e));
  if (inViewTitle) { surfaces.push('View toolbar'); }
  if (inItemContext) { surfaces.push('Tree context menu'); }
  if (surfaces.length === 0) { surfaces.push('Command Palette only'); }
  return surfaces.join(', ');
}

// ── Build when-condition summary ──────────────────────────────────────────────

function whenFor(id) {
  const entries = menuMap[id] || [];
  if (entries.length === 0) { return ''; }
  const whens = [...new Set(entries.map((e) => e.when))].filter(Boolean);
  if (whens.length === 0) { return ''; }
  // simplify: extract viewItem pattern
  return whens.map((w) => {
    const m = w.match(/viewItem\s*=~\s*\/([^/]+)\//);
    return m ? `item: \`${m[1]}\`` : '';
  }).filter(Boolean).join(', ') || '';
}

// ── Strip icon codicons from title ───────────────────────────────────────────

function cleanTitle(title) {
  return title.replace(/\$\([^)]+\)\s*/g, '').trim();
}

// ── Generate markdown ─────────────────────────────────────────────────────────

const now = new Date().toISOString().slice(0, 10);
const version = pkg.version;

let md = `# SSH Lite (SSH Tools) — Command Reference

> Auto-generated from \`package.json\`. Run \`npm run docs:commands\` to regenerate.
> Last updated: ${now} · Version: ${version}

This document lists every command registered by SSH Lite (SSH Tools), organized by category.
Open the Command Palette (**Ctrl+Shift+P** / **Cmd+Shift+P**) and type the command title to find it.

---

## Table of Contents

`;

for (const cat of orderedCategories) {
  const anchor = cat.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  md += `- [${cat}](#${anchor})\n`;
}

md += `
---

`;

for (const cat of orderedCategories) {
  const anchor = cat.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  md += `## ${cat} {#${anchor}}\n\n`;

  md += `| Command | ID | Keybinding | Where |\n`;
  md += `|---------|-----|-----------|-------|\n`;

  for (const cmd of groups[cat]) {
    const title = cleanTitle(cmd.title);
    const id = `\`${cmd.command}\``;
    const kbs = (keybindMap[cmd.command] || []).map((k) => `\`${k}\``).join('<br>') || '—';
    const where = surfaceFor(cmd.command);
    md += `| ${title} | ${id} | ${kbs} | ${where} |\n`;
  }

  md += '\n';
}

md += `---

## Quick Reference by Feature

### SSH File Explorer

| Action | How |
|--------|-----|
| Browse remote files | Connect a host, then expand folders in the SSH Explorer sidebar |
| Open/edit a file | Click any file — it opens in VS Code. Save with **Ctrl+S** to write back |
| Upload a file | Right-click a remote folder → **Upload File** |
| Download a file/folder | Right-click → **Download File** |
| Create a folder | Right-click a folder → **Create Folder** |
| Rename / Move | Right-click → **Rename** (or **F2**) / **Move** |
| Delete | Right-click → **Delete** |
| Copy / Cut / Paste | Right-click → **Copy** (**Ctrl+C**) or **Cut** (**Ctrl+X**), then right-click destination → **Paste** (**Ctrl+V**) |
| Diff remote vs local | Right-click a file → **Diff with Local File** |

### SSH Tools (Utilities)

| Utility | Command |
|---------|---------|
| View and kill remote processes | **Show Remote Processes** |
| Manage systemd services | **Manage Remote Service** |
| Inspect environment variables | **Show Remote Environment** |
| View/edit crontab | **Edit Remote Crontab** → **Save Remote Crontab** |
| Run a saved command snippet | **Run Snippet** |
| Add a custom snippet | **Add Snippet** |
| Run a command on many hosts | **Batch Command on Hosts** |
| Run a local script on remote | **Run Local Script on Remote** |
| Generate an SSH key pair | **Generate SSH Key** |
| Install a public key on a host | **Push Public Key to Host** |

### Connection Management

| Action | How |
|--------|-----|
| Add a host | Click **+** in the SSH Hosts panel or run **Add SSH Host** |
| Connect | Click the host or run **Connect to Host** (**Ctrl+Shift+C**) |
| Open terminal | Click the terminal icon or **Ctrl+Shift+T** |
| Port forward | Run **Forward Port** |
| Monitor server | Right-click connected host → **Monitor Server** |

---

*This file is auto-generated. Do not edit by hand — run \`npm run docs:commands\` to refresh.*
`;

// ── Write output ──────────────────────────────────────────────────────────────

const outPath = path.join(root, 'docs', 'COMMANDS.md');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, md, 'utf8');

const lineCount = md.split('\n').length;
console.log(`docs/COMMANDS.md written (${lineCount} lines, ${commands.length} commands, v${version})`);
