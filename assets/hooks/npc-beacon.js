#!/usr/bin/env node
// SSH Lite — NPC hook beacon writer.
//
// Installed (opt-in, via the Support view's gear → "Set up AI hooks" button) into
// an AI coding tool's hook config so the Support-view pixel coder can react to the
// user's prompts. The AI tool runs this on prompt-submit and pipes its hook JSON on
// stdin; we extract only the prompt text (bounded) plus the event/tool name and
// OVERWRITE a single tiny beacon file that SSH Lite watches. No network, no append
// growth, never touches the AI tool's own files.
//
// argv: node npc-beacon.js <beaconFilePath> <toolId>
// It writes (atomically) the LATEST event only: { v, ts, id, event, tool, prompt }.
//
// Designed to never break the host tool: it always exits 0, never writes to stdout
// (which some tools interpret), and fails silently on any error.
'use strict';

const fs = require('fs');
const path = require('path');

const beaconPath = process.argv[2];
const toolId = process.argv[3] || 'ai';
const MAX_PROMPT = 160; // enough for the animation; bounds what is written to disk

function done() {
  // Never surface a non-zero exit — a failing hook must not disrupt the AI tool.
  process.exit(0);
}

if (!beaconPath) {
  done();
}

let raw = '';
let settled = false;

function write(payload) {
  if (settled) {
    return;
  }
  settled = true;
  let prompt;
  if (payload && typeof payload.prompt === 'string') {
    // Single line, trimmed and bounded — never store more than a snippet.
    prompt = payload.prompt.replace(/\s+/g, ' ').trim().slice(0, MAX_PROMPT) || undefined;
  }
  const out = {
    v: 1,
    ts: Date.now(),
    id: toolId,
    event: (payload && (payload.hook_event_name || payload.event)) || undefined,
    tool: (payload && payload.tool_name) || undefined,
    prompt,
  };
  try {
    fs.mkdirSync(path.dirname(beaconPath), { recursive: true });
    // Atomic-ish: write a temp sibling then rename over the target.
    const tmp = beaconPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, beaconPath);
  } catch (e) {
    /* best-effort: a failed beacon write must never break the AI tool */
  }
  done();
}

try {
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (raw.length >= 1_000_000) {
      return; // already have plenty; ignore the rest (keep the JSON head intact)
    }
    raw += chunk;
    if (raw.length > 1_000_000) {
      // Keep the HEAD (where the JSON object opens) so JSON.parse can still work;
      // stop reading the rest. The prompt snippet we want is near the front.
      raw = raw.slice(0, 1_000_000);
      try {
        process.stdin.destroy();
      } catch (e) {
        /* ignore */
      }
    }
  });
  process.stdin.on('end', () => {
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch (e) {
      /* some events provide no stdin JSON — still emit a bare pulse */
    }
    write(payload);
  });
  process.stdin.on('error', () => write(null));
} catch (e) {
  write(null);
}

// Safety: if no stdin arrives (a tool that doesn't pipe input), don't hang.
const t = setTimeout(() => write(null), 1500);
if (t && typeof t.unref === 'function') {
  t.unref();
}
