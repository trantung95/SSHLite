import * as vscode from 'vscode';
import { SSHConnection } from '../connection/SSHConnection';
import { ClientChannel } from 'ssh2';

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
   * Create a new SSH terminal for a connection.
   * Multiple terminals can be opened on the same connection without re-authentication.
   */
  async createTerminal(connection: SSHConnection): Promise<vscode.Terminal> {
    // Increment terminal counter for this connection
    const currentCount = this.terminalCounters.get(connection.id) || 0;
    const terminalNumber = currentCount + 1;
    this.terminalCounters.set(connection.id, terminalNumber);

    const terminalId = `${connection.id}-${terminalNumber}`;

    try {
      // Create a new shell channel on the existing SSH connection (no re-auth needed)
      const shell = await connection.shell();
      const terminalInfo = this.createPseudoTerminal(connection, shell, terminalId, terminalNumber);

      this.terminals.set(terminalId, terminalInfo);
      terminalInfo.terminal.show();

      return terminalInfo.terminal;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to create terminal: ${(error as Error).message}`);
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
          const str = typeof data === 'string' ? data : data.toString('utf-8');
          writeEmitter.fire(str);
        });

        // Handle shell close
        shell.on('close', () => {
          closeEmitter.fire();
          cleanup();
        });

        shell.on('error', (err: Error) => {
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
    for (const [terminalId, info] of this.terminals) {
      if (terminalId.startsWith(connectionId)) {
        info.terminal.dispose();
        info.writeEmitter.dispose();
        info.closeEmitter.dispose();
        this.terminals.delete(terminalId);
      }
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
  }
}
