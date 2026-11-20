/**
 * Regression tests for the FileService hardening fixes:
 *  1. listServerBackups: quoted glob, exact-name filter, index-owner filter
 *  2. nextCopyName: folders have no extension
 *  3. copyRemoteSameHost: folder-into-itself refused before any exec (SSH too)
 *  4. downloadFolder: symlink / broken-link entries skipped and reported
 *  5. shellPath users: restore, delete-backup, preview, directory backup tar
 */

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  mkdirSync: jest.fn(),
  writeFileSync: jest.fn(),
  readFileSync: jest.fn().mockReturnValue('{}'),
  readdirSync: jest.fn().mockReturnValue([]),
  unlinkSync: jest.fn(),
  statSync: jest.fn().mockReturnValue({ mtimeMs: Date.now(), isDirectory: () => false }),
  rmdirSync: jest.fn(),
}));

jest.mock('os', () => ({
  tmpdir: jest.fn().mockReturnValue('/tmp'),
  homedir: jest.fn().mockReturnValue('/home/test'),
  platform: jest.fn().mockReturnValue('linux'),
}));

var mockExec = jest.fn().mockResolvedValue('');
var mockReadFile = jest.fn().mockResolvedValue(Buffer.from('x'));
var mockStat = jest.fn();
var mockListFiles = jest.fn().mockResolvedValue([]);

var mockConnection = {
  id: 'c1',
  host: { name: 'H', host: 'h', port: 22, username: 'u' },
  state: 'connected',
  sudoMode: false,
  capabilities: { type: 'ssh', supportsExec: true, supportsShell: true, supportsPortForward: true, supportsNativeWatch: true, supportsSearch: true, supportsServerBackup: true, supportsSudo: true },
  get exec() { return mockExec; },
  get readFile() { return mockReadFile; },
  get stat() { return mockStat; },
  get listFiles() { return mockListFiles; },
  resolveHomePath: jest.fn().mockResolvedValue('/home/u'),
  rename: jest.fn(),
  mkdir: jest.fn(),
  writeFile: jest.fn(),
  deleteFile: jest.fn(),
};

jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: {
    getInstance: jest.fn().mockImplementation(() => ({
      getConnection: jest.fn().mockReturnValue(mockConnection),
      getAllConnections: jest.fn().mockReturnValue([mockConnection]),
      onDidChangeConnections: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    })),
  },
}));
jest.mock('./AuditService', () => ({
  AuditService: { getInstance: jest.fn().mockReturnValue({ log: jest.fn(), logEdit: jest.fn() }) },
}));
jest.mock('./FolderHistoryService', () => ({
  FolderHistoryService: { getInstance: jest.fn().mockReturnValue({ recordVisit: jest.fn(), getFrequentPaths: jest.fn().mockReturnValue([]) }) },
}));
jest.mock('./ProgressiveDownloadManager', () => ({
  ProgressiveDownloadManager: { getInstance: jest.fn().mockReturnValue({ shouldUseProgressiveDownload: jest.fn().mockReturnValue(false), startProgressiveDownload: jest.fn(), isDownloading: jest.fn().mockReturnValue(false), getLocalPath: jest.fn().mockReturnValue(undefined) }) },
}));
jest.mock('./PriorityQueueService', () => ({
  PriorityQueueService: { getInstance: jest.fn().mockReturnValue({ enqueue: jest.fn(), getStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0, byPriority: {} }), cancelAll: jest.fn(), isProcessing: jest.fn().mockReturnValue(false), cancelConnection: jest.fn(), resetConnection: jest.fn(), isConnectionCancelled: jest.fn().mockReturnValue(false), getConnectionStatus: jest.fn().mockReturnValue({ active: 0, queued: 0, completed: 0, total: 0 }) }) },
  PreloadPriority: { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 },
}));
jest.mock('./ActivityService', () => ({
  ActivityService: { getInstance: jest.fn().mockReturnValue({ startActivity: jest.fn().mockReturnValue('act-1'), updateProgress: jest.fn(), completeActivity: jest.fn(), failActivity: jest.fn() }) },
}));
jest.mock('./CommandGuard', () => ({
  CommandGuard: { getInstance: jest.fn().mockReturnValue({ exec: jest.fn().mockResolvedValue(''), upload: jest.fn().mockResolvedValue(undefined), download: jest.fn().mockResolvedValue(Buffer.from('')) }) },
}));

import * as vscode from 'vscode';
import { FileService } from './FileService';

const TS = '2026-01-19T12-30-45-123Z';
const BK = '/tmp/.ssh-lite-backups';
const MARK = '__SSHLITE_INDEX__';

function resetFileService(): FileService {
  try { FileService.getInstance().dispose(); } catch { /* ignore */ }
  (FileService as any)._instance = undefined;
  return FileService.getInstance();
}

