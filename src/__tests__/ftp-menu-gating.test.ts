/**
 * Guards the FTP UI gating (issue #9).
 *
 * FTP tree rows carry a `.ftp` marker right after their base contextValue
 * (connection.ftp / file.ftp / folder.ftp / connectedServer.ftp). Shell-only
 * commands must NOT appear on those rows; this test fails if a shell-only menu
 * entry stops excluding `.ftp`, or if the shared filename-filter commands stop
 * matching FTP rows.
 */
import pkg from '../../package.json';

const SSH_ONLY = new Set([
  'sshLite.openTerminal', 'sshLite.openTerminalHere', 'sshLite.monitor',
  'sshLite.showRemoteProcesses', 'sshLite.manageRemoteService', 'sshLite.showRemoteEnv',
  'sshLite.editRemoteCron', 'sshLite.runSnippet', 'sshLite.runLocalScriptRemote',
  'sshLite.pushPubKeyToHost', 'sshLite.searchInScope', 'sshLite.indexFolder',
  'sshLite.openServerBackupFolder', 'sshLite.showAllBackups', 'sshLite.showFileBackups',
  'sshLite.showServerBackups', 'sshLite.showBackupLogs', 'sshLite.showChanges',
  'sshLite.newFileAsRoot', 'sshLite.diffWithLocal', 'sshLite.enableSudoMode',
  'sshLite.disableSudoMode', 'sshLite.showProperties',
]);

// Copy/cut/paste are NOW supported over FTP (issue #14): same-host copy is
// client-mediated (download+re-upload), cut uses FTP rename, and cross-host
// already streamed via readFile/writeFile. They must therefore appear on FTP
// rows, so they are intentionally NOT in SSH_ONLY above.

type MenuEntry = { command: string; when?: string; group?: string };
const menus: MenuEntry[] = (pkg as any).contributes.menus['view/item/context'];

const canonicalInlineSlots = new Map([
  ['sshLite.searchInScope', 'inline@1'],
  ['sshLite.filterFileNames', 'inline@2'],
  ['sshLite.clearFilenameFilter', 'inline@2'],
  ['sshLite.openTerminalHere', 'inline@3'],
  ['sshLite.refreshItem', 'inline@4'],
]);

const canonicalInlineEntries: ReadonlyArray<readonly [string, string, string]> = [
  ['sshLite.searchInScope', 'view == sshLite.fileExplorer && viewItem =~ /^connection(?!\\.ftp)/', 'inline@1'],
  ['sshLite.searchInScope', 'view == sshLite.fileExplorer && viewItem =~ /^file(?!\\.ftp)/', 'inline@1'],
  ['sshLite.searchInScope', 'view == sshLite.fileExplorer && viewItem =~ /^folder(?!\\.ftp)/', 'inline@1'],
  ['sshLite.filterFileNames', 'view == sshLite.fileExplorer && viewItem =~ /^connection(\\.ftp)?$/', 'inline@2'],
  ['sshLite.filterFileNames', 'view == sshLite.fileExplorer && viewItem =~ /^folder(\\.ftp)?$/', 'inline@2'],
  ['sshLite.clearFilenameFilter', 'view == sshLite.fileExplorer && viewItem =~ /^connection(\\.ftp)?\\.filtered$/', 'inline@2'],
  ['sshLite.clearFilenameFilter', 'view == sshLite.fileExplorer && viewItem =~ /^folder(\\.ftp)?\\.filtered$/', 'inline@2'],
  ['sshLite.openFile', 'view == sshLite.fileExplorer && viewItem =~ /^file/', 'inline@2'],
  ['sshLite.disconnect', 'view == sshLite.fileExplorer && viewItem =~ /^(connection|reconnecting)/', 'inline@3'],
  ['sshLite.openTerminalHere', 'view == sshLite.fileExplorer && viewItem =~ /^file(?!\\.ftp)/', 'inline@3'],
  ['sshLite.openTerminalHere', 'view == sshLite.fileExplorer && viewItem =~ /^folder(?!\\.ftp)/', 'inline@3'],
  ['sshLite.openTerminal', 'view == sshLite.fileExplorer && viewItem =~ /^connection(?!\\.ftp)/', 'inline@4'],
  ['sshLite.refreshItem', 'view == sshLite.fileExplorer && viewItem =~ /^file/', 'inline@4'],
  ['sshLite.refreshItem', 'view == sshLite.fileExplorer && viewItem =~ /^folder/', 'inline@4'],
  ['sshLite.monitor', 'view == sshLite.fileExplorer && viewItem =~ /^connection(?!\\.ftp)/', 'inline@5'],
];

