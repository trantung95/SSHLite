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
  'sshLite.newFileAsRoot', 'sshLite.pasteRemoteItem', 'sshLite.copyRemoteItem',
  'sshLite.cutRemoteItem', 'sshLite.diffWithLocal', 'sshLite.enableSudoMode',
  'sshLite.showProperties',
]);

type MenuEntry = { command: string; when?: string; group?: string };
const menus: MenuEntry[] = (pkg as any).contributes.menus['view/item/context'];

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
});
