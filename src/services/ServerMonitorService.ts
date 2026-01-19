import * as vscode from 'vscode';
import { SSHConnection } from '../connection/SSHConnection';
import { ConnectionManager } from '../connection/ConnectionManager';

/**
 * Server status snapshot
 */
export interface ServerStatus {
  timestamp: string;
  hostname: string;
  uptime: string;
  loadAverage: string;
  cpuUsage: number;
  memoryUsed: number;
  memoryTotal: number;
  memoryPercent: number;
  swapUsed: number;
  swapTotal: number;
  diskUsage: DiskUsage[];
  topProcesses: ProcessInfo[];
  networkConnections: number;
  zombieProcesses: number;
}

interface DiskUsage {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  percent: number;
  mountPoint: string;
}

interface ProcessInfo {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  command: string;
}

/**
 * Service for quick server monitoring and diagnostics
 */
export class ServerMonitorService {
  private static _instance: ServerMonitorService;
  private outputChannel: vscode.OutputChannel;

  private constructor() {
    this.outputChannel = vscode.window.createOutputChannel('SSH Lite Monitor');
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): ServerMonitorService {
    if (!ServerMonitorService._instance) {
      ServerMonitorService._instance = new ServerMonitorService();
    }
    return ServerMonitorService._instance;
  }

  /**
   * Quick status check - single command for overview
   */
  async quickStatus(connection: SSHConnection): Promise<void> {
    this.outputChannel.show();
    this.outputChannel.appendLine(`\n${'='.repeat(60)}`);
    this.outputChannel.appendLine(`Quick Status: ${connection.host.name} @ ${new Date().toLocaleString()}`);
    this.outputChannel.appendLine('='.repeat(60));

    try {
      // Run all diagnostics in one command for speed
      const result = await connection.exec(`
        echo "===UPTIME==="
        uptime
        echo "===MEMORY==="
        free -h
        echo "===DISK==="
        df -h | grep -E '^/dev'
        echo "===LOAD==="
        cat /proc/loadavg
        echo "===TOP_CPU==="
        ps aux --sort=-%cpu | head -6
        echo "===TOP_MEM==="
        ps aux --sort=-%mem | head -6
        echo "===CONNECTIONS==="
        ss -tuln 2>/dev/null | wc -l || netstat -tuln 2>/dev/null | wc -l
        echo "===ZOMBIES==="
        ps aux | grep -c ' Z '
      `);

      this.parseAndDisplayQuickStatus(result);
    } catch (error) {
      this.outputChannel.appendLine(`Error: ${(error as Error).message}`);
    }
  }

  /**
   * Parse and display quick status results
   */
  private parseAndDisplayQuickStatus(output: string): void {
    const sections = output.split(/===(\w+)===/);

    for (let i = 1; i < sections.length; i += 2) {
      const sectionName = sections[i];
      const content = sections[i + 1]?.trim() || '';

      switch (sectionName) {
        case 'UPTIME':
          this.outputChannel.appendLine(`\nUptime & Load:`);
          this.outputChannel.appendLine(`  ${content}`);
          break;
        case 'MEMORY':
          this.outputChannel.appendLine(`\nMemory Usage:`);
          content.split('\n').forEach((line) => this.outputChannel.appendLine(`  ${line}`));
          break;
        case 'DISK':
          this.outputChannel.appendLine(`\nDisk Usage:`);
          content.split('\n').forEach((line) => this.outputChannel.appendLine(`  ${line}`));
          break;
        case 'TOP_CPU':
          this.outputChannel.appendLine(`\nTop CPU Processes:`);
          content.split('\n').slice(0, 5).forEach((line) => {
            const parts = line.trim().split(/\s+/);
            if (parts.length > 10) {
              this.outputChannel.appendLine(`  ${parts[1]} ${parts[2]}% CPU - ${parts.slice(10).join(' ').substring(0, 50)}`);
            }
          });
          break;
        case 'TOP_MEM':
          this.outputChannel.appendLine(`\nTop Memory Processes:`);
          content.split('\n').slice(0, 5).forEach((line) => {
            const parts = line.trim().split(/\s+/);
            if (parts.length > 10) {
              this.outputChannel.appendLine(`  ${parts[1]} ${parts[3]}% MEM - ${parts.slice(10).join(' ').substring(0, 50)}`);
            }
          });
          break;
        case 'CONNECTIONS':
          this.outputChannel.appendLine(`\nNetwork Connections: ${content}`);
          break;
        case 'ZOMBIES':
          const zombies = parseInt(content, 10) - 1; // subtract grep itself
          if (zombies > 0) {
            this.outputChannel.appendLine(`\nZombie Processes: ${zombies}`);
          }
          break;
      }
    }
  }

