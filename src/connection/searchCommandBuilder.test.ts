// Unit tests for the pure remote-search command builders. No ssh2/vscode — these
// are deterministic string transforms, so every flag combination, escaping rule,
// and the strategy-selection matrix can be asserted directly.

import {
  RemoteSearchTools,
  LEGACY_TOOLS,
  escapeForSingleQuotes,
  validateMaxResults,
  shouldUseCLocale,
  shouldFallbackToLegacy,
  buildContentSearchCommand,
  buildFilenameSearchCommand,
  buildLocateCommand,
  buildToolProbeCommand,
  parseToolProbeOutput,
  describeStrategy,
  ContentSearchOpts,
  FilenameSearchOpts,
} from './searchCommandBuilder';

const baseContent: ContentSearchOpts = {
  pattern: 'foo',
  searchPaths: ['/home'],
  caseSensitive: false,
  regex: false,
  wholeWord: false,
  filePattern: '*',
  excludePattern: '',
  maxResults: 2000,
};

const baseFilename: FilenameSearchOpts = {
  pattern: 'foo',
  searchPaths: ['/home'],
  caseSensitive: false,
  excludePattern: '',
  maxResults: 2000,
  findType: 'f',
};

function toolsWith(partial: Partial<RemoteSearchTools>): RemoteSearchTools {
  return { ...LEGACY_TOOLS, ...partial };
}

describe('escapeForSingleQuotes', () => {
  it('escapes embedded single quotes with the close/escape/reopen idiom', () => {
    expect(escapeForSingleQuotes("it's")).toBe("it'\\''s");
  });
  it('leaves quote-free strings unchanged', () => {
    expect(escapeForSingleQuotes('node_modules')).toBe('node_modules');
  });
});

describe('validateMaxResults', () => {
  it('keeps 0 as unlimited', () => expect(validateMaxResults(0)).toBe(0));
  it('clamps negatives to 1', () => expect(validateMaxResults(-5)).toBe(1));
  it('floors floats', () => expect(validateMaxResults(12.9)).toBe(12));
  it('defaults garbage to 2000', () => expect(validateMaxResults(NaN)).toBe(2000));
});

describe('shouldUseCLocale', () => {
  it('true for case-sensitive ASCII fixed-string', () => {
    expect(shouldUseCLocale('Error', true, false)).toBe(true);
  });
  it('false for regex (locale changes class semantics)', () => {
    expect(shouldUseCLocale('Error', true, true)).toBe(false);
  });
  it('false for non-ASCII query', () => {
    expect(shouldUseCLocale('café', true, false)).toBe(false);
  });
  it('false for case-insensitive with letters (Unicode case-fold loss)', () => {
    expect(shouldUseCLocale('error', false, false)).toBe(false);
  });
  it('true for case-insensitive with no letters', () => {
    expect(shouldUseCLocale('1234', false, false)).toBe(true);
    expect(shouldUseCLocale('===', false, false)).toBe(true);
  });
});

describe('buildContentSearchCommand — legacy grep', () => {
  it('matches the historical grep shape with -F and -i by default', () => {
    const { command, tool, isNative } = buildContentSearchCommand(baseContent, LEGACY_TOOLS);
    expect(tool).toBe('grep');
    expect(isNative).toBe(false);
    expect(command).toMatch(/^grep -rnHI -F  -i /);
    expect(command).toContain("--include='*'");
    expect(command).toContain("-m 2000 -- 'foo' '/home' 2>/dev/null | head -2000");
  });

  it('omits -F in regex mode', () => {
    const { command } = buildContentSearchCommand({ ...baseContent, regex: true }, LEGACY_TOOLS);
    expect(command).not.toContain('-F');
  });

  it('adds -w for whole word', () => {
    const { command } = buildContentSearchCommand({ ...baseContent, wholeWord: true }, LEGACY_TOOLS);
    expect(command).toContain('-w');
  });

  it('applies both --exclude and --exclude-dir per pattern', () => {
    const { command } = buildContentSearchCommand({ ...baseContent, excludePattern: '*uat*, node_modules' }, LEGACY_TOOLS);
    expect(command).toContain("--exclude='*uat*' --exclude-dir='*uat*'");
    expect(command).toContain("--exclude='node_modules' --exclude-dir='node_modules'");
  });

  it('prepends LC_ALL=C only for case-sensitive ASCII fixed-string', () => {
    const sensitive = buildContentSearchCommand({ ...baseContent, caseSensitive: true, pattern: 'Error' }, LEGACY_TOOLS);
    expect(sensitive.command.startsWith('LC_ALL=C grep ')).toBe(true);
    const insensitive = buildContentSearchCommand({ ...baseContent, pattern: 'error' }, LEGACY_TOOLS);
    expect(insensitive.command.startsWith('grep ')).toBe(true);
  });

  it('escapes a shell-injection pattern as a literal grep argument', () => {
    const { command } = buildContentSearchCommand({ ...baseContent, pattern: "'; cat /etc/shadow; echo '" }, LEGACY_TOOLS);
    expect(command).toContain("'\\''");
    expect(command).toMatch(/^grep /);
  });
});

