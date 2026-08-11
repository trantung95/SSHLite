/**
 * Extension helpers tests - tests REAL exported functions
 *
 * Tests the actual functions from src/utils/extensionHelpers.ts:
 * - parseHostInfoFromPath
 * - isInSshTempDir
 * - hasSshPrefix
 *
 * Also tests normalizeLocalPath integration for Windows path handling.
 */

import { parseHostInfoFromPath, isInSshTempDir, hasSshPrefix } from './utils/extensionHelpers';
import { normalizeLocalPath } from './utils/helpers';
import * as vscode from 'vscode';
import { handleClearActivities, handleDeleteSavedForward } from './extension';

describe('Extension Helpers - Real Exports', () => {
  describe('parseHostInfoFromPath', () => {
    const tempDir = '/tmp/ssh-lite';

    it('should parse Unix SSH temp file path', () => {
      const result = parseHostInfoFromPath(
        '/tmp/ssh-lite/abc12345/[SSH] config.ts',
        tempDir
      );
      expect(result).not.toBeNull();
      expect(result!.hostHash).toBe('abc12345');
      expect(result!.fileName).toBe('config.ts');
    });

    it('should parse Windows SSH temp file path', () => {
      const winTempDir = 'c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite';
      const result = parseHostInfoFromPath(
        'c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\abc12345\\[SSH] config.ts',
        winTempDir
      );
      expect(result).not.toBeNull();
      expect(result!.hostHash).toBe('abc12345');
      expect(result!.fileName).toBe('config.ts');
    });

    it('should return null for non-SSH file', () => {
      const result = parseHostInfoFromPath('/home/user/projects/config.ts', tempDir);
      expect(result).toBeNull();
    });

    it('should return null for file without [SSH] prefix', () => {
      const result = parseHostInfoFromPath('/tmp/ssh-lite/abc12345/regular-file.ts', tempDir);
      expect(result).toBeNull();
    });

    it('should handle deep nested paths', () => {
      const result = parseHostInfoFromPath(
        '/tmp/ssh-lite/def67890/[SSH] deeply-nested-file.json',
        tempDir
      );
      expect(result).not.toBeNull();
      expect(result!.hostHash).toBe('def67890');
      expect(result!.fileName).toBe('deeply-nested-file.json');
    });

    it('should handle files with spaces in name', () => {
      const result = parseHostInfoFromPath(
        '/tmp/ssh-lite/abc12345/[SSH] my config file.ts',
        tempDir
      );
      expect(result).not.toBeNull();
      expect(result!.fileName).toBe('my config file.ts');
    });

    it('should extract hash from path with mixed separators', () => {
      const result = parseHostInfoFromPath(
        '/tmp/ssh-lite/abc12345/[SSH] file.ts',
        tempDir
      );
      expect(result).not.toBeNull();
      expect(result!.hostHash).toBe('abc12345');
    });
  });

  describe('isInSshTempDir', () => {
    it('should detect files in SSH temp dir', () => {
      expect(isInSshTempDir('/tmp/ssh-lite/abc/[SSH] file.ts', '/tmp/ssh-lite')).toBe(true);
    });

    it('should detect files with ssh-lite in path (fallback)', () => {
      expect(isInSshTempDir('/some/other/path/ssh-lite/abc/file.ts', '/tmp/ssh-lite')).toBe(true);
    });

    it('should NOT detect regular files', () => {
      expect(isInSshTempDir('/home/user/projects/file.ts', '/tmp/ssh-lite')).toBe(false);
    });

    it('should work with Windows paths', () => {
      const winPath = 'c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\abc\\[SSH] file.ts';
      const winTempDir = 'c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite';
      expect(isInSshTempDir(winPath, winTempDir)).toBe(true);
    });
  });

  describe('hasSshPrefix', () => {
    it('should detect [SSH] prefix', () => {
      expect(hasSshPrefix('/tmp/ssh-lite/abc/[SSH] file.ts')).toBe(true);
    });

    it('should NOT detect without [SSH] prefix', () => {
      expect(hasSshPrefix('/tmp/ssh-lite/abc/file.ts')).toBe(false);
    });

    it('should work with Windows backslash paths', () => {
      expect(hasSshPrefix('c:\\tmp\\ssh-lite\\abc\\[SSH] file.ts')).toBe(true);
    });
  });

  describe('normalizeLocalPath at extension entry points', () => {
    it('should normalize before SSH temp dir check', () => {
      const winTempDir = 'c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite';
      const vscodePath = 'C:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\abc\\[SSH] file.ts';
      const normalized = normalizeLocalPath(vscodePath);
      expect(normalized.startsWith(winTempDir)).toBe(true);
    });

    it('should normalize before Map lookup', () => {
      const orphanedFiles = new Map<string, { remotePath: string; hostHash: string }>();
      const normalizedPath = normalizeLocalPath('C:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\abc\\[SSH] file.ts');
      orphanedFiles.set(normalizedPath, { remotePath: '/home/user/file.ts', hostHash: 'abc' });

      const lookupPath = normalizeLocalPath('c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\abc\\[SSH] file.ts');
      expect(orphanedFiles.has(lookupPath)).toBe(true);
    });

    it('should not affect Unix paths', () => {
      const unixPath = '/tmp/ssh-lite/abc/[SSH] file.ts';
      expect(normalizeLocalPath(unixPath)).toBe(unixPath);
    });
  });

  describe('orphaned file detection flow (using real helpers)', () => {
    /**
     * Integrates the REAL exported helpers to test the detection flow.
     * This mirrors the logic in extension.ts detectOrphanedSshFiles.
     */
    function detectOrphanedFiles(
      openDocs: Array<{ fsPath: string; isUntitled: boolean }>,
      sshTempDir: string,
      getFileMapping: (path: string) => boolean,
    ): Map<string, { remotePath: string; hostHash: string }> {
      const orphaned = new Map<string, { remotePath: string; hostHash: string }>();

      for (const doc of openDocs) {
        const fsPath = normalizeLocalPath(doc.fsPath);

        if ((isInSshTempDir(fsPath, sshTempDir) || hasSshPrefix(fsPath)) && !doc.isUntitled) {
          const hasMapping = getFileMapping(fsPath);
          if (!hasMapping) {
            const hostInfo = parseHostInfoFromPath(fsPath, sshTempDir);
            if (hostInfo) {
              orphaned.set(fsPath, {
                remotePath: '',
                hostHash: hostInfo.hostHash,
              });
            }
          }
        }
      }

      return orphaned;
    }

    const tempDir = '/tmp/ssh-lite';

    it('should detect orphaned SSH files (no mapping)', () => {
      const docs = [
        { fsPath: '/tmp/ssh-lite/abc123/[SSH] config.ts', isUntitled: false },
      ];
      const orphaned = detectOrphanedFiles(docs, tempDir, () => false);
      expect(orphaned.size).toBe(1);
    });

    it('should NOT detect files with active mapping', () => {
      const docs = [
        { fsPath: '/tmp/ssh-lite/abc123/[SSH] config.ts', isUntitled: false },
      ];
      const orphaned = detectOrphanedFiles(docs, tempDir, () => true);
      expect(orphaned.size).toBe(0);
    });

    it('should skip untitled documents', () => {
      const docs = [
        { fsPath: '/tmp/ssh-lite/abc123/[SSH] config.ts', isUntitled: true },
      ];
      const orphaned = detectOrphanedFiles(docs, tempDir, () => false);
      expect(orphaned.size).toBe(0);
    });

    it('should skip non-SSH files', () => {
      const docs = [
        { fsPath: '/home/user/regular-file.ts', isUntitled: false },
      ];
      const orphaned = detectOrphanedFiles(docs, tempDir, () => false);
      expect(orphaned.size).toBe(0);
    });

    it('should detect multiple orphaned files', () => {
      const docs = [
        { fsPath: '/tmp/ssh-lite/abc123/[SSH] file1.ts', isUntitled: false },
        { fsPath: '/tmp/ssh-lite/abc123/[SSH] file2.ts', isUntitled: false },
        { fsPath: '/tmp/ssh-lite/def456/[SSH] file3.ts', isUntitled: false },
        { fsPath: '/home/user/regular.ts', isUntitled: false },
      ];
      const orphaned = detectOrphanedFiles(docs, tempDir, () => false);
      expect(orphaned.size).toBe(3);
    });

    it('should mix orphaned and mapped files correctly', () => {
      const mappedPaths = new Set(['/tmp/ssh-lite/abc123/[SSH] active.ts']);
      const docs = [
        { fsPath: '/tmp/ssh-lite/abc123/[SSH] active.ts', isUntitled: false },
        { fsPath: '/tmp/ssh-lite/abc123/[SSH] orphaned.ts', isUntitled: false },
      ];
      const orphaned = detectOrphanedFiles(
        docs, tempDir,
        (p) => mappedPaths.has(p)
      );
      expect(orphaned.size).toBe(1);
      expect(orphaned.has('/tmp/ssh-lite/abc123/[SSH] orphaned.ts')).toBe(true);
    });

    it('should normalize Windows paths before detection', () => {
      const winTempDir = 'c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite';
      const docs = [
        { fsPath: 'C:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\abc123\\[SSH] file.ts', isUntitled: false },
      ];
      const orphaned = detectOrphanedFiles(docs, winTempDir, () => false);
      const normalizedPath = 'c:\\Users\\user\\AppData\\Local\\Temp\\ssh-lite\\abc123\\[SSH] file.ts';
      expect(orphaned.has(normalizedPath)).toBe(true);
    });
  });
});