  /**
   * Diagnose why server is slow
   */
  async diagnoseSlowness(connection: SSHConnection): Promise<void> {
    this.outputChannel.show();
    this.outputChannel.appendLine(`\n${'='.repeat(60)}`);
    this.outputChannel.appendLine(`Slowness Diagnosis: ${connection.host.name}`);
    this.outputChannel.appendLine('='.repeat(60));

    const issues: string[] = [];

    try {
      // Check load average
      this.outputChannel.appendLine('\nChecking load average...');
      const loadResult = await connection.exec('cat /proc/loadavg && nproc');
      const lines = loadResult.trim().split('\n');
      const loadParts = lines[0].split(' ');
      const cpuCount = parseInt(lines[1], 10) || 1;
      const load1 = parseFloat(loadParts[0]);
      const load5 = parseFloat(loadParts[1]);

      if (load1 > cpuCount * 2) {
        issues.push(`HIGH LOAD: ${load1.toFixed(2)} (${cpuCount} CPUs) - System overloaded`);
      } else if (load1 > cpuCount) {
        issues.push(`MODERATE LOAD: ${load1.toFixed(2)} (${cpuCount} CPUs) - System busy`);
      }
      this.outputChannel.appendLine(`  Load: ${load1.toFixed(2)} / ${load5.toFixed(2)} (${cpuCount} CPUs)`);

      // Check memory
      this.outputChannel.appendLine('\nChecking memory...');
      const memResult = await connection.exec("free -m | grep -E '^(Mem|Swap):'");
      const memLines = memResult.trim().split('\n');

      for (const line of memLines) {
        const parts = line.split(/\s+/);
        if (parts[0] === 'Mem:') {
          const total = parseInt(parts[1], 10);
          const used = parseInt(parts[2], 10);
          const available = parseInt(parts[6], 10);
          const usedPercent = ((used / total) * 100).toFixed(1);
          const availPercent = ((available / total) * 100).toFixed(1);

          this.outputChannel.appendLine(`  RAM: ${used}MB / ${total}MB (${usedPercent}% used, ${availPercent}% available)`);

          if (available < total * 0.1) {
            issues.push(`LOW MEMORY: Only ${available}MB available (${availPercent}%)`);
          }
        } else if (parts[0] === 'Swap:') {
          const swapTotal = parseInt(parts[1], 10);
          const swapUsed = parseInt(parts[2], 10);

          if (swapTotal > 0 && swapUsed > swapTotal * 0.5) {
            issues.push(`HIGH SWAP USAGE: ${swapUsed}MB / ${swapTotal}MB - Memory pressure`);
          }
          this.outputChannel.appendLine(`  Swap: ${swapUsed}MB / ${swapTotal}MB`);
        }
      }

      // Check disk I/O wait
      this.outputChannel.appendLine('\nChecking I/O wait...');
      const ioResult = await connection.exec("vmstat 1 2 | tail -1 | awk '{print $16}'");
      const ioWait = parseInt(ioResult.trim(), 10);
      this.outputChannel.appendLine(`  I/O Wait: ${ioWait}%`);

      if (ioWait > 20) {
        issues.push(`HIGH I/O WAIT: ${ioWait}% - Disk bottleneck`);
      }

      // Check disk space
      this.outputChannel.appendLine('\nChecking disk space...');
      const diskResult = await connection.exec("df -h | grep -E '^/dev' | awk '{print $5, $6}'");
      const diskLines = diskResult.trim().split('\n');

      for (const line of diskLines) {
        const [percent, mount] = line.split(' ');
        const usage = parseInt(percent, 10);
        this.outputChannel.appendLine(`  ${mount}: ${percent}`);

        if (usage > 90) {
          issues.push(`DISK FULL: ${mount} at ${percent}`);
        }
      }

      // Check for CPU-hungry processes
      this.outputChannel.appendLine('\nChecking CPU-hungry processes...');
      const cpuProcs = await connection.exec("ps aux --sort=-%cpu | head -4 | tail -3");
      cpuProcs.trim().split('\n').forEach((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length > 10) {
          const cpu = parseFloat(parts[2]);
          if (cpu > 50) {
            const cmd = parts.slice(10).join(' ').substring(0, 40);
            issues.push(`HIGH CPU PROCESS: ${cmd} (${cpu}%)`);
          }
          this.outputChannel.appendLine(`  ${parts[2]}% - ${parts.slice(10).join(' ').substring(0, 50)}`);
        }
      });

      // Check for memory-hungry processes
      this.outputChannel.appendLine('\nChecking memory-hungry processes...');
      const memProcs = await connection.exec("ps aux --sort=-%mem | head -4 | tail -3");
      memProcs.trim().split('\n').forEach((line) => {
        const parts = line.trim().split(/\s+/);
        if (parts.length > 10) {
          const mem = parseFloat(parts[3]);
          if (mem > 30) {
            const cmd = parts.slice(10).join(' ').substring(0, 40);
            issues.push(`HIGH MEM PROCESS: ${cmd} (${mem}%)`);
          }
          this.outputChannel.appendLine(`  ${parts[3]}% - ${parts.slice(10).join(' ').substring(0, 50)}`);
        }
      });

      // Check network
      this.outputChannel.appendLine('\nChecking network connections...');
      const netResult = await connection.exec("ss -s 2>/dev/null || netstat -s 2>/dev/null | head -5");
      this.outputChannel.appendLine(`  ${netResult.split('\n')[0]}`);

      // Summary
      this.outputChannel.appendLine(`\n${'='.repeat(60)}`);
      this.outputChannel.appendLine('DIAGNOSIS SUMMARY:');
      this.outputChannel.appendLine('='.repeat(60));

      if (issues.length === 0) {
        this.outputChannel.appendLine('  No obvious issues found. Server appears healthy.');
      } else {
        issues.forEach((issue, i) => {
          this.outputChannel.appendLine(`  ${i + 1}. ${issue}`);
        });
      }
    } catch (error) {
      this.outputChannel.appendLine(`Error during diagnosis: ${(error as Error).message}`);
    }
  }

  /**
   * Watch server status in real-time (runs top for a few seconds)
   */
  async watchStatus(connection: SSHConnection, seconds: number = 5): Promise<void> {
    this.outputChannel.show();
    this.outputChannel.appendLine(`\n${'='.repeat(60)}`);
    this.outputChannel.appendLine(`Watching: ${connection.host.name} for ${seconds}s`);
    this.outputChannel.appendLine('='.repeat(60));

    try {
      const result = await connection.exec(`top -b -n ${seconds} -d 1 | head -50`);
      this.outputChannel.appendLine(result);
    } catch (error) {
      this.outputChannel.appendLine(`Error: ${(error as Error).message}`);
    }
  }

  /**
   * Check specific service status
   */
  async checkService(connection: SSHConnection, serviceName: string): Promise<void> {
    this.outputChannel.show();
    this.outputChannel.appendLine(`\n${'='.repeat(60)}`);
    this.outputChannel.appendLine(`Service Check: ${serviceName} on ${connection.host.name}`);
    this.outputChannel.appendLine('='.repeat(60));

    try {
      // Try systemctl first, then fall back to service command
      const result = await connection.exec(`
        if command -v systemctl &>/dev/null; then
          systemctl status ${serviceName} 2>&1 | head -20
        elif command -v service &>/dev/null; then
          service ${serviceName} status 2>&1
        else
          echo "Cannot determine service manager"
        fi
      `);
      this.outputChannel.appendLine(result);
    } catch (error) {
      this.outputChannel.appendLine(`Error: ${(error as Error).message}`);
    }
  }

  /**
   * List all running services
   */
  async listServices(connection: SSHConnection): Promise<void> {
    this.outputChannel.show();
    this.outputChannel.appendLine(`\n${'='.repeat(60)}`);
    this.outputChannel.appendLine(`Running Services: ${connection.host.name}`);
    this.outputChannel.appendLine('='.repeat(60));

    try {
      const result = await connection.exec(`
        if command -v systemctl &>/dev/null; then
          systemctl list-units --type=service --state=running --no-pager | head -30
        else
          service --status-all 2>/dev/null | grep '+' | head -30
        fi
      `);
      this.outputChannel.appendLine(result);
    } catch (error) {
      this.outputChannel.appendLine(`Error: ${(error as Error).message}`);
    }
  }

  /**
   * Check recent logs (last 50 lines of syslog)
   */
  async recentLogs(connection: SSHConnection): Promise<void> {
    this.outputChannel.show();
    this.outputChannel.appendLine(`\n${'='.repeat(60)}`);
    this.outputChannel.appendLine(`Recent Logs: ${connection.host.name}`);
    this.outputChannel.appendLine('='.repeat(60));

    try {
      const result = await connection.exec(`
        if command -v journalctl &>/dev/null; then
          journalctl -n 50 --no-pager 2>/dev/null
        elif [ -f /var/log/syslog ]; then
          tail -50 /var/log/syslog
        elif [ -f /var/log/messages ]; then
          tail -50 /var/log/messages
        else
          echo "No standard log file found"
        fi
      `);
      this.outputChannel.appendLine(result);
    } catch (error) {
      this.outputChannel.appendLine(`Error: ${(error as Error).message}`);
    }
  }

  /**
   * Network diagnostics
   */
  async networkDiagnostics(connection: SSHConnection): Promise<void> {
    this.outputChannel.show();
    this.outputChannel.appendLine(`\n${'='.repeat(60)}`);
    this.outputChannel.appendLine(`Network Diagnostics: ${connection.host.name}`);
    this.outputChannel.appendLine('='.repeat(60));

    try {
      const result = await connection.exec(`
        echo "=== INTERFACES ==="
        ip addr 2>/dev/null || ifconfig
        echo ""
        echo "=== LISTENING PORTS ==="
        ss -tuln 2>/dev/null || netstat -tuln
        echo ""
        echo "=== ROUTING TABLE ==="
        ip route 2>/dev/null || route -n
        echo ""
        echo "=== DNS ==="
        cat /etc/resolv.conf | grep -v '^#'
      `);
      this.outputChannel.appendLine(result);
    } catch (error) {
      this.outputChannel.appendLine(`Error: ${(error as Error).message}`);
    }
  }

  /**
   * Show output channel
   */
  show(): void {
    this.outputChannel.show();
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.outputChannel.dispose();
  }
}

