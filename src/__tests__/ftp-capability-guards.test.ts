/**
 * FTP no-crash regression: SSH-only features must FAIL CLEARLY (a thrown Error
 * with a capability message), never with a runtime "x is not a function"
 * TypeError, when handed an FTP connection.
 *
 * ConnectionManager hands out connections typed as SSHConnection via a downcast,
 * so the compiler cannot catch an SSH-only call landing on FTP. These tests feed
 * each guarded service sink an FTP-capability connection and assert it throws the
 * guard error (which proves the SSH-only method was never reached).
 */
import { CommandGuard } from '../services/CommandGuard';
import { TerminalService } from '../services/TerminalService';
import { PortForwardService } from '../services/PortForwardService';
import { SystemToolsService } from '../services/SystemToolsService';
import { SshKeyService } from '../services/SshKeyService';
import { FilenameIndexService } from '../services/FilenameIndexService';
import { FileService } from '../services/FileService';
import { ServerMonitorService } from '../services/ServerMonitorService';
import { ConnectionManager } from '../connection/ConnectionManager';
import { RemoteEnvDocumentProvider, RemoteCronDocumentProvider, buildUri, ENV_SCHEME, CRON_SCHEME } from '../providers/VirtualDocProviders';

// A minimal FTP-shaped connection: file ops exist, but NONE of the SSH-only
// methods (exec/shell/forwardPort/readFileChunked/...) do — exactly like the real
// FTPConnection. If a guard is missing, calling the method throws a TypeError
// ("x is not a function") instead of our capability Error, and the test fails.
function ftpConn(): any {
  return {
    id: '127.0.0.1:21:u',
    host: { name: 'ftp-host', username: 'u', host: '127.0.0.1', port: 21 },
    state: 'connected',
    capabilities: {
      type: 'ftp',
      supportsExec: false,
      supportsShell: false,
      supportsPortForward: false,
      supportsNativeWatch: false,
      supportsSearch: false,
      supportsServerBackup: false,
      supportsSudo: false,
    },
  };
}

const FTP_ERR = /not available over FTP/i;

describe('FTP no-crash capability guards', () => {
  it('CommandGuard.openShell throws (shell) not a TypeError', async () => {
    await expect(CommandGuard.getInstance().openShell(ftpConn())).rejects.toThrow(FTP_ERR);
  });

  it('CommandGuard.exec throws (exec) not a TypeError', async () => {
    await expect(CommandGuard.getInstance().exec(ftpConn(), 'ls')).rejects.toThrow(FTP_ERR);
  });

  it('CommandGuard.searchFiles throws (search) not a TypeError', async () => {
    await expect(
      CommandGuard.getInstance().searchFiles(ftpConn(), '/', 'x', {})
    ).rejects.toThrow(FTP_ERR);
  });

  it('TerminalService.createTerminal throws (shell)', async () => {
    await expect(TerminalService.getInstance().createTerminal(ftpConn())).rejects.toThrow(FTP_ERR);
  });

  it('PortForwardService.forwardPort throws (port forward)', async () => {
    await expect(
      PortForwardService.getInstance().forwardPort(ftpConn(), 8080, 'localhost', 80)
    ).rejects.toThrow(FTP_ERR);
  });

  it('SystemToolsService process/service listings throw (exec)', async () => {
    await expect(SystemToolsService.getInstance().listProcesses(ftpConn())).rejects.toThrow(FTP_ERR);
    await expect(SystemToolsService.getInstance().listServices(ftpConn())).rejects.toThrow(FTP_ERR);
  });

  it('SshKeyService.pushPublicKey throws before touching the filesystem (exec)', async () => {
    await expect(
      SshKeyService.getInstance().pushPublicKey(ftpConn(), '/does/not/exist.pub')
    ).rejects.toThrow(FTP_ERR);
  });

  it('FilenameIndexService.buildIndex throws (search)', async () => {
    await expect(FilenameIndexService.getInstance().buildIndex(ftpConn(), '/')).rejects.toThrow(FTP_ERR);
  });

  it('ServerMonitorService exec/shell entry methods throw, never reach exec()', async () => {
    const mon = ServerMonitorService.getInstance();
    await expect(mon.quickStatus(ftpConn())).rejects.toThrow(FTP_ERR);
    await expect(mon.diagnoseSlowness(ftpConn())).rejects.toThrow(FTP_ERR);
    await expect(mon.watchStatus(ftpConn())).rejects.toThrow(FTP_ERR);
    await expect(mon.checkService(ftpConn(), 'nginx')).rejects.toThrow(FTP_ERR);
    await expect(mon.listServices(ftpConn())).rejects.toThrow(FTP_ERR);
    await expect(mon.recentLogs(ftpConn())).rejects.toThrow(FTP_ERR);
    await expect(mon.networkDiagnostics(ftpConn())).rejects.toThrow(FTP_ERR);
    await expect(mon.watchLiveTerminal(ftpConn())).rejects.toThrow(FTP_ERR);
    await expect(mon.openLiveMonitorPanel(ftpConn())).rejects.toThrow(FTP_ERR);
  });

  it('FileService server-backup + properties methods throw (backup/exec)', async () => {
    const fs = FileService.getInstance();
    await expect(fs.listAllServerBackups(ftpConn())).rejects.toThrow(FTP_ERR);
    await expect(fs.listServerBackups(ftpConn(), '/etc/hosts')).rejects.toThrow(FTP_ERR);
    await expect(fs.openServerBackupFolder(ftpConn())).rejects.toThrow(FTP_ERR);
    await expect(
      fs.getRemoteProperties(ftpConn(), { name: 'x', path: '/x', isDirectory: false, size: 1, modifiedTime: 0, connectionId: 'c' })
    ).rejects.toThrow(FTP_ERR);
  });

  it('FileService.cleanupServerBackups is a no-op for FTP (returns 0, no throw)', async () => {
    await expect(FileService.getInstance().cleanupServerBackups(ftpConn())).resolves.toBe(0);
  });

  it('PortForwardService auto-restore/deactivate are no-ops for FTP (no throw)', async () => {
    await expect(PortForwardService.getInstance().restoreForwardsForConnection(ftpConn())).resolves.toBeUndefined();
    await expect(PortForwardService.getInstance().deactivateAllForwardsForConnection('127.0.0.1:21:u')).resolves.toBeUndefined();
  });

  it('env/cron virtual docs render a clean FTP message (no exec, no TypeError)', async () => {
    const spy = jest.spyOn(ConnectionManager.getInstance(), 'getConnection').mockReturnValue(ftpConn());
    try {
      const env = await new RemoteEnvDocumentProvider().provideTextDocumentContent(
        buildUri(ENV_SCHEME, '127.0.0.1:21:u', 'env.txt')
      );
      expect(env).toMatch(/not available over FTP/i);
      const cron = await new RemoteCronDocumentProvider().provideTextDocumentContent(
        buildUri(CRON_SCHEME, '127.0.0.1:21:u', 'crontab.cron')
      );
      expect(cron).toMatch(/not available over FTP/i);
    } finally {
      spy.mockRestore();
    }
  });
});
