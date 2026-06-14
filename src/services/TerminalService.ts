import * as vscode from 'vscode';
import { SSHConnection } from '../connection/SSHConnection';
import { assertCapability } from '../utils/capabilityGuard';
import { ClientChannel } from 'ssh2';
import { diagLog, infoLog } from '../utils/diagnosticLog';

/**
 * Terminal info for tracking resources
 */
interface TerminalInfo {
  terminal: vscode.Terminal;
  writeEmitter: vscode.EventEmitter<string>;
  closeEmitter: vscode.EventEmitter<number | void>;
}

/**
 * Service for creating SSH terminal sessions
 */
export class TerminalService {
  private static _instance: TerminalService;
  private terminals: Map<string, TerminalInfo> = new Map();
  private terminalCounters: Map<string, number> = new Map(); // connectionId -> counter

  /**
   * Fires on terminal activity so consumers (e.g. the Support view NPC) can react.
   * Carries only a coarse kind ('input' = user keystroke into the SSH terminal,
   * 'output' = data streamed back from the server) — never the keystroke/content
   * itself, so this leaks nothing about what the user typed.
   */
  private readonly _onActivity = new vscode.EventEmitter<'input' | 'output'>();
  public readonly onActivity: vscode.Event<'input' | 'output'> = this._onActivity.event;

  /**
   * Locale + color env vars forwarded to the remote shell, mirroring a native
   * `ssh` session's default `SendEnv LANG LC_*` (plus COLORTERM). Forwarding
   * these makes UTF-8 glyphs (powerline / nerd fonts, box-drawing) and colors
   * render the same as a terminal opened directly on the server. The remote
   * sshd must allow them via `AcceptEnv` (most distros allow `LANG LC_*`).
   */
  private static readonly FORWARDED_ENV_KEYS = [
    'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_NUMERIC', 'LC_TIME',
    'LC_COLLATE', 'LC_MONETARY', 'LC_MESSAGES', 'LC_PAPER', 'LC_NAME',
    'LC_ADDRESS', 'LC_TELEPHONE', 'LC_MEASUREMENT', 'LC_IDENTIFICATION',
    'COLORTERM',
  ];

  private constructor() {}

  /**
   * Get the singleton instance
   */
  static getInstance(): TerminalService {
    if (!TerminalService._instance) {
      TerminalService._instance = new TerminalService();
    }
    return TerminalService._instance;
  }

  /**
   * Terminal type ($TERM) advertised to the remote interactive shell.
   * Defaults to `xterm-256color` (vs ssh2's bare `vt100` default) so 256-color
   * TUI apps and shell plugins render correctly. Overridable via
   * `sshLite.terminal.termType` for old servers lacking that terminfo entry.
   */
  getTermType(): string {
    const cfg = vscode.workspace.getConfiguration('sshLite');
    return cfg.get<string>('terminal.termType', 'xterm-256color') || 'xterm-256color';
  }

  /**
   * Build the environment forwarded to a new SSH terminal: the client's locale
   * vars + COLORTERM (gated by `sshLite.terminal.forwardEnv`, default on),
   * overlaid with any user-defined `sshLite.terminal.env`. Only forwards values
   * that actually exist locally — never fabricates a locale (a missing one on
   * the remote would trigger `setlocale` warnings).
   */
  buildShellEnv(): Record<string, string> {
    const cfg = vscode.workspace.getConfiguration('sshLite');
    const env: Record<string, string> = {};

    if (cfg.get<boolean>('terminal.forwardEnv', true)) {
      for (const key of TerminalService.FORWARDED_ENV_KEYS) {
        const val = process.env[key];
        if (val !== undefined && val !== '') {
          env[key] = val;
        }
      }
    }

    const userEnv = cfg.get<Record<string, string>>('terminal.env', {}) ?? {};
    for (const [k, v] of Object.entries(userEnv)) {
      if (typeof v === 'string') {
        env[k] = v;
      }
    }

    return env;
  }

