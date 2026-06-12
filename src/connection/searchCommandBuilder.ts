// src/connection/searchCommandBuilder.ts
//
// Pure command builders for remote file search. NO ssh2 / vscode imports — every
// function here is a deterministic string transform so it can be unit-tested
// without a real connection. SSHConnection.searchFiles() consumes these.
//
// Design goals:
//   - The "legacy" tier (grep / find) is the universal fallback that runs on any
//     POSIX shell, including busybox. It is what `forceLegacy` produces and what
//     the runtime fallback re-executes after a native tool fails.
//   - The native tiers (ripgrep, fd, find|xargs -P grep, plocate/locate, mdfind)
//     are selected from a RemoteSearchTools profile discovered by probing the
//     server once per connection. Each native path maps flags so the RESULT SET
//     is identical-or-superset versus grep/find — never fewer results (LITE: true
//     data, no missing).
//   - find -prune and a guarded `LC_ALL=C` prefix are construction-hygiene
//     improvements baked into the legacy tier itself: they apply on every server
//     (even with native tools off) because they change SPEED, not results.

/** ripgrep / fd / xargs flavor classification from `--version` output. */
export type ToolFlavor = 'gnu' | 'other' | 'unknown';

/** Operating-system family of the remote server (from `uname -s`). */
export type ServerOS = 'linux' | 'darwin' | 'bsd' | 'windows' | 'unknown';

/** Which concrete tool a built command invokes — drives parsing + fallback. */
export type SearchTool =
  | 'grep' // legacy GNU/POSIX grep -rnHI
  | 'rg' // ripgrep
  | 'find' // legacy find (with -prune)
  | 'fd' // fd / fdfind
  | 'xargs-grep' // find -print0 | xargs -0 [-P N] grep — busybox fix + multi-core
  | 'locate' // plocate / locate (opt-in indexed)
  | 'mdfind'; // macOS Spotlight

/**
 * Capabilities + fingerprint of a remote server's search tooling, discovered by
 * a single probe exec and cached for the connection lifetime. A tool whose path
 * is `undefined` is either absent or was marked degraded after a runtime failure.
 */
export interface RemoteSearchTools {
  os: ServerOS;
  /** CPU count from `nproc`; used to size `xargs -P` and clamp the worker pool. */
  nproc: number;
  grepFlavor: ToolFlavor;
  xargsFlavor: ToolFlavor;
  rg?: string;
  fd?: string;
  plocate?: string;
  locate?: string;
  mdfind?: string;
  /** Epoch ms when the probe completed (diagnostics only). */
  detectedAt?: number;
  /** Tool names disabled after a runtime failure (diagnostics only). */
  degraded?: string[];
}

/**
 * Conservative profile used when native tools are off or detection failed.
 * grepFlavor 'gnu' keeps the byte-for-byte legacy grep command (the safe default
 * that has shipped for every release to date).
 */
export const LEGACY_TOOLS: RemoteSearchTools = {
  os: 'unknown',
  nproc: 1,
  grepFlavor: 'gnu',
  xargsFlavor: 'gnu',
};

export interface ContentSearchOpts {
  pattern: string;
  searchPaths: string[];
  caseSensitive: boolean;
  regex: boolean;
  wholeWord: boolean;
  /** Raw comma-separated include globs (e.g. "*.ts, *.js"). */
  filePattern: string;
  /** Raw comma-separated exclude globs (e.g. "node_modules, *.log"). */
  excludePattern: string;
  /** Already-validated positive integer, or 0 for unlimited. */
  maxResults: number;
}

export interface FilenameSearchOpts {
  pattern: string;
  searchPaths: string[];
  caseSensitive: boolean;
  excludePattern: string;
  maxResults: number;
  findType: 'f' | 'd' | 'both';
}

export interface BuiltSearchCommand {
  command: string;
  tool: SearchTool;
  /**
   * True for rg / fd / xargs-grep / locate / mdfind — commands that may fail at
   * runtime in a way the legacy tier would not (missing flag, broken binary).
   * Native commands leave stderr UN-redirected so the caller can detect a silent
   * failure (exit!=0, 0 results + stderr) and re-run the legacy command once.
   */
  isNative: boolean;
  /**
   * Content-parser hardening: when true, drop output lines whose second field is
   * not a number. ripgrep can print "path: binary file matches" notes that grep
   * -I silently skips; without this guard those would parse as bogus results.
   */
  requireLineNumber: boolean;
}