describe('buildContentSearchCommand — ripgrep', () => {
  const rgTools = toolsWith({ rg: '/usr/bin/rg' });

  it('uses --no-ignore --hidden for grep parity (the correctness keystone)', () => {
    const { command, tool, isNative, requireLineNumber } = buildContentSearchCommand(baseContent, rgTools);
    expect(tool).toBe('rg');
    expect(isNative).toBe(true);
    expect(requireLineNumber).toBe(true);
    expect(command).toContain('--no-ignore');
    expect(command).toContain('--hidden');
    expect(command).toContain('--no-heading');
    // No 2>/dev/null on the native path — stderr is captured for fallback.
    expect(command).not.toContain('2>/dev/null');
  });

  it('maps include globs to -g and excludes to -g !glob', () => {
    const { command } = buildContentSearchCommand({ ...baseContent, filePattern: '*.ts, *.js', excludePattern: 'node_modules' }, rgTools);
    expect(command).toContain("-g '*.ts'");
    expect(command).toContain("-g '*.js'");
    expect(command).toContain("-g '!node_modules'");
  });

  it('maps -F/-w/-i flags', () => {
    const { command } = buildContentSearchCommand({ ...baseContent, wholeWord: true }, rgTools);
    expect(command).toContain('-F');
    expect(command).toContain('-w');
    expect(command).toContain('-i');
  });

  it('forceLegacy bypasses rg even when present', () => {
    const { tool } = buildContentSearchCommand(baseContent, rgTools, true);
    expect(tool).toBe('grep');
  });

  it('skips rg when marked degraded (rg path cleared)', () => {
    const degraded = toolsWith({ rg: undefined, degraded: ['rg'] });
    const { tool } = buildContentSearchCommand(baseContent, degraded);
    expect(tool).not.toBe('rg');
  });
});

describe('buildContentSearchCommand — xargs grep (busybox + multi-core)', () => {
  it('uses find|xargs grep when grep is non-GNU and filters are needed (busybox fix)', () => {
    const busybox = toolsWith({ grepFlavor: 'other', xargsFlavor: 'other', nproc: 1 });
    const { command, tool } = buildContentSearchCommand({ ...baseContent, filePattern: '*.ts' }, busybox);
    expect(tool).toBe('xargs-grep');
    expect(command).toContain('-print0');
    expect(command).toContain('xargs -0');
    expect(command).toContain("-name '*.ts'");
    expect(command).not.toContain('-P '); // single core → no parallelism
    // find's own stderr is suppressed so benign "Permission denied" traversal
    // noise on restricted trees can't trigger a false fallback; xargs/grep
    // stderr stays visible for real tool failures.
    expect(command).toContain('-print0 2>/dev/null |');
  });

  it('uses parallel xargs -P on multi-core GNU hosts without rg', () => {
    const multi = toolsWith({ grepFlavor: 'gnu', xargsFlavor: 'gnu', nproc: 16 });
    const { command, tool } = buildContentSearchCommand(baseContent, multi);
    expect(tool).toBe('xargs-grep');
    expect(command).toContain('-P 8'); // capped at 8
  });

  it('busybox with NO filters falls through to plain legacy grep WITHOUT --include', () => {
    const busybox = toolsWith({ grepFlavor: 'other', xargsFlavor: 'other', nproc: 1 });
    const { tool, command } = buildContentSearchCommand(baseContent, busybox);
    expect(tool).toBe('grep');
    // GNU-only flags must be omitted on busybox — even the default --include='*'
    // makes busybox grep exit 2 (silent 0 results under 2>/dev/null).
    expect(command).not.toContain('--include');
    expect(command).not.toContain('--exclude');
    expect(command).toMatch(/^grep -rnHI /);
  });

  it('busybox forceLegacy fallback also omits GNU-only filter flags', () => {
    const busybox = toolsWith({ grepFlavor: 'other', xargsFlavor: 'other' });
    const { command } = buildContentSearchCommand({ ...baseContent, filePattern: '*.ts', excludePattern: 'node_modules' }, busybox, true);
    expect(command).not.toContain('--include');
    expect(command).not.toContain('--exclude');
  });
});

