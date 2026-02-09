import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SSHConfig from 'ssh-config';
import { IHostConfig } from '../types';
import { expandPath, validatePort } from '../utils/helpers';

/**
 * Service for managing SSH host configurations
 * Loads from both ~/.ssh/config and VS Code settings
 */
export class HostService {
  private static _instance: HostService;

  // Cache for SSH config hosts (parsed once, invalidated manually)
  private sshConfigHostsCache: IHostConfig[] | null = null;
  private sshConfigMtime: number = 0;

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): HostService {
    if (!HostService._instance) {
      HostService._instance = new HostService();
    }
    return HostService._instance;
  }

  /**
   * Get all available hosts from both sources (synchronous for instant UI)
   */
  getAllHosts(): IHostConfig[] {
    const sshConfigHosts = this.loadSSHConfigHosts();
    const savedHosts = this.loadSavedHosts();

    // Merge hosts, saved hosts take priority for duplicates
    const hostMap = new Map<string, IHostConfig>();

    for (const host of sshConfigHosts) {
      hostMap.set(host.id, host);
    }

    for (const host of savedHosts) {
      hostMap.set(host.id, host);
    }

    return Array.from(hostMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get the SSH config file path
   */
  getSSHConfigPath(): string {
    const config = vscode.workspace.getConfiguration('sshLite');
    const configPath = config.get<string>('sshConfigPath', '');
    if (configPath) {
      return expandPath(configPath);
    }
    return path.join(os.homedir(), '.ssh', 'config');
  }

  /**
   * Load hosts from ~/.ssh/config (with caching for performance)
   */
  private loadSSHConfigHosts(): IHostConfig[] {
    const configPath = this.getSSHConfigPath();

    if (!fs.existsSync(configPath)) {
      this.sshConfigHostsCache = [];
      return [];
    }

    // Check if file has been modified since last cache
    try {
      const stats = fs.statSync(configPath);
      if (this.sshConfigHostsCache !== null && stats.mtimeMs === this.sshConfigMtime) {
        // Return cached hosts - file hasn't changed
        return this.sshConfigHostsCache;
      }
      this.sshConfigMtime = stats.mtimeMs;
    } catch {
      // If stat fails, proceed to parse
    }

    try {
      const content = fs.readFileSync(configPath, 'utf-8');
      const parsed = SSHConfig.parse(content);
      const hosts: IHostConfig[] = [];

      for (const section of parsed) {
        if (section.type === SSHConfig.DIRECTIVE && section.param === 'Host') {
          const hostPattern = section.value as string;

          // Skip wildcard patterns
          if (hostPattern.includes('*') || hostPattern.includes('?')) {
            continue;
          }

          // Compute effective config for this host
          const computed = parsed.compute(hostPattern);

          const hostnameVal = computed.HostName || hostPattern;
          const hostname = Array.isArray(hostnameVal) ? hostnameVal[0] : hostnameVal;
          const portVal = computed.Port;
          const port = parseInt(Array.isArray(portVal) ? portVal[0] : (portVal as string), 10) || 22;
          const userVal = computed.User || os.userInfo().username;
          const username = Array.isArray(userVal) ? userVal[0] : userVal;
          const identityFile = computed.IdentityFile;

          // Get first identity file if it's an array
          let privateKeyPath: string | undefined;
          if (Array.isArray(identityFile)) {
            privateKeyPath = identityFile[0];
          } else if (identityFile) {
            privateKeyPath = identityFile;
          }

          hosts.push({
            id: `${hostname}:${port}:${username}`,
            name: hostPattern,
            host: hostname,
            port,
            username,
            privateKeyPath: privateKeyPath ? expandPath(privateKeyPath) : undefined,
            source: 'ssh-config',
          });
        }
      }

      // Cache the parsed hosts
      this.sshConfigHostsCache = hosts;
      return hosts;
    } catch (error) {
      console.error('Failed to parse SSH config:', error);
      this.sshConfigHostsCache = [];
      return [];
    }
  }

  /**
   * Invalidate the SSH config cache (call when user modifies SSH config externally)
   */
  invalidateCache(): void {
    this.sshConfigHostsCache = null;
    this.sshConfigMtime = 0;
  }

  /**
   * Load saved hosts from VS Code settings
   */
  private loadSavedHosts(): IHostConfig[] {
    const config = vscode.workspace.getConfiguration('sshLite');
    const savedHosts = config.get<Array<{
      name: string;
      host: string;
      port?: number;
      username: string;
      privateKeyPath?: string;
      tabLabel?: string;
    }>>('hosts', []);

    const validHosts: IHostConfig[] = [];
    for (const host of savedHosts) {
      // Validate required fields - skip invalid entries
      if (!host.name || !host.host || !host.username) {
        const missing = [
          !host.name && 'name',
          !host.host && 'host',
          !host.username && 'username',
        ].filter(Boolean).join(', ');
        console.warn(`[SSH Lite] Skipping invalid saved host: missing ${missing}. Entry: ${JSON.stringify(host)}`);
        continue;
      }
      validHosts.push({
        id: `${host.host}:${host.port || 22}:${host.username}`,
        name: host.name,
        host: host.host,
        port: host.port || 22,
        username: host.username,
        privateKeyPath: host.privateKeyPath ? expandPath(host.privateKeyPath) : undefined,
        tabLabel: host.tabLabel,
        source: 'saved' as const,
      });
    }
    return validHosts;
  }

  /**
   * Save a new host to VS Code settings
   */
  async saveHost(host: Omit<IHostConfig, 'id' | 'source'>): Promise<void> {
    const config = vscode.workspace.getConfiguration('sshLite');
    const savedHosts = config.get<Array<{
      name: string;
      host: string;
      port?: number;
      username: string;
      privateKeyPath?: string;
      tabLabel?: string;
    }>>('hosts', []);

    // Check for duplicate
    const existingIndex = savedHosts.findIndex(
      (h) => h.host === host.host && h.username === host.username && (h.port || 22) === host.port
    );

    const newHost = {
      name: host.name,
      host: host.host,
      port: host.port,
      username: host.username,
      privateKeyPath: host.privateKeyPath,
      tabLabel: host.tabLabel,
    };

    if (existingIndex >= 0) {
      savedHosts[existingIndex] = newHost;
    } else {
      savedHosts.push(newHost);
    }

    await config.update('hosts', savedHosts, vscode.ConfigurationTarget.Global);
  }

  /**
   * Remove a host from VS Code settings
   */
  async removeHost(hostId: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('sshLite');
    const savedHosts = config.get<Array<{
      name: string;
      host: string;
      port?: number;
      username: string;
      privateKeyPath?: string;
    }>>('hosts', []);

    const [hostAddr, portStr, username] = hostId.split(':');
    const port = parseInt(portStr, 10);

    const filtered = savedHosts.filter(
      (h) => !(h.host === hostAddr && (h.port || 22) === port && h.username === username)
    );

    await config.update('hosts', filtered, vscode.ConfigurationTarget.Global);
  }

  /**
   * Remove a Host block from ~/.ssh/config file
   */
  async removeHostFromSSHConfig(hostName: string): Promise<void> {
    const configPath = this.getSSHConfigPath();
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = SSHConfig.parse(content);
    parsed.remove({ Host: hostName });
    fs.writeFileSync(configPath, parsed.toString(), 'utf-8');
    this.invalidateCache();
  }

  /**
   * Rename a saved host's display name
   */
  async renameHost(hostId: string, newName: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('sshLite');
    const savedHosts = config.get<Array<{
      name: string;
      host: string;
      port?: number;
      username: string;
      privateKeyPath?: string;
      tabLabel?: string;
    }>>('hosts', []);

    const [hostAddr, portStr, username] = hostId.split(':');
    const port = parseInt(portStr, 10);

    const host = savedHosts.find(
      (h) => h.host === hostAddr && (h.port || 22) === port && h.username === username
    );

    if (host) {
      host.name = newName;
      await config.update('hosts', savedHosts, vscode.ConfigurationTarget.Global);
    }
  }

  /**
   * Set or clear the tab label for a saved host
   */
  async setTabLabel(hostId: string, tabLabel: string | undefined): Promise<void> {
    const config = vscode.workspace.getConfiguration('sshLite');
    const savedHosts = config.get<Array<{
      name: string;
      host: string;
      port?: number;
      username: string;
      privateKeyPath?: string;
      tabLabel?: string;
    }>>('hosts', []);

    const [hostAddr, portStr, username] = hostId.split(':');
    const port = parseInt(portStr, 10);

    const host = savedHosts.find(
      (h) => h.host === hostAddr && (h.port || 22) === port && h.username === username
    );

    if (host) {
      if (tabLabel) {
        host.tabLabel = tabLabel;
      } else {
        delete host.tabLabel;
      }
      await config.update('hosts', savedHosts, vscode.ConfigurationTarget.Global);
    }
  }

  /**
   * Prompt user to add a new host
   */
  async promptAddHost(): Promise<IHostConfig | undefined> {
    const name = await vscode.window.showInputBox({
      prompt: 'Enter a display name for this host',
      placeHolder: 'My Server',
      ignoreFocusOut: true,
    });

    if (!name) {
      return undefined;
    }

    const host = await vscode.window.showInputBox({
      prompt: 'Enter hostname or IP address',
      placeHolder: 'example.com or 192.168.1.1',
      ignoreFocusOut: true,
    });

    if (!host) {
      return undefined;
    }

    const portStr = await vscode.window.showInputBox({
      prompt: 'Enter SSH port',
      value: '22',
      ignoreFocusOut: true,
      validateInput: validatePort,
    });

    if (!portStr) {
      return undefined;
    }

    const port = parseInt(portStr, 10);

    const username = await vscode.window.showInputBox({
      prompt: 'Enter username',
      value: os.userInfo().username,
      ignoreFocusOut: true,
    });

    if (!username) {
      return undefined;
    }

    const privateKeyPath = await vscode.window.showInputBox({
      prompt: 'Enter path to private key (optional, leave empty for password auth)',
      placeHolder: '~/.ssh/id_rsa',
      ignoreFocusOut: true,
    });

    const hostConfig: Omit<IHostConfig, 'id' | 'source'> = {
      name,
      host,
      port,
      username,
      privateKeyPath: privateKeyPath || undefined,
    };

    await this.saveHost(hostConfig);

    return {
      ...hostConfig,
      id: `${host}:${port}:${username}`,
      source: 'saved',
    };
  }

  /**
   * Prompt user to edit a host
   */
  async promptEditHost(hostConfig: IHostConfig): Promise<IHostConfig | undefined> {
    const name = await vscode.window.showInputBox({
      prompt: 'Enter a display name for this host',
      value: hostConfig.name,
      ignoreFocusOut: true,
    });

    if (!name) {
      return undefined;
    }

    const host = await vscode.window.showInputBox({
      prompt: 'Enter hostname or IP address',
      value: hostConfig.host,
      ignoreFocusOut: true,
    });

    if (!host) {
      return undefined;
    }

    const portStr = await vscode.window.showInputBox({
      prompt: 'Enter SSH port',
      value: hostConfig.port.toString(),
      ignoreFocusOut: true,
      validateInput: validatePort,
    });

    if (!portStr) {
      return undefined;
    }

    const port = parseInt(portStr, 10);

    const username = await vscode.window.showInputBox({
      prompt: 'Enter username',
      value: hostConfig.username,
      ignoreFocusOut: true,
    });

    if (!username) {
      return undefined;
    }

    const privateKeyPath = await vscode.window.showInputBox({
      prompt: 'Enter path to private key (optional, leave empty for password auth)',
      value: hostConfig.privateKeyPath || '',
      ignoreFocusOut: true,
    });

    // Remove old host
    await this.removeHost(hostConfig.id);

    // Save new host
    const newConfig: Omit<IHostConfig, 'id' | 'source'> = {
      name,
      host,
      port,
      username,
      privateKeyPath: privateKeyPath || undefined,
    };

    await this.saveHost(newConfig);

    return {
      ...newConfig,
      id: `${host}:${port}:${username}`,
      source: 'saved',
    };
  }
}
