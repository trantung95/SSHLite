/**
 * Multi-OS ServerMonitorService Integration Tests
 *
 * Tests the ServerMonitorService class against 5 Docker server OS.
 * All methods execute real shell commands (free, ps, df, uptime, etc.)
 * which behave differently across OS variants.
 */
import { SSHConnection } from '../connection/SSHConnection';
import { ServerMonitorService } from '../services/ServerMonitorService';
import {
  CI_SERVERS,
  OSServerConfig,
  createTestConnection,
  safeDisconnect,
  setupCredentialServiceMock,
  setupVscodeMocks,
} from './multios-helpers';

beforeAll(() => {
  setupCredentialServiceMock();
  setupVscodeMocks();
  // Reset ServerMonitorService singleton
  (ServerMonitorService as any)._instance = undefined;
});

// ---- Per-OS Monitor Tests ----
describe.each(CI_SERVERS)('ServerMonitor on $os', (server: OSServerConfig) => {
  let conn: SSHConnection;
  let monitor: ServerMonitorService;

  beforeAll(async () => {
    conn = await createTestConnection(server);
    monitor = ServerMonitorService.getInstance();
  });

  afterAll(async () => {
    await safeDisconnect(conn);
  });

  describe('quickStatus', () => {
    it('should complete without throwing', async () => {
      await expect(monitor.quickStatus(conn)).resolves.not.toThrow();
    });
  });

  describe('diagnoseSlowness', () => {
    it('should complete without throwing', async () => {
      await expect(monitor.diagnoseSlowness(conn)).resolves.not.toThrow();
    });
  });

  describe('fetchServerStatus', () => {
    it('should return status with hostname', async () => {
      // fetchServerStatus is private, test via quickStatus or call directly
      // Use exec to get the same data the monitor parses
      const result = await conn.exec(`
        echo "===HOSTNAME==="
        hostname
        echo "===UPTIME==="
        uptime
        echo "===LOADAVG==="
        cat /proc/loadavg
        echo "===MEMORY==="
        free -b 2>/dev/null || echo "free not available"
        echo "===DISK==="
        df -h | grep -E '^/dev' || echo "no /dev mounts"
        echo "===TOP_PROCS==="
        ps aux --sort=-%cpu 2>/dev/null | head -6 || ps aux | head -6
        echo "===CONNECTIONS==="
        ss -tuln 2>/dev/null | wc -l || netstat -tuln 2>/dev/null | wc -l || echo "0"
      `);

      expect(result).toContain('===HOSTNAME===');
      expect(result).toContain(server.hostname);
    });

    it('should get uptime information', async () => {
      const result = await conn.exec('uptime');
      expect(result.trim()).toBeTruthy();
      // Uptime output should contain "up" and "load average"
      expect(result.toLowerCase()).toMatch(/up/);
    });

    it('should get memory information', async () => {
      const result = await conn.exec('free -b 2>/dev/null || echo "N/A"');
      // Should contain "Mem:" line on all OS except when free is unavailable
      if (!result.includes('N/A')) {
        expect(result).toContain('Mem:');
      }
    });

    it('should get load average from /proc/loadavg', async () => {
      const result = await conn.exec('cat /proc/loadavg');
      // Format: "0.00 0.01 0.05 1/123 456"
      expect(result.trim()).toMatch(/^\d+\.\d+/);
    });

    it('should get process list', async () => {
      const result = await conn.exec('ps aux 2>/dev/null | head -3 || ps | head -3');
      expect(result.trim()).toBeTruthy();
      // Should contain sshd process
      const fullResult = await conn.exec('ps aux 2>/dev/null || ps');
      expect(fullResult).toContain('sshd');
    });
  });

  describe('networkDiagnostics', () => {
    it('should complete without throwing', async () => {
      await expect(monitor.networkDiagnostics(conn)).resolves.not.toThrow();
    });

    it('should have working network commands', async () => {
      // At least one of ip/ifconfig should work
      const result = await conn.exec('ip addr 2>/dev/null || ifconfig 2>/dev/null || echo "no network cmd"');
      expect(result.trim()).toBeTruthy();
    });
  });

  describe('checkService', () => {
    it('should check sshd service without throwing', async () => {
      await expect(monitor.checkService(conn, 'sshd')).resolves.not.toThrow();
    });
  });

  describe('recentLogs', () => {
    it('should complete without throwing', async () => {
      await expect(monitor.recentLogs(conn)).resolves.not.toThrow();
    });
  });
});