describe('buildFilenameSearchCommand — legacy find -prune', () => {
  it('uses plain find with explicit -iname when no excludes', () => {
    const { command, tool, isNative } = buildFilenameSearchCommand(baseFilename, LEGACY_TOOLS);
    expect(tool).toBe('find');
    expect(isNative).toBe(false);
    expect(command).toBe("find '/home' -type f -iname '*foo*' 2>/dev/null | head -2000");
  });

  it('uses -prune with explicit -print when excludes present', () => {
    const { command } = buildFilenameSearchCommand({ ...baseFilename, excludePattern: 'node_modules, .git' }, LEGACY_TOOLS);
    expect(command).toContain("\\( -name 'node_modules' -o -name '.git' \\) -prune -o");
    expect(command).toContain('-print');
  });

  it('honors findType both/d', () => {
    expect(buildFilenameSearchCommand({ ...baseFilename, findType: 'd' }, LEGACY_TOOLS).command).toContain('-type d');
    expect(buildFilenameSearchCommand({ ...baseFilename, findType: 'both' }, LEGACY_TOOLS).command).toContain('\\( -type f -o -type d \\)');
  });

  it('uses -name (case-sensitive) when requested', () => {
    const { command } = buildFilenameSearchCommand({ ...baseFilename, caseSensitive: true }, LEGACY_TOOLS);
    expect(command).toContain("-name '*foo*'");
    expect(command).not.toContain('-iname');
  });
});

describe('buildFilenameSearchCommand — fd', () => {
  const fdTools = toolsWith({ fd: '/usr/bin/fd', os: 'linux' });

  it('uses fd with --hidden --no-ignore and explicit case flag for single-path search', () => {
    const { command, tool, isNative } = buildFilenameSearchCommand(baseFilename, fdTools);
    expect(tool).toBe('fd');
    expect(isNative).toBe(true);
    expect(command).toContain('--hidden');
    expect(command).toContain('--no-ignore');
    expect(command).toContain('--ignore-case');
    expect(command).toContain('--type f');
  });

  it('falls back to find for multi-path search (fd takes one root)', () => {
    const { tool } = buildFilenameSearchCommand({ ...baseFilename, searchPaths: ['/a', '/b'] }, fdTools);
    expect(tool).toBe('find');
  });

  it('passes --case-sensitive when requested (never smart-case)', () => {
    const { command } = buildFilenameSearchCommand({ ...baseFilename, caseSensitive: true }, fdTools);
    expect(command).toContain('--case-sensitive');
  });
});

describe('buildFilenameSearchCommand — mdfind (macOS)', () => {
  it('uses mdfind -onlyin scoped to the folder on Darwin', () => {
    const mac = toolsWith({ os: 'darwin', mdfind: '/usr/bin/mdfind' });
    const { command, tool } = buildFilenameSearchCommand(baseFilename, mac);
    expect(tool).toBe('mdfind');
    expect(command).toContain("-onlyin '/home'");
    expect(command).toContain("-name '*foo*'");
  });

  it('does not use mdfind off Darwin even if the binary is reported', () => {
    const linux = toolsWith({ os: 'linux', mdfind: '/usr/bin/mdfind' });
    const { tool } = buildFilenameSearchCommand(baseFilename, linux);
    expect(tool).toBe('find');
  });
});

describe('buildLocateCommand', () => {
  it('returns null when no locate tool is present', () => {
    expect(buildLocateCommand('/home', 'foo', false, 500, LEGACY_TOOLS)).toBeNull();
  });

  it('builds a plocate pipeline with a prefix grep and -i for case-insensitive', () => {
    const tools = toolsWith({ plocate: '/usr/bin/plocate' });
    const built = buildLocateCommand('/home/user', 'foo', false, 500, tools)!;
    expect(built.tool).toBe('locate');
    expect(built.command).toContain("'/usr/bin/plocate' -i -- 'foo'");
    // Anchor carries a trailing slash so a sibling dir cannot match and steal head.
    expect(built.command).toContain("grep -F -- '/home/user/'");
    expect(built.command).toContain('head -500');
  });
});

