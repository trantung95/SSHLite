/**
 * AuditService tests
 *
 * Tests audit logging: entry creation, diff generation, filtering,
 * max entries trimming, and output channel logging.
 *
 * The file I/O is mocked to avoid actual disk writes.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { clearMockConfig, setMockConfig, Uri, workspace } from '../__mocks__/vscode';

// Mock fs module
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue('[]'),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

import { AuditService } from './AuditService';

const mutableWorkspace = workspace as unknown as {
  workspaceFolders: Array<{ uri: Uri; name: string; index: number }>;
};

function resetAuditService(): AuditService {
  (AuditService as any)._instance = undefined;
  return AuditService.getInstance();
}

describe('AuditService', () => {
  let service: AuditService;

  beforeEach(() => {
    clearMockConfig();
    jest.clearAllMocks();
    mutableWorkspace.workspaceFolders = [];
    service = resetAuditService();
  });

  describe('audit log storage', () => {
    it('uses local home storage for a Remote-SSH workspace instead of raw fs on its remote path', () => {
      mutableWorkspace.workspaceFolders = [{
        uri: Uri.parse('vscode-remote://ssh-remote+example/home/remote/project'),
        name: 'project',
        index: 0,
      }];
      jest.clearAllMocks();

      const remoteService = resetAuditService();
      remoteService.log({
        action: 'download',
        connectionId: 'remote-connection',
        hostName: 'Remote server',
        username: 'user',
        remotePath: '/home/remote/file.txt',
        success: true,
      });

      const localAuditDirectory = path.join(os.homedir(), '.ssh-lite');
      const remoteWorkspaceDirectory = path.join('/home/remote/project', '.vscode');
      const localAuditFile = path.join(localAuditDirectory, 'audit.json');
      const remoteWorkspaceAuditFile = path.join(remoteWorkspaceDirectory, 'ssh-lite-audit.json');
      expect(fs.mkdirSync).toHaveBeenCalledWith(localAuditDirectory, { recursive: true });
      expect(fs.mkdirSync).not.toHaveBeenCalledWith(remoteWorkspaceDirectory, { recursive: true });
      expect(fs.writeFileSync).toHaveBeenCalledWith(localAuditFile, expect.any(String));
      expect(fs.writeFileSync).not.toHaveBeenCalledWith(remoteWorkspaceAuditFile, expect.any(String));
    });

    it('keeps audit logs beside a local file workspace', () => {
      const localWorkspaceDirectory = path.join(os.tmpdir(), 'ssh-lite-local-workspace');
      mutableWorkspace.workspaceFolders = [{
        uri: Uri.file(localWorkspaceDirectory),
        name: 'local-workspace',
        index: 0,
      }];
      jest.clearAllMocks();

      const localService = resetAuditService();
      localService.clearLogs();

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        path.join(localWorkspaceDirectory, '.vscode', 'ssh-lite-audit.json'),
        expect.any(String),
      );
    });

    it('keeps a custom audit log path as the highest-priority override', () => {
      const customAuditFile = path.join(os.tmpdir(), 'custom-ssh-lite-audit.json');
      setMockConfig('sshLite.auditLogPath', customAuditFile);
      mutableWorkspace.workspaceFolders = [{
        uri: Uri.parse('vscode-remote://ssh-remote+example/home/remote/project'),
        name: 'project',
        index: 0,
      }];
      jest.clearAllMocks();

      const customService = resetAuditService();
      customService.clearLogs();

      expect(fs.writeFileSync).toHaveBeenCalledWith(customAuditFile, expect.any(String));
    });
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const a = AuditService.getInstance();
      const b = AuditService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('log', () => {
    it('should add entry with timestamp', () => {
      service.log({
        action: 'upload',
        connectionId: 'conn1',
        hostName: 'Server1',
        username: 'admin',
        remotePath: '/home/admin/file.ts',
        success: true,
      });

      const entries = service.getRecentEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].timestamp).toBeDefined();
      expect(entries[0].action).toBe('upload');
      expect(entries[0].connectionId).toBe('conn1');
    });

    it('should include optional fields', () => {
      service.log({
        action: 'edit',
        connectionId: 'conn1',
        hostName: 'Server1',
        username: 'admin',
        remotePath: '/file.ts',
        localPath: '/tmp/file.ts',
        fileSize: 1024,
        bytesChanged: 50,
        success: true,
      });

      const entries = service.getRecentEntries();
      expect(entries[0].localPath).toBe('/tmp/file.ts');
      expect(entries[0].fileSize).toBe(1024);
      expect(entries[0].bytesChanged).toBe(50);
    });

    it('should log error entries', () => {
      service.log({
        action: 'delete',
        connectionId: 'conn1',
        hostName: 'Server1',
        username: 'admin',
        remotePath: '/protected/file.ts',
        success: false,
        error: 'Permission denied',
      });

      const entries = service.getRecentEntries();
      expect(entries[0].success).toBe(false);
      expect(entries[0].error).toBe('Permission denied');
    });
  });

  describe('logEdit', () => {
    it('should generate diff and log edit', () => {
      service.logEdit(
        'conn1', 'Server1', 'admin',
        '/file.ts', '/tmp/file.ts',
        'line1\nline2\nline3',
        'line1\nmodified\nline3',
        true
      );

      const entries = service.getRecentEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].action).toBe('edit');
      expect(entries[0].diff).toBeDefined();
      expect(entries[0].diff).toContain('changed');
    });
  });

  describe('generateDiff', () => {
    it('should detect added lines', () => {
      const diff = service.generateDiff('line1', 'line1\nline2');
      expect(diff).toContain('+');
      expect(diff).toContain('added');
    });

    it('should detect removed lines', () => {
      const diff = service.generateDiff('line1\nline2', 'line1');
      expect(diff).toContain('-');
      expect(diff).toContain('removed');
    });

    it('should detect changed lines', () => {
      const diff = service.generateDiff('old line', 'new line');
      expect(diff).toContain('changed');
    });

    it('should handle identical content', () => {
      const diff = service.generateDiff('same', 'same');
      expect(diff).toContain('+0 added');
      expect(diff).toContain('-0 removed');
      expect(diff).toContain('~0 changed');
    });

    it('should handle empty strings', () => {
      const diff = service.generateDiff('', 'new content');
      expect(diff).toContain('changed');
    });
  });

  describe('getRecentEntries', () => {
    it('should return last N entries', () => {
      for (let i = 0; i < 10; i++) {
        service.log({
          action: 'upload',
          connectionId: 'conn1',
          hostName: 'Server1',
          username: 'admin',
          remotePath: `/file${i}.ts`,
          success: true,
        });
      }

      const entries = service.getRecentEntries(3);
      expect(entries).toHaveLength(3);
      expect(entries[2].remotePath).toBe('/file9.ts');
    });

    it('should default to 50 entries', () => {
      const entries = service.getRecentEntries();
      expect(entries.length).toBeLessThanOrEqual(50);
    });
  });

  describe('getEntriesForFile', () => {
    it('should filter by remote path', () => {
      service.log({
        action: 'upload', connectionId: 'conn1', hostName: 'S1',
        username: 'u', remotePath: '/file1.ts', success: true,
      });
      service.log({
        action: 'download', connectionId: 'conn1', hostName: 'S1',
        username: 'u', remotePath: '/file2.ts', success: true,
      });
      service.log({
        action: 'edit', connectionId: 'conn1', hostName: 'S1',
        username: 'u', remotePath: '/file1.ts', success: true,
      });

      const entries = service.getEntriesForFile('/file1.ts');
      expect(entries).toHaveLength(2);
      expect(entries.every(e => e.remotePath === '/file1.ts')).toBe(true);
    });
  });

  describe('getEntriesForConnection', () => {
    it('should filter by connection ID', () => {
      service.log({
        action: 'upload', connectionId: 'conn1', hostName: 'S1',
        username: 'u', remotePath: '/file.ts', success: true,
      });
      service.log({
        action: 'upload', connectionId: 'conn2', hostName: 'S2',
        username: 'u', remotePath: '/file.ts', success: true,
      });

      const entries = service.getEntriesForConnection('conn1');
      expect(entries).toHaveLength(1);
      expect(entries[0].connectionId).toBe('conn1');
    });
  });

  describe('clearLogs', () => {
    it('should clear all entries', () => {
      service.log({
        action: 'upload', connectionId: 'conn1', hostName: 'S1',
        username: 'u', remotePath: '/file.ts', success: true,
      });

      expect(service.getRecentEntries()).toHaveLength(1);

      service.clearLogs();

      expect(service.getRecentEntries()).toHaveLength(0);
    });
  });

  describe('multi-connection scenarios', () => {
    it('should track entries from multiple connections independently', () => {
      service.log({
        action: 'upload', connectionId: 'conn1', hostName: 'Production',
        username: 'admin', remotePath: '/app.ts', success: true,
      });
      service.log({
        action: 'download', connectionId: 'conn2', hostName: 'Staging',
        username: 'deploy', remotePath: '/config.json', success: true,
      });
      service.log({
        action: 'edit', connectionId: 'conn3', hostName: 'Dev',
        username: 'dev', remotePath: '/test.ts', success: true,
      });

      expect(service.getRecentEntries()).toHaveLength(3);
      expect(service.getEntriesForConnection('conn1')).toHaveLength(1);
      expect(service.getEntriesForConnection('conn2')).toHaveLength(1);
      expect(service.getEntriesForConnection('conn3')).toHaveLength(1);
    });

    it('should filter by connection even when same file is on multiple servers', () => {
      service.log({
        action: 'upload', connectionId: 'conn1', hostName: 'Prod',
        username: 'admin', remotePath: '/app.ts', success: true,
      });
      service.log({
        action: 'upload', connectionId: 'conn2', hostName: 'Staging',
        username: 'deploy', remotePath: '/app.ts', success: true,
      });

      const conn1Entries = service.getEntriesForConnection('conn1');
      const conn2Entries = service.getEntriesForConnection('conn2');

      expect(conn1Entries).toHaveLength(1);
      expect(conn1Entries[0].hostName).toBe('Prod');
      expect(conn2Entries).toHaveLength(1);
      expect(conn2Entries[0].hostName).toBe('Staging');
    });

    it('should track same file path from different connections in file filter', () => {
      service.log({
        action: 'upload', connectionId: 'conn1', hostName: 'S1',
        username: 'u', remotePath: '/shared.ts', success: true,
      });
      service.log({
        action: 'upload', connectionId: 'conn2', hostName: 'S2',
        username: 'u', remotePath: '/shared.ts', success: true,
      });

      // getEntriesForFile returns both since same remote path
      const entries = service.getEntriesForFile('/shared.ts');
      expect(entries).toHaveLength(2);
      expect(entries[0].connectionId).toBe('conn1');
      expect(entries[1].connectionId).toBe('conn2');
    });

    it('should handle concurrent edits on different connections', () => {
      service.logEdit(
        'conn1', 'Prod', 'admin', '/app.ts', '/tmp/app.ts',
        'original', 'modified by conn1', true
      );
      service.logEdit(
        'conn2', 'Staging', 'deploy', '/app.ts', '/tmp/app.ts',
        'original', 'modified by conn2', true
      );

      const allEntries = service.getRecentEntries();
      expect(allEntries).toHaveLength(2);
      expect(allEntries.every(e => e.action === 'edit')).toBe(true);
    });

    it('should clear all entries from all connections at once', () => {
      service.log({
        action: 'upload', connectionId: 'conn1', hostName: 'S1',
        username: 'u', remotePath: '/f1.ts', success: true,
      });
      service.log({
        action: 'upload', connectionId: 'conn2', hostName: 'S2',
        username: 'u', remotePath: '/f2.ts', success: true,
      });

      service.clearLogs();

      expect(service.getEntriesForConnection('conn1')).toHaveLength(0);
      expect(service.getEntriesForConnection('conn2')).toHaveLength(0);
    });
  });
});