// ---------------------------------------------------------------------------
// Escaping + normalization (shared)
// ---------------------------------------------------------------------------

/**
 * Escape a string for embedding inside single quotes in a POSIX shell. Single
 * quotes prevent ALL expansion; the only character needing care is the single
 * quote itself, closed and reopened as '\''. This is the project-wide convention
 * for every remote command (moved verbatim from SSHConnection.searchFiles).
 */
export function escapeForSingleQuotes(str: string): string {
  return str.replace(/'/g, "'\\''");
}

/** Wrap a value in single quotes after escaping. */
function q(str: string): string {
  return `'${escapeForSingleQuotes(str)}'`;
}

/** Validate maxResults: positive integer, or 0 for unlimited. */
export function validateMaxResults(maxResults: number): number {
  return maxResults === 0 ? 0 : Math.max(1, Math.floor(Number(maxResults) || 2000));
}

/** Split a comma-separated glob list into trimmed, non-empty entries. */
function splitPatterns(raw: string): string[] {
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}

/**
 * Decide whether a content grep can safely run under `LC_ALL=C`, which skips
 * UTF-8 decoding and is materially faster on large inputs. ONLY safe when the
 * result set is provably unchanged:
 *   - NOT regex: in C locale, `.`/character classes change meaning on multibyte
 *     text and could MISS matches.
 *   - query is pure ASCII: a multibyte query byte-matches differently per locale.
 *   - case-sensitive OR no alphabetic chars: GNU grep -i Unicode-case-folds in a
 *     UTF-8 locale (e.g. U+212A KELVIN matches 'k'); C locale would silently drop
 *     such lines. Case-sensitive ASCII fixed-string search is byte-identical
 *     because UTF-8 is self-synchronizing.
 */
export function shouldUseCLocale(query: string, caseSensitive: boolean, regex: boolean): boolean {
  if (regex) return false;
  // Pure ASCII = every code unit < 0x80.
  for (let i = 0; i < query.length; i++) {
    if (query.charCodeAt(i) > 0x7f) return false;
  }
  if (caseSensitive) return true;
  // Case-insensitive: safe only when there are no letters to case-fold.
  return !/[a-zA-Z]/.test(query);
}

// ---------------------------------------------------------------------------
// Content search (file contents)
// ---------------------------------------------------------------------------

export function buildContentSearchCommand(
  opts: ContentSearchOpts,
  tools: RemoteSearchTools,
  forceLegacy = false,
): BuiltSearchCommand {
  const max = validateMaxResults(opts.maxResults);
  const headLimit = max > 0 ? ` | head -${max}` : '';
  const paths = opts.searchPaths.map(q).join(' ');
  const includes = splitPatterns(opts.filePattern);
  // A lone '*' is "match all", not a real filter — exclude it from the native
  // tier decisions (legacy grep keeps the full list for byte-identical output).
  const realIncludes = includes.filter((p) => p !== '*');
  const excludes = splitPatterns(opts.excludePattern);

  // --- Native tier: ripgrep -------------------------------------------------
  if (!forceLegacy && tools.rg) {
    return buildRipgrepCommand(opts, tools.rg, realIncludes, excludes, max, headLimit, paths);
  }

  // --- Native tier: find | xargs -P grep ------------------------------------
  // Used when (a) grep is non-GNU and filters are needed — busybox grep lacks
  // --include/--exclude-dir and would exit 2 → silent 0 results — or (b) the
  // server is multi-core GNU with no rg, where parallel grep beats single-thread.
  if (!forceLegacy) {
    const nonGnuNeedsFilters = tools.grepFlavor !== 'gnu' && (realIncludes.length > 0 || excludes.length > 0);
    const multiCore = tools.grepFlavor === 'gnu' && tools.xargsFlavor === 'gnu' && tools.nproc >= 2;
    if (nonGnuNeedsFilters || multiCore) {
      return buildXargsGrepCommand(opts, tools, realIncludes, excludes, max, headLimit);
    }
  }

  // --- Legacy tier: grep -rnHI (with guarded LC_ALL=C) ----------------------
  return buildLegacyGrepCommand(opts, includes, excludes, max, headLimit, paths, tools.grepFlavor);
}

function buildLegacyGrepCommand(
  opts: ContentSearchOpts,
  includes: string[],
  excludes: string[],
  max: number,
  headLimit: string,
  paths: string,
  grepFlavor: ToolFlavor,
): BuiltSearchCommand {
  const escapedPattern = escapeForSingleQuotes(opts.pattern);
  const caseFlag = opts.caseSensitive ? '' : '-i';
  const fixedStringFlag = opts.regex ? '' : '-F';
  const wholeWordFlag = opts.wholeWord ? '-w' : '';
  // --include/--exclude/--exclude-dir are GNU-only. busybox grep exits 2 on them
  // (even the default --include='*'), silently returning 0 results under the
  // command's `2>/dev/null`. Omit them entirely when grep is non-GNU — plain
  // `grep -rnHI` works there. (Real include/exclude filters on a non-GNU grep
  // are routed to the find|xargs path before reaching here; this branch is the
  // no-filter case and the last-resort fallback.)
  let filterFlags: string;
  if (grepFlavor !== 'gnu') {
    filterFlags = '';
  } else {
    const includeFlags = includes.length > 0
      ? includes.map((p) => `--include='${escapeForSingleQuotes(p)}'`).join(' ')
      : "--include='*'";
    let excludeFlags = '';
    for (const ep of excludes) {
      const e = escapeForSingleQuotes(ep);
      excludeFlags += ` --exclude='${e}' --exclude-dir='${e}'`;
    }
    filterFlags = `${includeFlags}${excludeFlags}`;
  }
  const grepMaxFlag = max > 0 ? `-m ${max}` : '';
  const cLocale = shouldUseCLocale(opts.pattern, opts.caseSensitive, opts.regex) ? 'LC_ALL=C ' : '';
  // Preserve the historical (GNU) spacing exactly for byte-identical output.
  const filterSegment = grepFlavor !== 'gnu' ? ' ' : ` ${filterFlags} `;
  const command =
    `${cLocale}grep -rnHI ${fixedStringFlag} ${wholeWordFlag} ${caseFlag}${filterSegment}${grepMaxFlag} -- '${escapedPattern}' ${paths} 2>/dev/null${headLimit}`;
  return { command, tool: 'grep', isNative: false, requireLineNumber: false };
}

function buildRipgrepCommand(
  opts: ContentSearchOpts,
  rgPath: string,
  includes: string[],
  excludes: string[],
  max: number,
  headLimit: string,
  paths: string,
): BuiltSearchCommand {
  // --no-ignore --hidden are the correctness keystone: grep -r respects nothing
  // and walks hidden files, so rg must too or it would return FEWER results.
  // -n --with-filename --no-heading → grep-compatible "file:line:text" output.
  const flags = ['-n', '--with-filename', '--no-heading', '--no-messages', '--no-ignore', '--hidden'];
  if (!opts.regex) flags.push('-F');
  if (opts.wholeWord) flags.push('-w');
  if (!opts.caseSensitive) flags.push('-i');
  if (max > 0) flags.push(`-m ${max}`);
  // Include globs → -g 'glob'; exclude globs → -g '!glob' (gitignore semantics:
  // basename match at any depth, prunes dirs — covers --exclude + --exclude-dir).
  for (const inc of includes) flags.push(`-g '${escapeForSingleQuotes(inc)}'`);
  for (const exc of excludes) flags.push(`-g '!${escapeForSingleQuotes(exc)}'`);
  const command =
    `${q(rgPath)} ${flags.join(' ')} -- '${escapeForSingleQuotes(opts.pattern)}' ${paths}${headLimit}`;
  return { command, tool: 'rg', isNative: true, requireLineNumber: true };
}

function buildXargsGrepCommand(
  opts: ContentSearchOpts,
  tools: RemoteSearchTools,
  includes: string[],
  excludes: string[],
  max: number,
  headLimit: string,
): BuiltSearchCommand {
  // find emits NUL-delimited files (respecting prune-based dir excludes and
  // name-based include globs), xargs feeds them to grep in parallel batches.
  // grep here matches a single file's lines so it needs -nH (no -r). -I skips
  // binaries. Parallelism (-P) only when the server is multi-core GNU.
  const paths = opts.searchPaths.map(q).join(' ');
  const pruneGroup = buildPruneGroup(excludes);
  // Include filter as find -name group (file basename match). When no includes,
  // match all regular files.
  let includeExpr = '-type f';
  if (includes.length > 0) {
    const names = includes.map((inc) => `-name '${escapeForSingleQuotes(inc)}'`).join(' -o ');
    includeExpr = `-type f \\( ${names} \\)`;
  }
  // Suppress find's OWN stderr (e.g. "Permission denied" on unreadable subtrees) —
  // it is benign traversal noise, not a tool failure. If it leaked, a legitimate
  // zero-result search over a restricted tree would look like the silent-exit-2
  // class and trigger a needless legacy fallback. The xargs/grep stderr stays
  // visible so a REAL tool failure is still detectable.
  const findPart = pruneGroup
    ? `find ${paths} ${pruneGroup} -prune -o ${includeExpr} -print0 2>/dev/null`
    : `find ${paths} ${includeExpr} -print0 2>/dev/null`;

  const caseFlag = opts.caseSensitive ? '' : '-i';
  const fixedStringFlag = opts.regex ? '' : '-F';
  const wholeWordFlag = opts.wholeWord ? '-w' : '';
  const grepMaxFlag = max > 0 ? `-m ${max}` : '';
  const cLocale = shouldUseCLocale(opts.pattern, opts.caseSensitive, opts.regex) ? 'LC_ALL=C ' : '';
  const parallel = (tools.xargsFlavor === 'gnu' && tools.nproc >= 2)
    ? ` -P ${Math.min(tools.nproc, 8)}`
    : '';
  const grepPart =
    `xargs -0${parallel} ${cLocale}grep -nHI ${fixedStringFlag} ${wholeWordFlag} ${caseFlag} ${grepMaxFlag} -- '${escapeForSingleQuotes(opts.pattern)}'`;
  // Native: stderr left visible for fallback detection.
  const command = `${findPart} | ${grepPart}${headLimit}`;
  return { command, tool: 'xargs-grep', isNative: true, requireLineNumber: true };
}

// ---------------------------------------------------------------------------
// Filename search (find / fd / locate / mdfind)
// ---------------------------------------------------------------------------

/**
 * Build the `\( -name 'e1' -o -name 'e2' \)` prune group from exclude patterns.
 * Returns '' when there are no excludes. Busybox-safe (\( \), -o, -name).
 */
function buildPruneGroup(excludes: string[]): string {
  if (excludes.length === 0) return '';
  const names = excludes.map((ep) => `-name '${escapeForSingleQuotes(ep)}'`).join(' -o ');
  return `\\( ${names} \\)`;
}

function findTypeExpr(findType: 'f' | 'd' | 'both'): string {
  if (findType === 'f') return '-type f';
  if (findType === 'd') return '-type d';
  return '\\( -type f -o -type d \\)';
}

export function buildFilenameSearchCommand(
  opts: FilenameSearchOpts,
  tools: RemoteSearchTools,
  forceLegacy = false,
): BuiltSearchCommand {
  const max = validateMaxResults(opts.maxResults);
  const headLimit = max > 0 ? ` | head -${max}` : '';

  // --- Native tier: fd ------------------------------------------------------
  // fd takes ONE search root; multi-path searches fall through to find-prune.
  if (!forceLegacy && tools.fd && opts.searchPaths.length === 1) {
    return buildFdCommand(opts, tools.fd, max, headLimit);
  }

  // --- Native tier: mdfind (macOS Spotlight) --------------------------------
  if (!forceLegacy && tools.os === 'darwin' && tools.mdfind && opts.searchPaths.length === 1) {
    return buildMdfindCommand(opts, tools.mdfind, headLimit);
  }

  // --- Legacy tier: find -prune ---------------------------------------------
  return buildLegacyFindCommand(opts, max, headLimit);
}

function buildLegacyFindCommand(
  opts: FilenameSearchOpts,
  _max: number,
  headLimit: string,
): BuiltSearchCommand {
  const paths = opts.searchPaths.map(q).join(' ');
  const nameFlag = opts.caseSensitive ? '-name' : '-iname';
  const typeExpr = findTypeExpr(opts.findType);
  const namePat = `'*${escapeForSingleQuotes(opts.pattern)}*'`;
  const excludes = splitPatterns(opts.excludePattern);
  const pruneGroup = buildPruneGroup(excludes);
  // -prune stops descent into excluded dirs (the old `! -path` still walked
  // them). Explicit -print is mandatory: with -prune present, find's default
  // print would also emit the pruned branch.
  const matchExpr = `${typeExpr} ${nameFlag} ${namePat} -print`;
  const command = pruneGroup
    ? `find ${paths} ${pruneGroup} -prune -o ${matchExpr} 2>/dev/null${headLimit}`
    : `find ${paths} ${typeExpr} ${nameFlag} ${namePat} 2>/dev/null${headLimit}`;
  return { command, tool: 'find', isNative: false, requireLineNumber: false };
}

function buildFdCommand(
  opts: FilenameSearchOpts,
  fdPath: string,
  _max: number,
  headLimit: string,
): BuiltSearchCommand {
  // --hidden --no-ignore mirror find's "walk everything" default. Always pass an
  // explicit case flag — fd defaults to smart-case, a silent behavior change.
  const flags = ['--glob', '--hidden', '--no-ignore'];
  flags.push(opts.caseSensitive ? '--case-sensitive' : '--ignore-case');
  if (opts.findType === 'f') flags.push('--type', 'f');
  else if (opts.findType === 'd') flags.push('--type', 'd');
  else flags.push('--type', 'f', '--type', 'd');
  for (const ep of splitPatterns(opts.excludePattern)) {
    flags.push(`--exclude '${escapeForSingleQuotes(ep)}'`);
  }
  const root = q(opts.searchPaths[0]);
  const command =
    `${q(fdPath)} ${flags.join(' ')} -- '*${escapeForSingleQuotes(opts.pattern)}*' ${root}${headLimit}`;
  return { command, tool: 'fd', isNative: true, requireLineNumber: false };
}

function buildMdfindCommand(
  opts: FilenameSearchOpts,
  mdfindPath: string,
  headLimit: string,
): BuiltSearchCommand {
  // Spotlight name search, scoped to the folder. Substring match via kMDItemFSName.
  // Spotlight is case-insensitive by default; case-sensitive is not reliably
  // expressible, so mdfind is only chosen for case-insensitive filename search.
  const root = q(opts.searchPaths[0]);
  const namePat = `'*${escapeForSingleQuotes(opts.pattern)}*'`;
  const command = `${q(mdfindPath)} -onlyin ${root} -name ${namePat}${headLimit}`;
  return { command, tool: 'mdfind', isNative: true, requireLineNumber: false };
}

// ---------------------------------------------------------------------------
// Indexed filename search (opt-in: plocate / locate)
// ---------------------------------------------------------------------------

/**
 * Build an indexed filename lookup. The server-side `grep -F` only cuts transfer;
 * the CALLER must still anchor results with `startsWith(basePath + '/')` because
 * plocate/mlocate substring-vs-glob semantics differ. Stale by design — caller
 * surfaces the database age. Returns null if no locate tool is present.
 */
export function buildLocateCommand(
  basePath: string,
  pattern: string,
  caseSensitive: boolean,
  maxResults: number,
  tools: RemoteSearchTools,
): BuiltSearchCommand | null {
  const tool = tools.plocate || tools.locate;
  if (!tool) return null;
  const max = validateMaxResults(maxResults);
  const headLimit = max > 0 ? ` | head -${max}` : '';
  const caseFlag = caseSensitive ? '' : '-i ';
  // grep -F prunes the wire to the base path prefix WITH a trailing slash, so a
  // sibling dir like `/home/alice2` cannot match `/home/alice` and steal the
  // `head -N` budget (which would silently drop real results — LITE no-missing).
  // The client still re-anchors with the same prefix as the authority.
  const anchor = basePath.endsWith('/') ? basePath : basePath + '/';
  const command =
    `${q(tool)} ${caseFlag}-- '${escapeForSingleQuotes(pattern)}' 2>/dev/null | LC_ALL=C grep -F -- '${escapeForSingleQuotes(anchor)}'${headLimit}`;
  return { command, tool: 'locate', isNative: true, requireLineNumber: false };
}

/**
 * Best-effort command to read the locate database mtime (ISO-ish), so the UI can
 * show how stale the index is. Tries plocate's DB then mlocate's. Empty output
 * when neither exists — caller treats that as "unknown age".
 */
export function buildIndexStalenessCommand(): string {
  // %Y = mtime as integer epoch SECONDS — locale-independent and trivial to
  // parse (unlike %y, whose nanosecond+timezone format Date.parse mishandles).
  return "stat -c %Y /var/lib/plocate/plocate.db 2>/dev/null || stat -c %Y /var/lib/mlocate/mlocate.db 2>/dev/null || true";
}

// ---------------------------------------------------------------------------
// Server fingerprint probe
// ---------------------------------------------------------------------------

/**
 * One POSIX/busybox-safe command that fingerprints the server's search tooling:
 * tool paths, grep/xargs flavor, OS, and CPU count. Tolerant of missing tools.
 */
export function buildToolProbeCommand(): string {
  return [
    'for t in rg fd fdfind plocate locate mdfind; do printf \'%s=\' "$t"; command -v "$t" 2>/dev/null || echo none; done',
    'printf \'grepv=\'; grep --version 2>/dev/null | head -1; echo',
    'printf \'xargsv=\'; xargs --version 2>/dev/null | head -1; echo',
    'printf \'os=\'; uname -s 2>/dev/null; echo',
    'printf \'nproc=\'; { nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 1; }',
  ].join('; ');
}

/**
 * Parse buildToolProbeCommand() output into a RemoteSearchTools profile. Never
 * throws — unrecognized / partial / garbage output yields conservative defaults.
 */
export function parseToolProbeOutput(stdout: string): RemoteSearchTools {
  const tools: RemoteSearchTools = {
    os: 'unknown',
    nproc: 1,
    grepFlavor: 'unknown',
    xargsFlavor: 'unknown',
  };
  const lines = (stdout || '').split('\n');
  const get = (key: string): string | undefined => {
    for (const line of lines) {
      if (line.startsWith(key + '=')) return line.slice(key.length + 1).trim();
    }
    return undefined;
  };

  const path = (raw: string | undefined): string | undefined => {
    if (!raw || raw === 'none' || raw === '') return undefined;
    // `command -v` may print a shell builtin name; require an absolute path.
    return raw.startsWith('/') ? raw : undefined;
  };

  tools.rg = path(get('rg'));
  tools.fd = path(get('fd')) || path(get('fdfind'));
  tools.plocate = path(get('plocate'));
  tools.locate = path(get('locate'));
  tools.mdfind = path(get('mdfind'));

  const grepv = get('grepv') || '';
  tools.grepFlavor = /GNU grep/i.test(grepv) ? 'gnu' : grepv ? 'other' : 'unknown';
  const xargsv = get('xargsv') || '';
  tools.xargsFlavor = /GNU findutils|GNU xargs/i.test(xargsv) ? 'gnu' : xargsv ? 'other' : 'unknown';

  const os = (get('os') || '').toLowerCase();
  if (os === 'linux') tools.os = 'linux';
  else if (os === 'darwin') tools.os = 'darwin';
  else if (os.includes('bsd')) tools.os = 'bsd';
  else if (os.includes('mingw') || os.includes('cygwin') || os.includes('msys')) tools.os = 'windows';

  const n = parseInt((get('nproc') || '1').trim(), 10);
  tools.nproc = Number.isFinite(n) && n >= 1 ? n : 1;

  return tools;
}

/**
 * Pure decision: should a failed native command fall back to the legacy command?
 *   - exec/spawn error → yes.
 *   - 0 results AND stderr present → yes (the "silent exit 2" class, e.g. busybox
 *     grep choking on --include).
 *   - 0 results AND clean stderr → NO (genuinely no matches; re-running would
 *     double server load for nothing — LITE).
 *   - user aborted → NO.
 */
export function shouldFallbackToLegacy(input: {
  resultCount: number;
  stderrText: string;
  aborted: boolean;
  execError: boolean;
}): boolean {
  if (input.aborted) return false;
  if (input.execError) return true;
  if (input.resultCount === 0 && input.stderrText.trim().length > 0) return true;
  return false;
}

/** Build a short, human label for the strategy chosen — for diagnostic logs. */
export function describeStrategy(tool: SearchTool, tools: RemoteSearchTools): string {
  switch (tool) {
    case 'rg': return 'rg-detected';
    case 'fd': return 'fd-detected';
    case 'xargs-grep': return tools.grepFlavor === 'gnu' ? 'multi-core-xargs' : 'busybox-pipeline';
    case 'mdfind': return 'darwin-mdfind';
    case 'locate': return 'indexed-locate';
    case 'grep': return 'legacy-grep';
    case 'find': return 'legacy-find';
    default: return tool;
  }
}
