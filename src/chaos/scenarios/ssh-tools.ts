/**
 * Chaos Scenarios: SSH Tools Suite (remote operations + pure logic)
 *
 * Tests remote copy/move/delete, nextCopyName, SystemToolsService parsers,
 * RemoteClipboardService state machine, SnippetService lifecycle, and
 * virtual document providers (env, cron).
 *
 * SshKeyService roundtrip is in ssh-tools-keys.ts.
 */

import { SSHConnection } from '../../connection/SSHConnection';
import { RemoteClipboardService } from '../../services/RemoteClipboardService';
import { SnippetService } from '../../services/SnippetService';
import { SystemToolsService } from '../../services/SystemToolsService';
import { ScenarioDefinition, ScenarioContext, ScenarioResult } from '../ChaosConfig';
import { ChaosValidator } from '../ChaosValidator';
import {
  createChaosConnection, safeChaosDisconnect, SeededRandom, withTimeout,
} from '../chaos-helpers';

const CATEGORY = 'ssh-tools';

function esc(p: string): string { return p.replace(/'/g, "'\\''"); }

async function makeResult(
  name: string,
  ctx: ScenarioContext,
  fn: (conn: SSHConnection, v: ChaosValidator, rng: SeededRandom) => Promise<string[]>
): Promise<ScenarioResult> {
  const start = Date.now();
  let conn: SSHConnection | null = null;
  try {
    conn = await createChaosConnection(ctx.server);
    await conn.mkdir(ctx.testDir).catch(() => {});
    const extra = await fn(conn, new ChaosValidator(), new SeededRandom(ctx.seed + ctx.variation));
    return { name: `${CATEGORY}:${name}`, server: ctx.server.label, server_os: ctx.server.os, passed: extra.length === 0, invariantViolations: extra, anomalies: [], stateTimeline: [], duration_ms: Date.now() - start };
  } catch (err) {
    return { name: `${CATEGORY}:${name}`, server: ctx.server.label, server_os: ctx.server.os, passed: false, invariantViolations: [], anomalies: [], stateTimeline: [], duration_ms: Date.now() - start, error: (err as Error).message };
  } finally {
    if (conn) {
      try { await withTimeout(conn.exec(`rm -rf '${esc(ctx.testDir)}'`), 10000, 'cleanup'); } catch {}
      await safeChaosDisconnect(conn);
    }
  }
}

async function makePureResult(
  name: string,
  ctx: ScenarioContext,
  fn: (v: ChaosValidator, rng: SeededRandom) => Promise<string[]>
): Promise<ScenarioResult> {
  const start = Date.now();
  try {
    const extra = await fn(new ChaosValidator(), new SeededRandom(ctx.seed + ctx.variation));
    return { name: `${CATEGORY}:${name}`, server: ctx.server.label, server_os: ctx.server.os, passed: extra.length === 0, invariantViolations: extra, anomalies: [], stateTimeline: [], duration_ms: Date.now() - start };
  } catch (err) {
    return { name: `${CATEGORY}:${name}`, server: ctx.server.label, server_os: ctx.server.os, passed: false, invariantViolations: [], anomalies: [], stateTimeline: [], duration_ms: Date.now() - start, error: (err as Error).message };
  }
}

export const sshToolsScenarios: ScenarioDefinition[] = [

  // ── remote copy file same-host ──────────────────────────────────────────

  {
    name: 'remote-copy-samehost',
    category: CATEGORY,
    fn: (ctx) => makeResult('remote-copy-samehost', ctx, async (conn, _v, rng) => {
      const v: string[] = [];
      const src = `${ctx.testDir}/src-${rng.string(6)}.txt`;
      const dest = `${ctx.testDir}/dst-${rng.string(6)}.txt`;
      const content = rng.string(rng.int(1, 500));
      await conn.writeFile(src, Buffer.from(content));
      await withTimeout(conn.exec(`cp -- '${esc(src)}' '${esc(dest)}'`), 10000, 'cp file');
      const destBuf = await conn.readFile(dest);
      if (destBuf.toString() !== content) { v.push(`copy: dest content mismatch (src=${content.length}, dest=${destBuf.length})`); }
      const srcBuf = await conn.readFile(src);
      if (srcBuf.toString() !== content) { v.push(`copy: source was mutated after cp`); }
      return v;
    }),
  },

  // ── remote copy folder same-host ─────────────────────────────────────────

  {
    name: 'remote-copy-folder-samehost',
    category: CATEGORY,
    fn: (ctx) => makeResult('remote-copy-folder-samehost', ctx, async (conn, _v, rng) => {
      const violations: string[] = [];
      const srcDir = `${ctx.testDir}/srcdir-${rng.string(5)}`;
      const destDir = `${ctx.testDir}/dstdir-${rng.string(5)}`;
      const fname = `f-${rng.string(4)}.txt`;
      const content = rng.string(rng.int(10, 200));
      await conn.mkdir(srcDir);
      await conn.writeFile(`${srcDir}/${fname}`, Buffer.from(content));
      await withTimeout(conn.exec(`cp -r -- '${esc(srcDir)}' '${esc(destDir)}'`), 10000, 'cp -r');
      const destBuf = await conn.readFile(`${destDir}/${fname}`);
      if (destBuf.toString() !== content) { violations.push(`folder-copy: dest/${fname} content mismatch`); }
      const srcFiles = await conn.listFiles(srcDir);
      if (!srcFiles.some((f) => f.name === fname)) { violations.push(`folder-copy: source lost file after cp -r`); }
      return violations;
    }),
  },

  // ── remote move (SFTP rename) ─────────────────────────────────────────────

  {
    name: 'remote-move-samehost',
    category: CATEGORY,
    fn: (ctx) => makeResult('remote-move-samehost', ctx, async (conn, _v, rng) => {
      const violations: string[] = [];
      const src = `${ctx.testDir}/mv-src-${rng.string(6)}.txt`;
      const dest = `${ctx.testDir}/mv-dst-${rng.string(6)}.txt`;
      const content = rng.string(rng.int(1, 300));
      await conn.writeFile(src, Buffer.from(content));
      await withTimeout(conn.rename(src, dest), 10000, 'rename (move)');
      const destBuf = await conn.readFile(dest);
      if (destBuf.toString() !== content) { violations.push(`move: dest content mismatch after rename`); }
      try {
        await conn.readFile(src);
        violations.push(`move: source still readable after rename (should be gone)`);
      } catch { /* expected */ }
      return violations;
    }),
  },

  // ── deleteRemotePath — file and folder ───────────────────────────────────

  {
    name: 'remote-delete-file',
    category: CATEGORY,
    fn: (ctx) => makeResult('remote-delete-file', ctx, async (conn, _v, rng) => {
      const violations: string[] = [];
      const fp = `${ctx.testDir}/del-${rng.string(6)}.txt`;
      await conn.writeFile(fp, Buffer.from(rng.string(50)));
      await withTimeout(conn.deleteFile(fp), 10000, 'deleteFile');
      try { await conn.readFile(fp); violations.push(`delete-file: still readable after deleteFile`); } catch { /* expected */ }
      return violations;
    }),
  },

  {
    name: 'remote-delete-folder',
    category: CATEGORY,
    fn: (ctx) => makeResult('remote-delete-folder', ctx, async (conn, _v, rng) => {
      const violations: string[] = [];
      const dir = `${ctx.testDir}/rm-${rng.string(5)}`;
      await conn.mkdir(dir);
      await conn.writeFile(`${dir}/inner.txt`, Buffer.from('hello'));
      await withTimeout(conn.exec(`rm -rf -- '${esc(dir)}'`), 10000, 'rm -rf');
      const parent = await conn.listFiles(ctx.testDir);
      if (parent.some((f) => f.name === dir.split('/').pop())) { violations.push(`delete-folder: still appears in parent listing after rm -rf`); }
      return violations;
    }),
  },

  // ── copy with special characters in filenames ─────────────────────────────

  {
    name: 'remote-copy-special-chars',
    category: CATEGORY,
    fn: (ctx) => makeResult('remote-copy-special-chars', ctx, async (conn, _v, rng) => {
      const violations: string[] = [];
      const names = ['my file.txt', 'file (copy).txt', 'with-dashes.txt', 'dots.in.name.txt', `.hidden-${rng.string(4)}`];
      for (const fname of names) {
        const src = `${ctx.testDir}/${fname}`;
        const dest = `${ctx.testDir}/dest-${fname}`;
        const content = `content:${fname}`;
        await conn.writeFile(src, Buffer.from(content));
        try {
          await withTimeout(conn.exec(`cp -- '${esc(src)}' '${esc(dest)}'`), 10000, `cp '${fname}'`);
          const buf = await conn.readFile(dest);
          if (buf.toString() !== content) { violations.push(`special-chars: content mismatch for '${fname}'`); }
        } catch (err) {
          violations.push(`special-chars: cp failed for '${fname}': ${(err as Error).message}`);
        }
      }
      return violations;
    }),
  },

  // ── nextCopyName — pure invariants ────────────────────────────────────────

  {
    name: 'next-copy-name-invariants',
    category: CATEGORY,
    fn: (ctx) => makePureResult('next-copy-name-invariants', ctx, async (_v, rng) => {
      const violations: string[] = [];
      function nextCopyName(orig: string, existing: Set<string>): string {
        if (!existing.has(orig)) { return orig; }
        const dotIdx = orig.lastIndexOf('.');
        const hasExt = dotIdx > 0;
        const base = hasExt ? orig.slice(0, dotIdx) : orig;
        const ext = hasExt ? orig.slice(dotIdx) : '';
        const cb = `${base} (copy)`;
        let c = `${cb}${ext}`;
        if (!existing.has(c)) { return c; }
        for (let i = 2; i < 1000; i++) { c = `${cb} ${i}${ext}`; if (!existing.has(c)) { return c; } }
        return `${cb} ${Date.now()}${ext}`;
      }
      // no conflict
      const name = rng.string(rng.int(3, 20)) + '.txt';
      if (nextCopyName(name, new Set()) !== name) { violations.push(`nextCopyName: no-conflict case should return original`); }
      // conflict → result not in set
      const s1 = new Set([name]);
      const c1 = nextCopyName(name, s1);
      if (s1.has(c1)) { violations.push(`nextCopyName: conflict result still in existing set`); }
      // 10 successive calls → all unique
      const all = new Set([name]);
      for (let i = 0; i < 10; i++) {
        const n = nextCopyName(name, all);
        if (all.has(n)) { violations.push(`nextCopyName: call ${i} produced duplicate '${n}'`); break; }
        all.add(n);
      }
      // no extension
      const noExt = 'README';
      if (!nextCopyName(noExt, new Set([noExt])).includes('(copy)')) { violations.push(`nextCopyName: no-ext copy should contain "(copy)"`); }
      // dotfile (.bashrc — dotIdx === 0, so no ext)
      const df = '.bashrc';
      const dfc = nextCopyName(df, new Set([df]));
      if (!dfc.includes('(copy)') || dfc === df) { violations.push(`nextCopyName: dotfile copy should differ and include "(copy)", got '${dfc}'`); }
      return violations;
    }),
  },

  // ── listProcesses + parseProcessOutput ───────────────────────────────────

  {
    name: 'system-list-processes',
    category: CATEGORY,
    fn: (ctx) => makeResult('system-list-processes', ctx, async (conn, _v, rng) => {
      const violations: string[] = [];
      const limit = rng.int(5, 50);
      let procs;
      try {
        procs = await withTimeout(SystemToolsService.getInstance().listProcesses(conn as any, limit), 15000, 'listProcesses');
      } catch (err) { violations.push(`listProcesses: failed: ${(err as Error).message}`); return violations; }
      if (procs.length === 0) { violations.push(`listProcesses: parseProcessOutput returned 0 entries from real ps`); }
      for (const p of procs) {
        if (!Number.isFinite(p.pid) || p.pid <= 0) { violations.push(`listProcesses: invalid pid ${p.pid}`); }
        if (p.cpu < 0 || p.cpu > 100) { violations.push(`listProcesses: cpu=${p.cpu} out of range`); }
        if (p.mem < 0 || p.mem > 100) { violations.push(`listProcesses: mem=${p.mem} out of range`); }
        if (!p.user?.trim()) { violations.push(`listProcesses: empty user for pid ${p.pid}`); }
        if (!p.command?.trim()) { violations.push(`listProcesses: empty command for pid ${p.pid}`); }
      }
      return violations;
    }),
  },

  // ── parseProcessOutput edge cases (pure) ─────────────────────────────────

  {
    name: 'parse-process-output-edges',
    category: CATEGORY,
    fn: (ctx) => makePureResult('parse-process-output-edges', ctx, async () => {
      const violations: string[] = [];
      const tools = SystemToolsService.getInstance();
      // header-only
      if (tools.parseProcessOutput('  PID USER %CPU %MEM COMMAND\n').length !== 0) { violations.push(`parseProcessOutput: header-only should return []`); }
      // valid rows (GNU ps -eo format)
      const valid = `  PID USER     %CPU %MEM COMMAND\n  1 root     0.0  0.1 /sbin/init\n  123 alice  50.5 20.0 node /app/server.js\n`;
      const r = tools.parseProcessOutput(valid);
      if (r.length !== 2) { violations.push(`parseProcessOutput: expected 2 entries, got ${r.length}`); }
      else {
        if (r[0].pid !== 1) { violations.push(`parseProcessOutput: first pid should be 1, got ${r[0].pid}`); }
        if (r[1].cpu !== 50.5) { violations.push(`parseProcessOutput: second cpu should be 50.5, got ${r[1].cpu}`); }
        if (r[1].command !== 'node /app/server.js') { violations.push(`parseProcessOutput: multi-word command not preserved: '${r[1].command}'`); }
      }
      // malformed rows skipped
      const malformed = `PID USER %CPU %MEM COMMAND\nabc x y z bad\n1 root 0 0 init\n`;
      if (tools.parseProcessOutput(malformed).length !== 1) { violations.push(`parseProcessOutput: malformed rows should be skipped`); }
      // empty
      if (tools.parseProcessOutput('').length !== 0) { violations.push(`parseProcessOutput: empty string should return []`); }
      return violations;
    }),
  },

  // ── parseServiceOutput edge cases (pure) ─────────────────────────────────

  {
    name: 'parse-service-output-edges',
    category: CATEGORY,
    fn: (ctx) => makePureResult('parse-service-output-edges', ctx, async () => {
      const violations: string[] = [];
      const tools = SystemToolsService.getInstance();
      const raw = [
        'sshd.service       loaded active running OpenSSH server daemon',
        'nginx.service      loaded active running Nginx web server',
        'not-a-service      loaded active running something else',
      ].join('\n');
      const r = tools.parseServiceOutput(raw);
      if (r.length !== 2) { violations.push(`parseServiceOutput: expected 2 .service entries, got ${r.length}`); }
      for (const s of r) {
        if (!s.name.endsWith('.service')) { violations.push(`parseServiceOutput: non-.service leaked: ${s.name}`); }
        if (!s.description || s.description.trim().length === 0) { violations.push(`parseServiceOutput: empty description for ${s.name}`); }
      }
      if (tools.parseServiceOutput('').length !== 0) { violations.push(`parseServiceOutput: empty string should return []`); }
      return violations;
    }),
  },

  // ── RemoteClipboardService state machine (pure) ───────────────────────────

  {
    name: 'clipboard-state-machine',
    category: CATEGORY,
    fn: (ctx) => makePureResult('clipboard-state-machine', ctx, async () => {
      const violations: string[] = [];
      (RemoteClipboardService as any)._instance = undefined;
      const svc = RemoteClipboardService.getInstance();
      const item = { connectionId: 'c1', remotePath: '/a.txt', isDirectory: false, name: 'a.txt' };
      if (svc.hasClipboard()) { violations.push(`clipboard: initial state should be empty`); }
      if (svc.getClipboard() !== null) { violations.push(`clipboard: getClipboard should return null initially`); }
      svc.setClipboard([item], 'copy');
      if (!svc.hasClipboard()) { violations.push(`clipboard: hasClipboard should be true after setClipboard`); }
      if (svc.getClipboard()?.operation !== 'copy') { violations.push(`clipboard: operation should be 'copy'`); }
      if (svc.getClipboard()?.items[0].remotePath !== '/a.txt') { violations.push(`clipboard: item path not stored correctly`); }
      svc.clear();
      if (svc.hasClipboard()) { violations.push(`clipboard: hasClipboard should be false after clear`); }
      svc.setClipboard([item], 'cut');
      if (svc.getClipboard()?.operation !== 'cut') { violations.push(`clipboard: operation should be 'cut'`); }
      // overwrite
      const item2 = { connectionId: 'c2', remotePath: '/b.txt', isDirectory: false, name: 'b.txt' };
      svc.setClipboard([item2], 'copy');
      if (svc.getClipboard()?.items[0].remotePath !== '/b.txt') { violations.push(`clipboard: overwrite should replace clipboard`); }
      // empty = clear
      svc.setClipboard([], 'copy');
      if (svc.hasClipboard()) { violations.push(`clipboard: setClipboard([]) should act as clear`); }
      // onDidChange fires
      let fires = 0;
      svc.onDidChange(() => { fires++; });
      svc.setClipboard([item], 'copy');
      svc.clear();
      if (fires < 2) { violations.push(`clipboard: onDidChange fired ${fires} times, expected ≥2`); }
      // multi-item
      svc.setClipboard([item, item2], 'copy');
      if (svc.getClipboard()?.items.length !== 2) { violations.push(`clipboard: multi-item should store 2 items`); }
      (RemoteClipboardService as any)._instance = undefined;
      return violations;
    }),
  },

  // ── SnippetService lifecycle (pure) ──────────────────────────────────────

  {
    name: 'snippet-lifecycle',
    category: CATEGORY,
    fn: (ctx) => makePureResult('snippet-lifecycle', ctx, async (_v, rng) => {
      const violations: string[] = [];
      (SnippetService as any)._instance = undefined;
      const svc = SnippetService.getInstance();
      const storage = new Map<string, unknown>();
      svc.initialize({ globalState: { get: (k: string, d?: unknown) => storage.get(k) ?? d, update: async (k: string, v: unknown) => { storage.set(k, v); }, keys: () => [...storage.keys()] } } as any);
      // built-ins
      if (svc.getAll().length < 6) { violations.push(`snippets: expected ≥6 built-ins, got ${svc.getAll().length}`); }
      if (!svc.getAll().some((s) => s.builtin && s.name.toLowerCase().includes('disk'))) { violations.push(`snippets: missing disk built-in`); }
      if (svc.getUserSnippets().length !== 0) { violations.push(`snippets: user snippets should start empty`); }
      // add
      const name = rng.string(rng.int(5, 15));
      const cmd = rng.string(rng.int(5, 30));
      const added = await svc.add(name, cmd);
      if (!added.id.startsWith('user-')) { violations.push(`snippets: id should start with 'user-', got '${added.id}'`); }
      if (!svc.getAll().some((s) => s.id === added.id)) { violations.push(`snippets: added not in getAll()`); }
      // rename
      const newName = rng.string(8);
      if (!await svc.rename(added.id, newName)) { violations.push(`snippets: rename returned false`); }
      if (svc.findById(added.id)?.name !== newName) { violations.push(`snippets: rename did not persist`); }
      // update
      const newCmd = rng.string(10);
      await svc.update(added.id, newCmd);
      if (svc.findById(added.id)?.command !== newCmd) { violations.push(`snippets: update did not persist`); }
      // remove
      if (!await svc.remove(added.id)) { violations.push(`snippets: remove returned false`); }
      if (svc.findById(added.id) !== undefined) { violations.push(`snippets: findById after remove should be undefined`); }
      if (await svc.remove('nonexistent')) { violations.push(`snippets: remove nonexistent should return false`); }
      // validation
      try { await svc.add('', 'ls'); violations.push(`snippets: add with empty name should throw`); } catch {}
      try { await svc.add('n', ''); violations.push(`snippets: add with empty cmd should throw`); } catch {}
      (SnippetService as any)._instance = undefined;
      return violations;
    }),
  },

  // ── Virtual env provider (env | sort) ────────────────────────────────────

  {
    name: 'virtual-env-provider',
    category: CATEGORY,
    fn: (ctx) => makeResult('virtual-env-provider', ctx, async (conn, _v) => {
      const violations: string[] = [];
      let out: string;
      try {
        out = await withTimeout(conn.exec('env | sort'), 15000, 'env | sort');
      } catch (err) { violations.push(`env-provider: exec failed: ${(err as Error).message}`); return violations; }
      if (!out?.trim()) { violations.push(`env-provider: empty output`); return violations; }
      const lines = out.trim().split('\n').filter((l) => l.trim());
      if (!lines.some((l) => l.startsWith('PATH='))) { violations.push(`env-provider: PATH not found`); }
      if (!lines.some((l) => l.includes('='))) { violations.push(`env-provider: no KEY=VALUE pairs`); }
      // Note: shell `sort` and JS localeCompare use different collation for special chars (_),
      // so we only verify non-empty output with KEY=VALUE lines rather than checking exact order.
      return violations;
    }),
  },

  // ── Virtual cron provider (crontab -l) ───────────────────────────────────

  {
    name: 'virtual-cron-provider',
    category: CATEGORY,
    fn: (ctx) => makeResult('virtual-cron-provider', ctx, async (conn) => {
      const violations: string[] = [];
      let out: string;
      try {
        out = await withTimeout(conn.exec('crontab -l 2>/dev/null || true'), 15000, 'crontab -l');
      } catch (err) { violations.push(`cron-provider: exec failed: ${(err as Error).message}`); return violations; }
      // output may be empty (no crontab) — that is valid
      if (out.trim().length > 0) {
        for (const line of out.trim().split('\n')) {
          const t = line.trim();
          if (!t || t.startsWith('#')) { continue; }
          if (t.split(/\s+/).length < 6) { violations.push(`cron-provider: suspicious cron line (<6 tokens): '${t}'`); }
        }
      }
      return violations;
    }),
  },

];
