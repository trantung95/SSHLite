import * as vscode from 'vscode';

export interface ClipboardEntry {
  connectionId: string;
  remotePath: string;
  isDirectory: boolean;
  name: string;
}

export type ClipboardOperation = 'copy' | 'cut';

export interface ClipboardState {
  items: ClipboardEntry[];
  operation: ClipboardOperation;
  timestamp: number;
}

const CONTEXT_KEY = 'sshLite.hasClipboard';

export class RemoteClipboardService {
  private static _instance: RemoteClipboardService;
  private state: ClipboardState | null = null;
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange: vscode.Event<void> = this._onDidChange.event;

  private constructor() {}

  static getInstance(): RemoteClipboardService {
    if (!RemoteClipboardService._instance) {
      RemoteClipboardService._instance = new RemoteClipboardService();
    }
    return RemoteClipboardService._instance;
  }

  setClipboard(items: ClipboardEntry[], operation: ClipboardOperation): void {
    if (items.length === 0) {
      this.clear();
      return;
    }
    this.state = { items, operation, timestamp: Date.now() };
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, true);
    this._onDidChange.fire();
  }

  getClipboard(): ClipboardState | null {
    return this.state;
  }

  hasClipboard(): boolean {
    return this.state !== null && this.state.items.length > 0;
  }

  clear(): void {
    if (this.state === null) {
      return;
    }
    this.state = null;
    void vscode.commands.executeCommand('setContext', CONTEXT_KEY, false);
    this._onDidChange.fire();
  }

  dispose(): void {
    this._onDidChange.dispose();
  }
}
