import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import SSHConfig from 'ssh-config';
import { IHostConfig } from '../types';
import { expandPath, validatePort } from '../utils/helpers';
import { pickPrivateKeyPath } from '../utils/keyFilePicker';
import { buildHostId, parseHostId } from '../utils/hostId';

/**
 * Resolve a saved host's effective port, defaulting by connection type:
 * FTP → 21, SSH → 22. A saved host may omit `port` (it relies on the default),
 * and `loadSavedHosts` builds the host id with this same type-aware default —
 * so any port comparison against a parsed id MUST use this helper too, or an
 * FTP host on the default port 21 silently fails to match (id says 21, a plain
 * `port || 22` says 22). See issue cluster around FTP host management.
 */
export function effectiveHostPort(h: { port?: number; connectionType?: 'ssh' | 'ftp' }): number {
  return h.port || (h.connectionType === 'ftp' ? 21 : 22);
}

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
      username?: string;
      isEndpoint?: boolean;
      privateKeyPath?: string;
      tabLabel?: string;
      connectionType?: 'ssh' | 'ftp';
      secure?: boolean;
      anonymous?: boolean;
    }>>('hosts', []);

    const validHosts: IHostConfig[] = [];
    for (const host of savedHosts) {
      // Validate required fields - skip invalid entries.
      // An endpoint record (isEndpoint:true) has no username and is allowed; a
      // record with neither a username nor the endpoint flag is malformed -> skip.
      if (!host.name || !host.host || (!host.username && !host.isEndpoint)) {
        const missing = [
          !host.name && 'name',
          !host.host && 'host',
          !host.username && !host.isEndpoint && 'username',
        ].filter(Boolean).join(', ');
        console.warn(`[SSH Lite] Skipping invalid saved host: missing ${missing}. Entry: ${JSON.stringify(host)}`);
        continue;
      }
      const port = effectiveHostPort(host);
      const username = host.username ?? '';
      validHosts.push({
        id: buildHostId({ host: host.host, port, username, connectionType: host.connectionType }),
        name: host.name,
        host: host.host,
        port,
        username,
        isEndpoint: host.isEndpoint,
        privateKeyPath: host.privateKeyPath ? expandPath(host.privateKeyPath) : undefined,
        tabLabel: host.tabLabel,
        source: 'saved' as const,
        connectionType: host.connectionType,
        secure: host.secure,
        anonymous: host.anonymous,
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
      username?: string;
      isEndpoint?: boolean;
      privateKeyPath?: string;
      tabLabel?: string;
      connectionType?: 'ssh' | 'ftp';
      secure?: boolean;
      anonymous?: boolean;
    }>>('hosts', []);

    // Check for duplicate. Normalise username to '' so an endpoint (no username)
    // dedups against another endpoint on the same host:port instead of stacking.
    const existingIndex = savedHosts.findIndex(
      (h) => h.host === host.host && (h.username ?? '') === (host.username ?? '') && effectiveHostPort(h) === host.port
    );

    const newHost = {
      name: host.name,
      host: host.host,
      port: host.port,
      username: host.username ?? '',
      isEndpoint: host.isEndpoint,
      privateKeyPath: host.privateKeyPath,
      tabLabel: host.tabLabel,
      connectionType: host.connectionType,
      secure: host.secure,
      anonymous: host.anonymous,
    };

    if (existingIndex >= 0) {
      savedHosts[existingIndex] = newHost;
    } else {
      savedHosts.push(newHost);
    }

    await config.update('hosts', savedHosts, vscode.ConfigurationTarget.Global);
  }

  /**
   * Return saved hosts in their stored (UNEXPANDED) form for export (issue #11).
   *
   * Unlike {@link getAllHosts}, this reads only the user's saved hosts (not
   * `~/.ssh/config` entries, which live in that file) and preserves the raw
   * `privateKeyPath` (e.g. `~/.ssh/id_rsa`) so the export stays portable across
   * machines and operating systems. Invalid entries are skipped.
   */
  getSavedHostsForExport(): Array<{
    name: string;
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string;
    tabLabel?: string;
    connectionType?: 'ssh' | 'ftp';
    secure?: boolean;
    anonymous?: boolean;
  }> {
    const config = vscode.workspace.getConfiguration('sshLite');
    const saved = config.get<Array<{
      name?: string;
      host?: string;
      port?: number;
      username?: string;
      privateKeyPath?: string;
      tabLabel?: string;
      connectionType?: 'ssh' | 'ftp';
      secure?: boolean;
      anonymous?: boolean;
    }>>('hosts', []);

    const out = [];
    for (const h of saved) {
      if (!h || !h.name || !h.host || !h.username) {
        continue;
      }
      const isFtp = h.connectionType === 'ftp';
      const entry: {
        name: string;
        host: string;
        port: number;
        username: string;
        privateKeyPath?: string;
        tabLabel?: string;
        connectionType?: 'ssh' | 'ftp';
        secure?: boolean;
        anonymous?: boolean;
      } = {
        name: h.name,
        host: h.host,
        port: effectiveHostPort(h),
        username: h.username,
      };
      if (h.privateKeyPath) {
        entry.privateKeyPath = h.privateKeyPath;
      }
      if (h.tabLabel) {
        entry.tabLabel = h.tabLabel;
      }
      if (isFtp) {
        entry.connectionType = 'ftp';
        if (h.secure) {
          entry.secure = true;
        }
        if (h.anonymous) {
          entry.anonymous = true;
        }
      }
      out.push(entry);
    }
    return out;
  }

  /**
   * Return EVERY connection the user sees in the Hosts panel for export
   * (issue #11). This is the union of `~/.ssh/config` hosts and saved hosts —
   * the same set {@link getAllHosts} shows — deduped by `host:port:username`.
   *
   * Saved hosts keep their raw (unexpanded `~`) key path; `~/.ssh/config` hosts
   * have their expanded key path collapsed back to `~` so the export is portable
   * to another machine/OS. A saved host takes priority over an ssh-config host
   * with the same id (matching {@link getAllHosts}).
   */
  getAllHostsForExport(): Array<{
    name: string;
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string;
    tabLabel?: string;
    connectionType?: 'ssh' | 'ftp';
    secure?: boolean;
    anonymous?: boolean;
  }> {
    type ExportHost = {
      name: string;
      host: string;
      port: number;
      username: string;
      privateKeyPath?: string;
      tabLabel?: string;
      connectionType?: 'ssh' | 'ftp';
      secure?: boolean;
      anonymous?: boolean;
    };

    const home = os.homedir();
    const collapse = (p?: string): string | undefined => {
      if (!p) {
        return undefined;
      }
      if (p === home) {
        return '~';
      }
      if (p.startsWith(home + path.sep) || p.startsWith(home + '/')) {
        return '~' + p.slice(home.length);
      }
      return p;
    };

    // Raw saved hosts (unexpanded paths), keyed by id for fidelity + priority.
    const savedRaw = new Map<string, ExportHost>();
    for (const h of this.getSavedHostsForExport()) {
      savedRaw.set(`${h.host}:${h.port}:${h.username}`, h);
    }

    const out: ExportHost[] = [];
    const seen = new Set<string>();
    // getAllHosts() already merges both sources and dedupes by id (saved wins).
    for (const h of this.getAllHosts()) {
      const id = h.id;
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);

      const saved = savedRaw.get(id);
      if (saved) {
        out.push(saved); // raw, portable, includes tabLabel
        continue;
      }
      const entry: ExportHost = {
        name: h.name,
        host: h.host,
        port: h.port,
        username: h.username,
      };
      const collapsed = collapse(h.privateKeyPath);
      if (collapsed) {
        entry.privateKeyPath = collapsed;
      }
      if (h.tabLabel) {
        entry.tabLabel = h.tabLabel;
      }
      out.push(entry);
    }
    return out;
  }

  /**
   * Import saved hosts from an exported list (issue #11).
   *
   * - `replace`: overwrite the saved-hosts list entirely with the imported set.
   * - `merge`: upsert each imported host by the `host:port:username` key (the
   *   same key {@link saveHost}/{@link removeHost} use), keeping every existing
   *   host that is not overwritten.
   *
   * Only the whitelisted host fields are persisted (no secrets, no stray keys),
   * and entries missing required fields (name/host/username) are skipped.
   * Returns how many entries were added vs updated.
   */
  async importSavedHosts(
    hosts: Array<{
      name: string;
      host: string;
      port?: number;
      username: string;
      privateKeyPath?: string;
      tabLabel?: string;
      connectionType?: 'ssh' | 'ftp';
      secure?: boolean;
      anonymous?: boolean;
    }>,
    mode: 'merge' | 'replace'
  ): Promise<{ added: number; updated: number }> {
    type SavedHostEntry = {
      name: string;
      host: string;
      port: number;
      username: string;
      privateKeyPath?: string;
      tabLabel?: string;
      connectionType?: 'ssh' | 'ftp';
      secure?: boolean;
      anonymous?: boolean;
    };

    // Whitelist + validate incoming entries (mirror loadSavedHosts' guard).
    const sanitized: SavedHostEntry[] = [];
    for (const h of hosts || []) {
      if (!h || !h.name || !h.host || !h.username) {
        continue;
      }
      const entry: SavedHostEntry = {
        name: h.name,
        host: h.host,
        port: effectiveHostPort(h),
        username: h.username,
      };
      if (h.privateKeyPath) {
        entry.privateKeyPath = h.privateKeyPath;
      }
      if (h.tabLabel) {
        entry.tabLabel = h.tabLabel;
      }
      if (h.connectionType === 'ftp') {
        entry.connectionType = 'ftp';
        if (h.secure) {
          entry.secure = true;
        }
        if (h.anonymous) {
          entry.anonymous = true;
        }
      }
      sanitized.push(entry);
    }

    const config = vscode.workspace.getConfiguration('sshLite');

    if (mode === 'replace') {
      await config.update('hosts', sanitized, vscode.ConfigurationTarget.Global);
      return { added: sanitized.length, updated: 0 };
    }

    // merge: upsert by host:port:username, preserve everything else.
    const merged = config.get<Array<Record<string, unknown>>>('hosts', []).slice();
    const keyOf = (h: { host: unknown; port?: unknown; username: unknown; connectionType?: unknown }): string =>
      `${h.host}:${effectiveHostPort({
        port: h.port as number | undefined,
        connectionType: h.connectionType as 'ssh' | 'ftp' | undefined,
      })}:${h.username}`;
    const indexByKey = new Map<string, number>();
    merged.forEach((h, i) => indexByKey.set(keyOf(h as any), i));

    let added = 0;
    let updated = 0;
    for (const entry of sanitized) {
      const k = keyOf(entry);
      const at = indexByKey.get(k);
      if (at !== undefined) {
        merged[at] = entry;
        updated++;
      } else {
        indexByKey.set(k, merged.length);
        merged.push(entry);
        added++;
      }
    }

    await config.update('hosts', merged, vscode.ConfigurationTarget.Global);
    return { added, updated };
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
      connectionType?: 'ssh' | 'ftp';
    }>>('hosts', []);

    const { host: hostAddr, port, username } = parseHostId(hostId);

    const filtered = savedHosts.filter(
      (h) => !(h.host === hostAddr && effectiveHostPort(h) === port && (h.username ?? '') === username)
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
      connectionType?: 'ssh' | 'ftp';
    }>>('hosts', []);

    const { host: hostAddr, port, username } = parseHostId(hostId);

    const host = savedHosts.find(
      (h) => h.host === hostAddr && effectiveHostPort(h) === port && (h.username ?? '') === username
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
      connectionType?: 'ssh' | 'ftp';
    }>>('hosts', []);

    const { host: hostAddr, port, username } = parseHostId(hostId);

    const host = savedHosts.find(
      (h) => h.host === hostAddr && effectiveHostPort(h) === port && (h.username ?? '') === username
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
    // Protocol is the first decision: it changes every later prompt (port,
    // auth, FTP options) and which connection class is built.
    const typePick = await vscode.window.showQuickPick(
      [
        { label: 'SSH / SFTP', description: 'Secure shell - full feature set', value: 'ssh' as const },
        { label: 'FTP / FTPS', description: 'File transfer only (browse, edit, upload/download)', value: 'ftp' as const },
      ],
      { title: 'Connection type', placeHolder: 'Choose how to connect', ignoreFocusOut: true }
    );
    if (!typePick) {
      return undefined;
    }
    const connectionType = typePick.value;
    const isFtp = connectionType === 'ftp';

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
      prompt: isFtp ? 'Enter FTP port' : 'Enter SSH port',
      value: isFtp ? '21' : '22',
      ignoreFocusOut: true,
      validateInput: validatePort,
    });

    if (!portStr) {
      return undefined;
    }

    const port = parseInt(portStr, 10);

    const ftp = isFtp ? await this.promptFtpOptions() : { secure: undefined, anonymous: undefined, username: undefined };
    if (isFtp && ftp === undefined) {
      return undefined;
    }

    let username = ftp?.username;
    let privateKeyPath: string | undefined;

    if (!isFtp) {
      username = await vscode.window.showInputBox({
        prompt: 'Enter username',
        value: os.userInfo().username,
        ignoreFocusOut: true,
      });
      if (!username) {
        return undefined;
      }
      // Cancelling the key picker keeps the legacy behaviour: no key → password
      // auth (it does NOT abort adding the host).
      privateKeyPath = (await pickPrivateKeyPath({
        title: 'Private key (optional — choose "No key" for password auth)',
        optional: true,
      })) || undefined;
    }

    if (!username) {
      return undefined;
    }

    const hostConfig: Omit<IHostConfig, 'id' | 'source'> = {
      name,
      host,
      port,
      username,
      privateKeyPath,
      connectionType,
      secure: isFtp ? ftp?.secure : undefined,
      anonymous: isFtp ? ftp?.anonymous : undefined,
    };

    await this.saveHost(hostConfig);

    return {
      ...hostConfig,
      id: `${host}:${port}:${username}`,
      source: 'saved',
    };
  }

  /**
   * Prompt for FTP-specific options (security + login). Returns undefined if the
   * user cancels. For anonymous login the username is forced to 'anonymous'.
   */
  private async promptFtpOptions(
    current?: { secure?: boolean; anonymous?: boolean; username?: string }
  ): Promise<{ secure: boolean; anonymous: boolean; username: string } | undefined> {
    const securePick = await vscode.window.showQuickPick(
      [
        { label: 'Plain FTP', description: 'Unencrypted — credentials sent in clear text', value: false },
        { label: 'FTPS (explicit TLS)', description: 'Encrypted control and data connection', value: true },
      ],
      {
        title: 'FTP security',
        placeHolder: current?.secure ? 'Currently: FTPS' : 'Use TLS?',
        ignoreFocusOut: true,
      }
    );
    if (!securePick) {
      return undefined;
    }

    const authPick = await vscode.window.showQuickPick(
      [
        { label: 'Username and password', value: 'user' as const },
        { label: 'Anonymous', description: 'Log in as "anonymous"', value: 'anon' as const },
      ],
      { title: 'FTP login', placeHolder: 'How to authenticate', ignoreFocusOut: true }
    );
    if (!authPick) {
      return undefined;
    }
    const anonymous = authPick.value === 'anon';

    let username = 'anonymous';
    if (!anonymous) {
      const entered = await vscode.window.showInputBox({
        prompt: 'Enter username',
        value: current?.username && current.username !== 'anonymous' ? current.username : os.userInfo().username,
        ignoreFocusOut: true,
      });
      if (!entered) {
        return undefined;
      }
      username = entered;
    }

    return { secure: securePick.value, anonymous, username };
  }

  /**
   * Prompt user to edit a host
   */
  async promptEditHost(hostConfig: IHostConfig): Promise<IHostConfig | undefined> {
    const currentType = hostConfig.connectionType ?? 'ssh';
    const typePick = await vscode.window.showQuickPick(
      [
        { label: 'SSH / SFTP', description: currentType === 'ssh' ? 'Current' : undefined, value: 'ssh' as const },
        { label: 'FTP / FTPS', description: currentType === 'ftp' ? 'Current' : undefined, value: 'ftp' as const },
      ],
      { title: 'Connection type', placeHolder: 'Choose how to connect', ignoreFocusOut: true }
    );
    if (!typePick) {
      return undefined;
    }
    const connectionType = typePick.value;
    const isFtp = connectionType === 'ftp';

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
      prompt: isFtp ? 'Enter FTP port' : 'Enter SSH port',
      value: hostConfig.port.toString(),
      ignoreFocusOut: true,
      validateInput: validatePort,
    });

    if (!portStr) {
      return undefined;
    }

    const port = parseInt(portStr, 10);

    let username: string | undefined;
    let privateKeyPath: string | undefined;
    let secure: boolean | undefined;
    let anonymous: boolean | undefined;

    if (isFtp) {
      const ftp = await this.promptFtpOptions({
        secure: hostConfig.secure,
        anonymous: hostConfig.anonymous,
        username: hostConfig.username,
      });
      if (!ftp) {
        return undefined;
      }
      username = ftp.username;
      secure = ftp.secure;
      anonymous = ftp.anonymous;
    } else {
      username = await vscode.window.showInputBox({
        prompt: 'Enter username',
        value: hostConfig.username,
        ignoreFocusOut: true,
      });
      if (!username) {
        return undefined;
      }
      // Edit flow: never silently drop the existing key. The picker offers
      // "Keep current key" as the first choice, and cancelling (undefined) also
      // keeps it; only the explicit "No key" choice ('') removes it.
      const pickedKey = await pickPrivateKeyPath({
        title: 'Private key (Keep / Browse / Type, or No key for password auth)',
        initialPath: hostConfig.privateKeyPath || '',
        current: hostConfig.privateKeyPath || undefined,
        optional: true,
      });
      privateKeyPath = pickedKey === undefined ? hostConfig.privateKeyPath : (pickedKey || undefined);
    }

    // Remove old host
    await this.removeHost(hostConfig.id);

    // Save new host
    const newConfig: Omit<IHostConfig, 'id' | 'source'> = {
      name,
      host,
      port,
      username,
      privateKeyPath,
      connectionType,
      secure: isFtp ? secure : undefined,
      anonymous: isFtp ? anonymous : undefined,
    };

    await this.saveHost(newConfig);

    return {
      ...newConfig,
      id: `${host}:${port}:${username}`,
      source: 'saved',
    };
  }
}