describe('FileService fixes', () => {
  let service: FileService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockExec.mockReset().mockResolvedValue('');
    mockReadFile.mockReset().mockResolvedValue(Buffer.from('x'));
    mockStat.mockReset();
    mockListFiles.mockReset().mockResolvedValue([]);
    service = resetFileService();
  });

  afterEach(() => {
    try { service.dispose(); } catch { /* ignore */ }
  });

  describe('listServerBackups', () => {
    it('single-quotes the glob so spaces, $(x) and single quotes stay literal', async () => {
      await service.listServerBackups(mockConnection as any, "/d/my $(x) it's.js");
      const cmd = mockExec.mock.calls[0][0] as string;
      expect(cmd).toContain("ls -1t -- '/tmp/.ssh-lite-backups/my $(x) it'\\''s_'*'.js'");
    });

    it('keeps only exact base_<timestamp>ext names', async () => {
      mockExec.mockResolvedValue([
        `${BK}/app_${TS}.js`,
        `${BK}/app_${TS}.js.map`,
        `${BK}/app_${TS}.json`,
        `${BK}/app_old_${TS}.js`,
        `${BK}/app_x.js`,
        MARK,
        '',
      ].join('\n'));
      const res = await service.listServerBackups(mockConnection as any, '/d/app.js');
      expect(res.map((r) => r.path)).toEqual([`${BK}/app_${TS}.js`]);
    });

    it('drops backups the index assigns to a different directory, keeps unindexed ones', async () => {
      const mine = `${BK}/app_${TS}.js`;
      const other = `${BK}/app_2026-01-20T12-30-45-123Z.js`;
      const unindexed = `${BK}/app_2026-01-21T12-30-45-123Z.js`;
      mockExec.mockResolvedValue([
        mine, other, unindexed,
        MARK,
        `/d1/app.js|${mine}`,
        `/d2/app.js|${other}`,
      ].join('\n'));
      const res = await service.listServerBackups(mockConnection as any, '/d1/app.js');
      expect(res.map((r) => r.path)).toEqual([mine, unindexed]);
    });

    it('emits the index marker and cat of the index file in the same exec', async () => {
      await service.listServerBackups(mockConnection as any, '/d/a.txt');
      expect(mockExec).toHaveBeenCalledTimes(1);
      const cmd = mockExec.mock.calls[0][0] as string;
      expect(cmd).toContain(`echo '${MARK}'`);
      expect(cmd).toContain(`cat '${BK}/.ssh-lite-index'`);
    });
  });

  describe('nextCopyName', () => {
    it('does not split a directory name at the dot', () => {
      expect(service.nextCopyName('my.folder', new Set(['my.folder']), true)).toBe('my.folder (copy)');
      expect(service.nextCopyName('my.folder', new Set(['my.folder', 'my.folder (copy)']), true)).toBe('my.folder (copy) 2');
    });
    it('still splits a file extension', () => {
      expect(service.nextCopyName('a.txt', new Set(['a.txt']))).toBe('a (copy).txt');
      expect(service.nextCopyName('a.txt', new Set(['a.txt']), false)).toBe('a (copy).txt');
    });
  });

  describe('copyRemoteSameHost folder-into-itself', () => {
    it.each([
      ['/data', '/data'],
      ['/data', '/data/x'],
      ['/data/', '/data/x/y'],
    ])('refuses %s -> %s before any exec on SSH', async (src, dest) => {
      await expect(service.copyRemoteSameHost(mockConnection as any, src, dest, true))
        .rejects.toThrow('Cannot copy a folder into itself.');
      expect(mockExec).not.toHaveBeenCalled();
    });

    it('allows a sibling with a shared name prefix', async () => {
      await service.copyRemoteSameHost(mockConnection as any, '/data', '/data2', true);
      expect(mockExec).toHaveBeenCalledTimes(1);
    });
  });

  describe('downloadFolder skipping links', () => {
    const entry = (name: string) => ({ name, path: `/r/d/${name}`, isDirectory: false, size: 1, modifiedTime: 0, connectionId: 'c1' });
    const root = { name: 'd', path: '/r/d', isDirectory: true, size: 0, modifiedTime: 0, connectionId: 'c1' };

    beforeEach(() => {
      (vscode.window.showOpenDialog as jest.Mock).mockResolvedValueOnce([vscode.Uri.file('/dest')]);
    });

    it('skips folder links and broken links, downloads the rest, and warns with the list', async () => {
      mockListFiles.mockResolvedValue([entry('good.txt'), entry('dirlink'), entry('dangling'), entry('after.txt')]);
      mockReadFile.mockImplementation(async (p: string) => {
        if (p.endsWith('dirlink') || p.endsWith('dangling')) { throw new Error('read failed'); }
        return Buffer.from('ok');
      });
      mockStat.mockImplementation(async (p: string) => {
        if (p.endsWith('dirlink')) { return { isDirectory: true }; }
        throw new Error('no such file');
      });

      await service.downloadFolder(mockConnection as any, root as any);

      const written = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls.map((c) => c[0].path);
      expect(written).toEqual([expect.stringContaining('good.txt'), expect.stringContaining('after.txt')]);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      const [msg, opts] = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0];
      expect(msg).toContain('2 symbolic link(s)');
      expect(opts.detail).toContain('/r/d/dirlink (link to a folder, not followed)');
      expect(opts.detail).toContain('/r/d/dangling (broken link)');
      expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it('still aborts on a read error when stat says it is a regular file', async () => {
      mockListFiles.mockResolvedValue([entry('bad.txt'), entry('after.txt')]);
      mockReadFile.mockRejectedValue(new Error('permission denied'));
      mockStat.mockResolvedValue({ isDirectory: false });

      await service.downloadFolder(mockConnection as any, root as any);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
      expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('shell-quoted paths', () => {
    const backupFile = { name: `a_${TS}.txt`, path: `${BK}/a_${TS}.txt`, timestamp: new Date(), isDirectory: false };
    const backupDir = { name: `a_${TS}.tar.gz`, path: `${BK}/a_${TS}.tar.gz`, timestamp: new Date(), isDirectory: true };

    async function restore(backup: any, target: string, existsReply = 'not_exists') {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue(target);
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Restore');
      mockExec.mockResolvedValue(existsReply);
      await (service as any).restoreBackupWithConfirmation(mockConnection as any, backup);
      return mockExec.mock.calls.map((c) => c[0] as string);
    }

    it('restore keeps $(touch x), backticks, spaces and quotes literal', async () => {
      const cmds = await restore(backupFile, "/d/$(touch x) `id` it's here");
      const lit = "'/d/$(touch x) `id` it'\\''s here'";
      expect(cmds[0]).toBe(`test -e ${lit} && echo "exists" || echo "not_exists"`);
      expect(cmds[1]).toBe(`mkdir -p -- '/d' && cp -- '${backupFile.path}' ${lit}`);
    });

    it('restore with default ~/name target resolves the home folder, never a quoted ~', async () => {
      const cmds = await restore(backupFile, '');
      expect(cmds[0]).toContain(`test -e '/home/u/a.txt' `);
      expect(cmds.join('\n')).not.toContain("'~/");
    });

    it('restore to a ~/ target resolves home, so the pre-restore backup sees the real file', async () => {
      const cmds = await restore(backupFile, '~/dir/f $x.txt');
      expect(cmds[0]).toContain(`'/home/u/dir/f $x.txt'`);
      expect(cmds.join('\n')).not.toContain("'~/");
    });

    it('restore does not overwrite when the promised pre-restore backup fails and the user cancels', async () => {
      (vscode.window.showInputBox as jest.Mock).mockResolvedValue('/d/a.txt');
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValueOnce('Restore').mockResolvedValueOnce(undefined);
      const spy = jest.spyOn(service as any, 'createServerBackup').mockResolvedValue(undefined);
      mockExec.mockResolvedValue('exists');
      await (service as any).restoreBackupWithConfirmation(mockConnection as any, backupFile);
      const cmds = mockExec.mock.calls.map((c) => c[0] as string);
      expect(vscode.window.showWarningMessage).toHaveBeenLastCalledWith(
        expect.stringContaining('Could not back up'), expect.objectContaining({ modal: true }), 'Overwrite Without Backup');
      expect(cmds.some((c) => c.includes('cp --'))).toBe(false);
      spy.mockRestore();
    });

    it('shellPath maps bare ~ and ~/ prefixes through "$HOME"', async () => {
      expect((service as any).shellPath('~')).toBe('"$HOME"');
      expect((service as any).shellPath('~/')).toBe(`"$HOME"/''`);
      expect((service as any).shellPath("/a b/'c")).toBe("'/a b/'\\''c'");
    });

    it('directory backup restore extracts with tar -xzf <backup> -C <parent>', async () => {
      const cmds = await restore(backupDir, '/d/x');
      expect(cmds[1]).toBe(`mkdir -p -- '/d' && tar -xzf '${backupDir.path}' -C '/d'`);
    });

    it('delete-backup uses rm -f -- with a quoted path', async () => {
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete');
      await (service as any).deleteBackup(mockConnection as any, { name: 'n', path: `${BK}/we ird$(x)'.txt` });
      expect(mockExec).toHaveBeenCalledWith(`rm -f -- '${BK}/we ird$(x)'\\''.txt'`);
    });

    it('preview uses head -n 1000 -- with a quoted path', async () => {
      mockExec.mockResolvedValue('line');
      await (service as any).previewLargeFile(mockConnection as any, { name: 'f', path: '/d/$(x) y.log', size: 1, isDirectory: false, modifiedTime: 0, connectionId: 'c1' });
      expect(mockExec).toHaveBeenCalledWith(`head -n 1000 -- '/d/$(x) y.log'`);
    });

    it('createDirectoryBackup tars ./<dirname> so a dir named -x is not an option', async () => {
      mockExec.mockResolvedValue('ok');
      await (service as any).createDirectoryBackup(mockConnection as any, "/p/-x'y");
      const tarCmd = mockExec.mock.calls[0][0] as string;
      expect(tarCmd).toContain(`cd '/p' && tar -czf `);
      expect(tarCmd).toContain(`'./-x'\\''y'`);
    });
  });
});