  /**
   * Create a new SSH terminal for a connection.
   * Multiple terminals can be opened on the same connection without re-authentication.
   */
  async createTerminal(connection: SSHConnection, preOpenedShell?: ClientChannel): Promise<vscode.Terminal> {
    // Backstop: FTP has no interactive shell.
    assertCapability(connection, 'supportsShell');
    // Increment terminal counter for this connection
    const currentCount = this.terminalCounters.get(connection.id) || 0;
    const terminalNumber = currentCount + 1;
    this.terminalCounters.set(connection.id, terminalNumber);

    const terminalId = `${connection.id}-${terminalNumber}`;
    const t0 = Date.now();
    infoLog('terminal', 'create/begin', {
      connectionId: connection.id,
      hostName: connection.host.name,
      terminalNumber,
      preOpened: !!preOpenedShell,
    });

    try {
      // Create a new shell channel on the existing SSH connection (no re-auth needed).
      // Request a native-parity PTY (TERM + forwarded locale/COLORTERM) so remote
      // TUI apps and shell plugins render like a terminal opened directly on the server.
      let shell: ClientChannel;
      if (preOpenedShell) {
        shell = preOpenedShell;
      } else {
        const term = this.getTermType();
        const env = this.buildShellEnv();
        infoLog('terminal', 'pty/open', { connectionId: connection.id, term, envKeys: Object.keys(env) });
        shell = await connection.shell({ term }, { env });
      }
      const terminalInfo = this.createPseudoTerminal(connection, shell, terminalId, terminalNumber);

      this.terminals.set(terminalId, terminalInfo);
      terminalInfo.terminal.show();

      infoLog('terminal', 'create/success', {
        connectionId: connection.id,
        terminalNumber,
        durationMs: Date.now() - t0,
      });
      return terminalInfo.terminal;
    } catch (error) {
      const e = error as Error;
      infoLog('terminal', 'create/failed', {
        connectionId: connection.id,
        terminalNumber,
        durationMs: Date.now() - t0,
        errorName: e.name,
        errorMessage: e.message,
      });
      vscode.window.showErrorMessage(`Failed to create terminal: ${e.message}`);
      throw error;
    }
  }

  /**
   * Get the number of active terminals for a connection
   */
  getTerminalCount(connectionId: string): number {
    let count = 0;
    for (const terminalId of this.terminals.keys()) {
      if (terminalId.startsWith(connectionId)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Create a VS Code terminal with a custom pseudoterminal
   */
  private createPseudoTerminal(
    connection: SSHConnection,
    shell: ClientChannel,
    terminalId: string,
    terminalNumber: number
  ): TerminalInfo {
    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number | void>();

    let dimensions = { rows: 24, columns: 80 };

    const cleanup = () => {
      const info = this.terminals.get(terminalId);
      if (info) {
        info.writeEmitter.dispose();
        info.closeEmitter.dispose();
        this.terminals.delete(terminalId);
      }
    };

    const pty: vscode.Pseudoterminal = {
      onDidWrite: writeEmitter.event,
      onDidClose: closeEmitter.event,

      open: (initialDimensions) => {
        if (initialDimensions) {
          dimensions = initialDimensions;
          // Set initial window size
          shell.setWindow(dimensions.rows, dimensions.columns, 0, 0);
        }

        // Handle data from remote
        shell.on('data', (data: Buffer | string) => {
          // Coarse activity signal only — never the data itself.
          this._onActivity.fire('output');
          const str = typeof data === 'string' ? data : data.toString('utf-8');
          writeEmitter.fire(str);
        });

        // Handle shell close
        shell.on('close', () => {
          diagLog('terminal', 'shell-close', { connectionId: connection.id, terminalId });
          closeEmitter.fire();
          cleanup();
        });

        shell.on('error', (err: Error) => {
          infoLog('terminal', 'shell-error', { connectionId: connection.id, terminalId, errorName: err.name, errorMessage: err.message });
          writeEmitter.fire(`\r\nConnection error: ${err.message}\r\n`);
          closeEmitter.fire();
          cleanup();
        });

        // Send welcome message
        writeEmitter.fire(`Connected to ${connection.host.name}\r\n`);
      },

      close: () => {
        shell.end();
        cleanup();
      },

      handleInput: (data: string) => {
        // Coarse activity signal only — never the keystroke content.
        this._onActivity.fire('input');
        // Send input to remote shell
        shell.write(data);
      },

      setDimensions: (newDimensions) => {
        dimensions = newDimensions;
        // Resize the remote terminal
        shell.setWindow(dimensions.rows, dimensions.columns, 0, 0);
      },
    };

    // Include terminal number in name for multiple terminals
    const terminalName = terminalNumber > 1
      ? `SSH: ${connection.host.name} (${terminalNumber})`
      : `SSH: ${connection.host.name}`;

    const terminal = vscode.window.createTerminal({
      name: terminalName,
      pty,
      iconPath: new vscode.ThemeIcon('terminal'),
    });

    return { terminal, writeEmitter, closeEmitter };
  }

  /**
   * Close all terminals for a connection
   */
  closeTerminalsForConnection(connectionId: string): void {
    let count = 0;
    for (const [terminalId, info] of this.terminals) {
      if (terminalId.startsWith(connectionId)) {
        info.terminal.dispose();
        info.writeEmitter.dispose();
        info.closeEmitter.dispose();
        this.terminals.delete(terminalId);
        count++;
      }
    }
    if (count > 0) {
      infoLog('terminal', 'close-for-connection', { connectionId, closed: count });
    }
  }

  /**
   * Close all terminals
   */
  closeAllTerminals(): void {
    for (const info of this.terminals.values()) {
      info.terminal.dispose();
      info.writeEmitter.dispose();
      info.closeEmitter.dispose();
    }
    this.terminals.clear();
  }

  /**
   * Dispose of resources
   */
  dispose(): void {
    this.closeAllTerminals();
    this._onActivity.dispose();
  }
}