/**
 * Quick pick options for monitor commands
 */
export async function showMonitorQuickPick(connection: SSHConnection): Promise<void> {
  const monitor = ServerMonitorService.getInstance();

  const options = [
    { label: '$(pulse) Quick Status', description: 'Overview of CPU, memory, disk', action: 'quick' },
    { label: '$(bug) Diagnose Slowness', description: 'Find why server is slow', action: 'diagnose' },
    { label: '$(eye) Watch (5s)', description: 'Real-time monitoring for 5 seconds', action: 'watch' },
    { label: '$(server) List Services', description: 'Show running services', action: 'services' },
    { label: '$(output) Recent Logs', description: 'Last 50 log entries', action: 'logs' },
    { label: '$(globe) Network Info', description: 'Network interfaces and ports', action: 'network' },
    { label: '$(search) Check Service...', description: 'Check specific service status', action: 'check-service' },
  ];

  const selected = await vscode.window.showQuickPick(options, {
    placeHolder: `Monitor: ${connection.host.name}`,
    ignoreFocusOut: true,
  });

  if (!selected) {
    return;
  }

  switch (selected.action) {
    case 'quick':
      await monitor.quickStatus(connection);
      break;
    case 'diagnose':
      await monitor.diagnoseSlowness(connection);
      break;
    case 'watch':
      await monitor.watchStatus(connection, 5);
      break;
    case 'services':
      await monitor.listServices(connection);
      break;
    case 'logs':
      await monitor.recentLogs(connection);
      break;
    case 'network':
      await monitor.networkDiagnostics(connection);
      break;
    case 'check-service':
      const serviceName = await vscode.window.showInputBox({
        prompt: 'Enter service name to check',
        placeHolder: 'nginx, mysql, docker, etc.',
      });
      if (serviceName) {
        await monitor.checkService(connection, serviceName);
      }
      break;
  }
}
