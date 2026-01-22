import * as vscode from 'vscode';
import { SSHConnection } from '../connection/SSHConnection';
import { TerminalService } from './TerminalService';

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
   * Open a live monitoring terminal with htop or top
   * LITE compliant: User triggers, user controls, user closes
   * Fallback chain: htop -> top -> watch-based script
   */
  async watchLiveTerminal(connection: SSHConnection): Promise<void> {
    const terminalService = TerminalService.getInstance();

    try {
      // Create a terminal that will run htop or top
      const terminal = await terminalService.createTerminal(connection);

      // Fallback chain: htop -> top -> watch-based monitoring script
      // The script is formatted as a single line with proper semicolons
      const fallbackScript =
        'if command -v htop &>/dev/null; then htop; ' +
        'elif command -v top &>/dev/null; then top; ' +
        'else echo "Neither htop nor top found. Using basic monitoring..."; echo "Press Ctrl+C to exit"; ' +
        'while true; do clear; echo "=== Server Monitor ($(date)) ==="; echo ""; ' +
        'echo "=== UPTIME ==="; uptime 2>/dev/null || echo "N/A"; echo ""; ' +
        'echo "=== MEMORY ==="; free -h 2>/dev/null || cat /proc/meminfo 2>/dev/null | head -5; echo ""; ' +
        'echo "=== DISK ==="; df -h 2>/dev/null | grep -E "^/dev|Filesystem"; echo ""; ' +
        'echo "=== TOP PROCESSES (CPU) ==="; ps aux --sort=-%cpu 2>/dev/null | head -6 || ps aux | head -6; echo ""; ' +
        'echo "[Refreshing in 2s... Press Ctrl+C to exit]"; sleep 2; done; fi';

      // Small delay to ensure shell is ready
      setTimeout(() => {
        terminal.sendText(fallbackScript);
      }, 500);

      vscode.window.setStatusBarMessage(
        `$(pulse) Live monitor opened for ${connection.host.name} - close terminal to stop`,
        5000
      );
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to open live monitor: ${(error as Error).message}`);
    }
  }

  /**
   * Open a live monitoring webview panel with periodic refresh
   * LITE compliant: User triggers initial load, user clicks refresh button
   */
  async openLiveMonitorPanel(connection: SSHConnection): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      'sshLiteMonitor',
      `Monitor: ${connection.host.name}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      }
    );

    // Track if panel is disposed
    let isDisposed = false;
    panel.onDidDispose(() => {
      isDisposed = true;
    });

    // Function to fetch and display status
    const refreshStatus = async () => {
      if (isDisposed) return;

      try {
        const status = await this.fetchServerStatus(connection);
        panel.webview.html = this.getMonitorWebviewContent(status, connection.host.name);
      } catch (error) {
        if (!isDisposed) {
          panel.webview.html = this.getMonitorErrorContent((error as Error).message, connection.host.name);
        }
      }
    };

    // Handle messages from webview (refresh button clicks)
    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.command === 'refresh') {
        await refreshStatus();
      } else if (message.command === 'openTerminal') {
        await this.watchLiveTerminal(connection);
      }
    });

    // Initial load
    panel.webview.html = this.getMonitorLoadingContent(connection.host.name);
    await refreshStatus();
  }

  /**
   * Fetch server status data
   */
  private async fetchServerStatus(connection: SSHConnection): Promise<ServerStatus> {
    const result = await connection.exec(`
      echo "===HOSTNAME==="
      hostname
      echo "===UPTIME==="
      uptime
      echo "===LOADAVG==="
      cat /proc/loadavg
      echo "===MEMORY==="
      free -b 2>/dev/null || vm_stat 2>/dev/null
      echo "===DISK==="
      df -h | grep -E '^/dev'
      echo "===TOP_CPU==="
      ps aux --sort=-%cpu 2>/dev/null | head -6 || ps aux | head -6
      echo "===TOP_MEM==="
      ps aux --sort=-%mem 2>/dev/null | head -6 || ps aux | head -6
      echo "===CONNECTIONS==="
      ss -tuln 2>/dev/null | wc -l || netstat -tuln 2>/dev/null | wc -l
      echo "===ZOMBIES==="
      ps aux 2>/dev/null | grep -c ' Z ' || echo "0"
    `);

    return this.parseServerStatus(result);
  }

  /**
   * Parse server status from command output
   */
  private parseServerStatus(output: string): ServerStatus {
    const sections = output.split(/===(\w+)===/);
    const status: ServerStatus = {
      timestamp: new Date().toLocaleString(),
      hostname: '',
      uptime: '',
      loadAverage: '',
      cpuUsage: 0,
      memoryUsed: 0,
      memoryTotal: 0,
      memoryPercent: 0,
      swapUsed: 0,
      swapTotal: 0,
      diskUsage: [],
      topProcesses: [],
      networkConnections: 0,
      zombieProcesses: 0,
    };

    for (let i = 1; i < sections.length; i += 2) {
      const sectionName = sections[i];
      const content = sections[i + 1]?.trim() || '';

      switch (sectionName) {
        case 'HOSTNAME':
          status.hostname = content;
          break;
        case 'UPTIME':
          status.uptime = content;
          // Extract load average from uptime output
          const loadMatch = content.match(/load average[s]?:\s*([\d.]+)/i);
          if (loadMatch) {
            status.loadAverage = loadMatch[1];
          }
          break;
        case 'LOADAVG':
          const loadParts = content.split(' ');
          if (loadParts.length >= 3) {
            status.loadAverage = `${loadParts[0]} ${loadParts[1]} ${loadParts[2]}`;
          }
          break;
        case 'MEMORY':
          this.parseMemoryInfo(content, status);
          break;
        case 'DISK':
          status.diskUsage = this.parseDiskUsage(content);
          break;
        case 'TOP_CPU':
        case 'TOP_MEM':
          const procs = this.parseProcessList(content);
          // Merge without duplicates
          for (const proc of procs) {
            if (!status.topProcesses.find(p => p.pid === proc.pid)) {
              status.topProcesses.push(proc);
            }
          }
          break;
        case 'CONNECTIONS':
          status.networkConnections = parseInt(content, 10) || 0;
          break;
        case 'ZOMBIES':
          status.zombieProcesses = Math.max(0, (parseInt(content, 10) || 0) - 1);
          break;
      }
    }

    return status;
  }

  /**
   * Parse memory info from free command
   */
  private parseMemoryInfo(content: string, status: ServerStatus): void {
    const lines = content.split('\n');
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts[0] === 'Mem:' && parts.length >= 3) {
        status.memoryTotal = parseInt(parts[1], 10) || 0;
        status.memoryUsed = parseInt(parts[2], 10) || 0;
        if (status.memoryTotal > 0) {
          status.memoryPercent = Math.round((status.memoryUsed / status.memoryTotal) * 100);
        }
      } else if (parts[0] === 'Swap:' && parts.length >= 3) {
        status.swapTotal = parseInt(parts[1], 10) || 0;
        status.swapUsed = parseInt(parts[2], 10) || 0;
      }
    }
  }

  /**
   * Parse disk usage from df output
   */
  private parseDiskUsage(content: string): DiskUsage[] {
    const disks: DiskUsage[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 6 && parts[0].startsWith('/dev')) {
        disks.push({
          filesystem: parts[0],
          size: parts[1],
          used: parts[2],
          available: parts[3],
          percent: parseInt(parts[4], 10) || 0,
          mountPoint: parts[5],
        });
      }
    }

    return disks;
  }

  /**
   * Parse process list from ps output
   */
  private parseProcessList(content: string): ProcessInfo[] {
    const procs: ProcessInfo[] = [];
    const lines = content.split('\n').slice(1); // Skip header

    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 11) {
        procs.push({
          pid: parseInt(parts[1], 10) || 0,
          user: parts[0],
          cpu: parseFloat(parts[2]) || 0,
          mem: parseFloat(parts[3]) || 0,
          command: parts.slice(10).join(' ').substring(0, 50),
        });
      }
    }

    return procs.slice(0, 5);
  }

  /**
   * Generate webview HTML for monitor panel
   */
  private getMonitorWebviewContent(status: ServerStatus, hostName: string): string {
    const formatBytes = (bytes: number): string => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    const getStatusColor = (percent: number): string => {
      if (percent >= 90) return '#f44336';
      if (percent >= 70) return '#ff9800';
      return '#4caf50';
    };

    const diskRows = status.diskUsage.map(d => `
      <tr>
        <td>${d.mountPoint}</td>
        <td>${d.size}</td>
        <td>${d.used} / ${d.available}</td>
        <td>
          <div class="progress-bar">
            <div class="progress-fill" style="width: ${d.percent}%; background: ${getStatusColor(d.percent)}"></div>
          </div>
          <span>${d.percent}%</span>
        </td>
      </tr>
    `).join('');

    const processRows = status.topProcesses.map(p => `
      <tr>
        <td>${p.pid}</td>
        <td>${p.user}</td>
        <td>${p.cpu.toFixed(1)}%</td>
        <td>${p.mem.toFixed(1)}%</td>
        <td class="cmd">${p.command}</td>
      </tr>
    `).join('');

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
      margin: 0;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .header h1 {
      margin: 0;
      font-size: 1.4em;
    }
    .header-actions {
      display: flex;
      gap: 8px;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 6px 14px;
      cursor: pointer;
      border-radius: 2px;
      font-size: 13px;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    .timestamp {
      color: var(--vscode-descriptionForeground);
      font-size: 0.9em;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
      margin-bottom: 20px;
    }
    .card {
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      padding: 12px;
    }
    .card h3 {
      margin: 0 0 8px 0;
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
    }
    .card .value {
      font-size: 1.8em;
      font-weight: bold;
    }
    .card .sub {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
    }
    .progress-bar {
      height: 8px;
      background: var(--vscode-progressBar-background);
      border-radius: 4px;
      overflow: hidden;
      display: inline-block;
      width: 100px;
      vertical-align: middle;
      margin-right: 8px;
    }
    .progress-fill {
      height: 100%;
      transition: width 0.3s;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.9em;
    }
    th, td {
      text-align: left;
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    th {
      color: var(--vscode-descriptionForeground);
      font-weight: normal;
      text-transform: uppercase;
      font-size: 0.85em;
    }
    .cmd {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.9em;
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .section {
      margin-bottom: 24px;
    }
    .section h2 {
      margin: 0 0 12px 0;
      font-size: 1.1em;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .warning {
      color: #ff9800;
    }
    .danger {
      color: #f44336;
    }
  </style>
</head>
<body>
  <div class="header">
    <div>
      <h1>📊 ${hostName}</h1>
      <div class="timestamp">Last updated: ${status.timestamp}</div>
    </div>
    <div class="header-actions">
      <button onclick="refresh()">↻ Refresh</button>
      <button class="secondary" onclick="openTerminal()">▶ Live Terminal (htop)</button>
    </div>
  </div>

  <div class="grid">
    <div class="card">
      <h3>Load Average</h3>
      <div class="value">${status.loadAverage.split(' ')[0] || 'N/A'}</div>
      <div class="sub">${status.loadAverage}</div>
    </div>
    <div class="card">
      <h3>Memory</h3>
      <div class="value" style="color: ${getStatusColor(status.memoryPercent)}">${status.memoryPercent}%</div>
      <div class="sub">${formatBytes(status.memoryUsed)} / ${formatBytes(status.memoryTotal)}</div>
    </div>
    <div class="card">
      <h3>Swap</h3>
      <div class="value">${status.swapTotal > 0 ? Math.round((status.swapUsed / status.swapTotal) * 100) + '%' : 'N/A'}</div>
      <div class="sub">${formatBytes(status.swapUsed)} / ${formatBytes(status.swapTotal)}</div>
    </div>
    <div class="card">
      <h3>Connections</h3>
      <div class="value">${status.networkConnections}</div>
      <div class="sub">Network listeners</div>
    </div>
  </div>

  ${status.zombieProcesses > 0 ? `
  <div class="section">
    <div class="danger">⚠️ ${status.zombieProcesses} zombie process${status.zombieProcesses > 1 ? 'es' : ''} detected</div>
  </div>
  ` : ''}

  <div class="section">
    <h2>💾 Disk Usage</h2>
    <table>
      <tr><th>Mount</th><th>Size</th><th>Used / Free</th><th>Usage</th></tr>
      ${diskRows}
    </table>
  </div>

  <div class="section">
    <h2>⚡ Top Processes</h2>
    <table>
      <tr><th>PID</th><th>User</th><th>CPU</th><th>MEM</th><th>Command</th></tr>
      ${processRows}
    </table>
  </div>

  <div class="section" style="color: var(--vscode-descriptionForeground); font-size: 0.85em;">
    <p>💡 <strong>LITE Mode:</strong> Click "Refresh" to update. For continuous monitoring, use "Live Terminal" to open htop.</p>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    function refresh() {
      vscode.postMessage({ command: 'refresh' });
    }
    function openTerminal() {
      vscode.postMessage({ command: 'openTerminal' });
    }
  </script>
</body>
</html>`;
  }

  /**
   * Generate loading content for monitor panel
   */
  private getMonitorLoadingContent(hostName: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
    }
    .loading {
      text-align: center;
    }
    .spinner {
      font-size: 2em;
      animation: spin 1s linear infinite;
      display: inline-block;
    }
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="loading">
    <div class="spinner">⟳</div>
    <p>Loading status for ${hostName}...</p>
  </div>
</body>
</html>`;
  }

  /**
   * Generate error content for monitor panel
   */
  private getMonitorErrorContent(errorMessage: string, hostName: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 20px;
    }
    .error {
      background: var(--vscode-inputValidation-errorBackground);
      border: 1px solid var(--vscode-inputValidation-errorBorder);
      padding: 16px;
      border-radius: 4px;
      margin-bottom: 16px;
    }
    button {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      padding: 8px 16px;
      cursor: pointer;
      border-radius: 2px;
    }
  </style>
</head>
<body>
  <h2>❌ Error loading status for ${hostName}</h2>
  <div class="error">${errorMessage}</div>
  <button onclick="vscode.postMessage({ command: 'refresh' })">Try Again</button>
  <script>const vscode = acquireVsCodeApi();</script>
</body>
</html>`;
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
    { label: '$(dashboard) Live Monitor Panel', description: 'Dashboard with manual refresh (Recommended)', action: 'panel' },
    { label: '$(terminal) Live Terminal (htop)', description: 'Real-time htop/top in terminal', action: 'live-terminal' },
    { label: '$(pulse) Quick Status', description: 'One-time snapshot to Output', action: 'quick' },
    { label: '$(bug) Diagnose Slowness', description: 'Find why server is slow', action: 'diagnose' },
    { label: '$(eye) Watch (5s)', description: 'Run top for 5 seconds', action: 'watch' },
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
    case 'panel':
      await monitor.openLiveMonitorPanel(connection);
      break;
    case 'live-terminal':
      await monitor.watchLiveTerminal(connection);
      break;
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