const sortEntries = (entries: ReadonlyArray<readonly string[]>) =>
  [...entries].sort((left, right) => left.join('\0').localeCompare(right.join('\0')));

const hasCanonicalInlineEntries = (entries: MenuEntry[]): boolean => {
  const actual = entries
    .filter(entry => entry.when?.includes('sshLite.fileExplorer') && entry.group?.startsWith('inline@'))
    .map(entry => [entry.command, entry.when!, entry.group!] as const);
  const expected = canonicalInlineEntries;
  return JSON.stringify(sortEntries(actual)) === JSON.stringify(sortEntries(expected));
};

// Entries whose `when` targets a base contextValue an FTP row could carry.
const targetsFtpCapableRow = (when: string): boolean =>
  /viewItem =~ \/\^\(?(connection|file|folder|connectedServer)/.test(when);

describe('FTP menu gating (issue #9)', () => {
  it('hides every shell-only command from FTP rows via a (?!\\.ftp) lookahead', () => {
    const offenders: string[] = [];
    for (const m of menus) {
      if (!m.when || !SSH_ONLY.has(m.command)) continue;
      if (!targetsFtpCapableRow(m.when)) continue;
      if (!m.when.includes('(?!\\.ftp)')) {
        offenders.push(`${m.command} [${m.group}] :: ${m.when}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the filename-filter commands available on FTP rows', () => {
    const filterEntries = menus.filter(
      (m) => m.command === 'sshLite.filterFileNames' || m.command === 'sshLite.clearFilenameFilter'
    );
    expect(filterEntries.length).toBeGreaterThan(0);
    for (const m of filterEntries) {
      expect(m.when).toContain('(\\.ftp)?');
    }
  });

  it('does not place two file-explorer inline icons in the same slot for any single viewItem', () => {
    // For each concrete viewItem we care about, no two visible inline commands
    // may share an inline@N slot (would visually collide / overwrite).
    const rows = ['connection', 'connection.ftp', 'file', 'file.ftp', 'folder', 'folder.ftp'];
    const matches = (when: string, viewItem: string): boolean => {
      const m = when.match(/viewItem =~ (\/[^/]*\/(?:[a-z]*)?)|viewItem == (\S+)/);
      if (!m) return false;
      if (m[2]) return m[2] === viewItem;
      try {
        // Build a JS RegExp from the VS Code regex literal (strip slashes).
        const body = m[1].replace(/^\//, '').replace(/\/$/, '');
        return new RegExp(body).test(viewItem);
      } catch {
        return false;
      }
    };
    for (const row of rows) {
      const slots = new Map<string, string>();
      for (const e of menus) {
        if (!e.when || !e.when.includes('sshLite.fileExplorer')) continue;
        if (!e.group || !e.group.startsWith('inline@')) continue;
        if (!matches(e.when, row)) continue;
        const prev = slots.get(e.group);
        if (prev && prev !== e.command) {
          throw new Error(`inline slot collision on '${row}' ${e.group}: ${prev} vs ${e.command}`);
        }
        slots.set(e.group, e.command);
      }
    }
  });

  it('keeps shared file-explorer row commands in their canonical inline slots', () => {
    expect(hasCanonicalInlineEntries(menus)).toBe(true);
    for (const [command, expectedSlot] of canonicalInlineSlots) {
      const slots = [...new Set(menus
        .filter(entry => entry.command === command
          && entry.when?.includes('sshLite.fileExplorer')
          && entry.group?.startsWith('inline@'))
        .map(entry => entry.group!))];
      expect(slots).toEqual([expectedSlot]);
    }

    const slotsByCommand = new Map<string, Set<string>>();
    for (const entry of menus) {
      if (!entry.when?.includes('sshLite.fileExplorer') || !entry.group?.startsWith('inline@')) continue;
      const slots = slotsByCommand.get(entry.command) ?? new Set<string>();
      slots.add(entry.group);
      slotsByCommand.set(entry.command, slots);
    }
    for (const slots of slotsByCommand.values()) {
      expect(slots.size).toBe(1);
    }
  });

  it('detects a shared command moved from its canonical File Explorer row', () => {
    const moved = menus.map(entry => entry.command === 'sshLite.searchInScope'
      && entry.when === 'view == sshLite.fileExplorer && viewItem =~ /^connection(?!\\.ftp)/'
      && entry.group === 'inline@1'
      ? { ...entry, when: 'view == sshLite.fileExplorer && viewItem =~ /^file(?!\\.ftp)/' }
      : entry);

    expect(hasCanonicalInlineEntries(moved)).toBe(false);
  });
});