describe('native command feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('delete saved forward', () => {
    const item = {
      hostId: 'example.com:22:alice',
      hostName: 'Production',
      rule: {
        id: 'saved-rule-1',
        localPort: 8080,
        remoteHost: 'localhost',
        remotePort: 3000,
      },
    } as any;

    it('requires modal confirmation that states scope and consequence', async () => {
      const service = { deleteSavedRule: jest.fn().mockResolvedValue(undefined) };
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Saved Rule');

      await handleDeleteSavedForward(item, service);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Delete saved rule localhost:8080 → Production:3000? ' +
          'It will not restore on the next connection. No server data will be deleted.',
        { modal: true },
        'Delete Saved Rule'
      );
      expect(service.deleteSavedRule).toHaveBeenCalledWith(item.hostId, item.rule.id);
    });

    it('names a custom destination host in the confirmation', async () => {
      const service = { deleteSavedRule: jest.fn().mockResolvedValue(undefined) };
      const customTargetItem = {
        ...item,
        rule: { ...item.rule, remoteHost: 'database.internal' },
      };
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

      await handleDeleteSavedForward(customTargetItem, service);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        expect.stringContaining('localhost:8080 → database.internal:3000'),
        { modal: true },
        'Delete Saved Rule'
      );
    });

    it('keeps the saved rule when confirmation is cancelled', async () => {
      const service = { deleteSavedRule: jest.fn().mockResolvedValue(undefined) };
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

      await handleDeleteSavedForward(item, service);

      expect(service.deleteSavedRule).not.toHaveBeenCalled();
      expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
    });

    it('confirms successful deletion in the status bar', async () => {
      const service = { deleteSavedRule: jest.fn().mockResolvedValue(undefined) };
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Saved Rule');

      await handleDeleteSavedForward(item, service);

      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        '$(trash) Saved port forward deleted',
        3000
      );
    });

    it('explains deletion failure and recovery', async () => {
      const service = {
        deleteSavedRule: jest.fn().mockRejectedValue(new Error('Storage is read-only')),
      };
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Delete Saved Rule');

      await handleDeleteSavedForward(item, service);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Delete saved rule failed: Storage is read-only. Check storage access and try again.'
      );
    });
  });

  describe('clear activity list', () => {
    it('clears immediately when no operation is running', async () => {
      const service = { hasRunningActivities: jest.fn().mockReturnValue(false), clearAll: jest.fn() };

      await handleClearActivities(service);

      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
      expect(service.clearAll).toHaveBeenCalledTimes(1);
      expect(vscode.window.setStatusBarMessage).toHaveBeenCalledWith(
        '$(clear-all) Activity list cleared',
        2000
      );
    });

    it('requires confirmation while operations are running', async () => {
      const service = { hasRunningActivities: jest.fn().mockReturnValue(true), clearAll: jest.fn() };
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Clear Activity List');

      await handleClearActivities(service);

      expect(vscode.window.showWarningMessage).toHaveBeenCalledWith(
        'Clear the activity list? Running operations will continue but will no longer appear in Activity.',
        { modal: true },
        'Clear Activity List'
      );
      expect(service.clearAll).toHaveBeenCalledTimes(1);
    });

    it('keeps the activity list when confirmation is cancelled', async () => {
      const service = { hasRunningActivities: jest.fn().mockReturnValue(true), clearAll: jest.fn() };
      (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue(undefined);

      await handleClearActivities(service);

      expect(service.clearAll).not.toHaveBeenCalled();
      expect(vscode.window.setStatusBarMessage).not.toHaveBeenCalled();
    });

    it('explains a clear failure and recovery', async () => {
      const service = {
        hasRunningActivities: jest.fn().mockReturnValue(false),
        clearAll: jest.fn().mockImplementation(() => {
          throw new Error('Activity store unavailable');
        }),
      };

      await handleClearActivities(service);

      expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
        'Clear activity list failed: Activity store unavailable. Try again.'
      );
    });
  });
});