describe('buildToolProbeCommand / parseToolProbeOutput', () => {
  it('probe command checks all tools, flavors, os, nproc', () => {
    const probe = buildToolProbeCommand();
    expect(probe).toContain('command -v');
    expect(probe).toContain('grep --version');
    expect(probe).toContain('uname -s');
    expect(probe).toContain('nproc');
  });

  it('parses a GNU multi-core profile with rg+fd', () => {
    const out = [
      'rg=/usr/bin/rg',
      'fd=none',
      'fdfind=/usr/bin/fdfind',
      'plocate=/usr/bin/plocate',
      'locate=/usr/bin/locate',
      'mdfind=none',
      'grepv=grep (GNU grep) 3.7',
      'xargsv=xargs (GNU findutils) 4.8.0',
      'os=Linux',
      'nproc=8',
    ].join('\n');
    const tools = parseToolProbeOutput(out);
    expect(tools.rg).toBe('/usr/bin/rg');
    expect(tools.fd).toBe('/usr/bin/fdfind'); // fdfind fallback name
    expect(tools.plocate).toBe('/usr/bin/plocate');
    expect(tools.mdfind).toBeUndefined();
    expect(tools.grepFlavor).toBe('gnu');
    expect(tools.xargsFlavor).toBe('gnu');
    expect(tools.os).toBe('linux');
    expect(tools.nproc).toBe(8);
  });

  it('parses a busybox profile (non-GNU grep, no tools)', () => {
    const out = [
      'rg=none', 'fd=none', 'fdfind=none', 'plocate=none', 'locate=none', 'mdfind=none',
      'grepv=', 'xargsv=', 'os=Linux', 'nproc=1',
    ].join('\n');
    const tools = parseToolProbeOutput(out);
    expect(tools.rg).toBeUndefined();
    expect(tools.grepFlavor).toBe('unknown');
    expect(tools.nproc).toBe(1);
  });

  it('parses a Darwin profile with mdfind', () => {
    const out = ['rg=none', 'fd=none', 'mdfind=/usr/bin/mdfind', 'grepv=', 'os=Darwin', 'nproc=10'].join('\n');
    const tools = parseToolProbeOutput(out);
    expect(tools.os).toBe('darwin');
    expect(tools.mdfind).toBe('/usr/bin/mdfind');
  });

  it('never throws on garbage / partial output and defaults conservatively', () => {
    expect(() => parseToolProbeOutput('')).not.toThrow();
    const tools = parseToolProbeOutput('garbage\n\x00\nrandom=stuff');
    expect(tools.os).toBe('unknown');
    expect(tools.nproc).toBe(1);
    expect(tools.grepFlavor).toBe('unknown');
  });

  it('rejects non-absolute command -v output (shell builtins)', () => {
    const tools = parseToolProbeOutput('rg=rg\nfd=none');
    expect(tools.rg).toBeUndefined();
  });
});

describe('shouldFallbackToLegacy', () => {
  it('falls back on exec error', () => {
    expect(shouldFallbackToLegacy({ resultCount: 0, stderrText: '', aborted: false, execError: true })).toBe(true);
  });
  it('falls back on 0 results WITH stderr (silent exit-2 class)', () => {
    expect(shouldFallbackToLegacy({ resultCount: 0, stderrText: 'grep: unknown option', aborted: false, execError: false })).toBe(true);
  });
  it('does NOT fall back on 0 results with clean stderr (genuinely no matches)', () => {
    expect(shouldFallbackToLegacy({ resultCount: 0, stderrText: '', aborted: false, execError: false })).toBe(false);
  });
  it('does NOT fall back when aborted', () => {
    expect(shouldFallbackToLegacy({ resultCount: 0, stderrText: 'x', aborted: true, execError: true })).toBe(false);
  });
  it('does NOT fall back when there are results', () => {
    expect(shouldFallbackToLegacy({ resultCount: 5, stderrText: 'a warning', aborted: false, execError: false })).toBe(false);
  });
});

describe('describeStrategy', () => {
  it('distinguishes busybox vs multi-core xargs by grep flavor', () => {
    expect(describeStrategy('xargs-grep', toolsWith({ grepFlavor: 'gnu' }))).toBe('multi-core-xargs');
    expect(describeStrategy('xargs-grep', toolsWith({ grepFlavor: 'other' }))).toBe('busybox-pipeline');
  });
  it('labels each native tool', () => {
    expect(describeStrategy('rg', LEGACY_TOOLS)).toBe('rg-detected');
    expect(describeStrategy('fd', LEGACY_TOOLS)).toBe('fd-detected');
    expect(describeStrategy('mdfind', LEGACY_TOOLS)).toBe('darwin-mdfind');
  });
});
