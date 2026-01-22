/**
 * VS Code API mock for unit testing
 */

// Event emitter mock
export class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];

  event = (listener: (e: T) => void) => {
    this.listeners.push(listener);
    return { dispose: () => this.listeners = this.listeners.filter(l => l !== listener) };
  };

  fire(data: T): void {
    this.listeners.forEach(l => l(data));
  }

  dispose(): void {
    this.listeners = [];
  }
}

// URI mock
export class Uri {
  static file(path: string): Uri {
    return new Uri('file', '', path, '', '');
  }

  static parse(value: string): Uri {
    return new Uri('file', '', value, '', '');
  }

  constructor(
    public readonly scheme: string,
    public readonly authority: string,
    public readonly path: string,
    public readonly query: string,
    public readonly fragment: string
  ) {}

  get fsPath(): string {
    return this.path;
  }

  toString(): string {
    return `${this.scheme}://${this.path}`;
  }

  with(change: { scheme?: string; authority?: string; path?: string; query?: string; fragment?: string }): Uri {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    );
  }
}

// Range mock
export class Range {
  constructor(
    public readonly start: Position,
    public readonly end: Position
  ) {}
}

// Position mock
export class Position {
  constructor(
    public readonly line: number,
    public readonly character: number
  ) {}
}

// TreeItem mock
export class TreeItem {
  label?: string | { label: string };
  description?: string;
  tooltip?: string;
  collapsibleState?: TreeItemCollapsibleState;
  contextValue?: string;
  iconPath?: string | Uri | { light: string | Uri; dark: string | Uri };
  command?: Command;
  resourceUri?: Uri;

  constructor(label: string | { label: string }, collapsibleState?: TreeItemCollapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

// TreeItemCollapsibleState enum
export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2
}

// Command interface
export interface Command {
  title: string;
  command: string;
  tooltip?: string;
  arguments?: unknown[];
}

// ThemeIcon mock
export class ThemeIcon {
  constructor(public readonly id: string, public readonly color?: ThemeColor) {}
}

// ThemeColor mock
export class ThemeColor {
  constructor(public readonly id: string) {}
}

// ConfigurationTarget enum
export enum ConfigurationTarget {
  Global = 1,
  Workspace = 2,
  WorkspaceFolder = 3
}

// StatusBarAlignment enum
export enum StatusBarAlignment {
  Left = 1,
  Right = 2
}

// ProgressLocation enum
export enum ProgressLocation {
  SourceControl = 1,
  Window = 10,
  Notification = 15
}

// ViewColumn enum
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
  Two = 2,
  Three = 3
}

// Disposable mock
export class Disposable {
  static from(...disposables: { dispose(): unknown }[]): Disposable {
    return new Disposable(() => disposables.forEach(d => d.dispose()));
  }

  constructor(private callOnDispose: () => void) {}

  dispose(): void {
    this.callOnDispose();
  }
}

// CancellationTokenSource mock
export class CancellationTokenSource {
  token = {
    isCancellationRequested: false,
    onCancellationRequested: new EventEmitter<void>().event,
  };

  cancel(): void {
    this.token.isCancellationRequested = true;
  }

  dispose(): void {}
}

// Workspace configuration mock
const configValues: Map<string, unknown> = new Map();

export const workspace = {
  getConfiguration: (section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      const fullKey = section ? `${section}.${key}` : key;
      const value = configValues.get(fullKey);
      return (value !== undefined ? value : defaultValue) as T | undefined;
    },
    update: jest.fn().mockResolvedValue(undefined),
    has: (key: string): boolean => {
      const fullKey = section ? `${section}.${key}` : key;
      return configValues.has(fullKey);
    },
    inspect: () => undefined,
  }),
  workspaceFolders: [],
  textDocuments: [],
  openTextDocument: jest.fn().mockResolvedValue({
    uri: Uri.file('/test'),
    getText: () => '',
    save: jest.fn().mockResolvedValue(true),
  }),
  onDidSaveTextDocument: new EventEmitter<unknown>().event,
  onDidChangeConfiguration: new EventEmitter<unknown>().event,
  fs: {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    delete: jest.fn(),
    stat: jest.fn(),
  },
};

// Window mock
export const window = {
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showWarningMessage: jest.fn().mockResolvedValue(undefined),
  showErrorMessage: jest.fn().mockResolvedValue(undefined),
  showInputBox: jest.fn().mockResolvedValue(undefined),
  showQuickPick: jest.fn().mockResolvedValue(undefined),
  showOpenDialog: jest.fn().mockResolvedValue(undefined),
  showSaveDialog: jest.fn().mockResolvedValue(undefined),
  createOutputChannel: jest.fn().mockReturnValue({
    appendLine: jest.fn(),
    append: jest.fn(),
    clear: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  }),
  createStatusBarItem: jest.fn().mockReturnValue({
    text: '',
    tooltip: '',
    command: undefined,
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  }),
  createTreeView: jest.fn().mockReturnValue({
    reveal: jest.fn(),
    dispose: jest.fn(),
    onDidExpandElement: new EventEmitter<unknown>().event,
    onDidCollapseElement: new EventEmitter<unknown>().event,
    onDidChangeSelection: new EventEmitter<unknown>().event,
    onDidChangeVisibility: new EventEmitter<unknown>().event,
  }),
  showTextDocument: jest.fn().mockResolvedValue(undefined),
  activeTextEditor: undefined,
  visibleTextEditors: [],
  onDidChangeActiveTextEditor: new EventEmitter<unknown>().event,
  setStatusBarMessage: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  withProgress: jest.fn().mockImplementation(async (options, task) => {
    const progress = { report: jest.fn() };
    const token = { isCancellationRequested: false, onCancellationRequested: new EventEmitter<void>().event };
    return task(progress, token);
  }),
  createWebviewPanel: jest.fn().mockReturnValue({
    webview: {
      html: '',
      onDidReceiveMessage: new EventEmitter<unknown>().event,
      postMessage: jest.fn().mockResolvedValue(true),
      asWebviewUri: (uri: Uri) => uri,
    },
    onDidDispose: new EventEmitter<void>().event,
    reveal: jest.fn(),
    dispose: jest.fn(),
  }),
  registerWebviewViewProvider: jest.fn(),
};

// Commands mock
export const commands = {
  registerCommand: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  executeCommand: jest.fn().mockResolvedValue(undefined),
  getCommands: jest.fn().mockResolvedValue([]),
};

// Extensions mock
export const extensions = {
  getExtension: jest.fn(),
  all: [],
};

// Environment mock
export const env = {
  clipboard: {
    readText: jest.fn().mockResolvedValue(''),
    writeText: jest.fn().mockResolvedValue(undefined),
  },
  openExternal: jest.fn().mockResolvedValue(true),
  uriScheme: 'vscode',
  language: 'en',
  appName: 'Visual Studio Code',
  appRoot: '/app',
  machineId: 'test-machine-id',
  sessionId: 'test-session-id',
};

// SecretStorage mock
export class SecretStorage {
  private secrets: Map<string, string> = new Map();

  get(key: string): Promise<string | undefined> {
    return Promise.resolve(this.secrets.get(key));
  }

  store(key: string, value: string): Promise<void> {
    this.secrets.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.secrets.delete(key);
    return Promise.resolve();
  }

  onDidChange = new EventEmitter<{ key: string }>().event;
}

// ExtensionContext mock
export function createMockExtensionContext(): {
  subscriptions: { dispose(): void }[];
  workspaceState: { get: jest.Mock; update: jest.Mock; keys: jest.Mock };
  globalState: { get: jest.Mock; update: jest.Mock; keys: jest.Mock; setKeysForSync: jest.Mock };
  secrets: SecretStorage;
  extensionUri: Uri;
  extensionPath: string;
  storagePath: string;
  globalStoragePath: string;
  logPath: string;
  asAbsolutePath: (relativePath: string) => string;
} {
  return {
    subscriptions: [],
    workspaceState: {
      get: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockReturnValue([]),
    },
    globalState: {
      get: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
      keys: jest.fn().mockReturnValue([]),
      setKeysForSync: jest.fn(),
    },
    secrets: new SecretStorage(),
    extensionUri: Uri.file('/extension'),
    extensionPath: '/extension',
    storagePath: '/storage',
    globalStoragePath: '/globalStorage',
    logPath: '/logs',
    asAbsolutePath: (relativePath: string) => `/extension/${relativePath}`,
  };
}

// Helper to set config values for testing
export function setMockConfig(key: string, value: unknown): void {
  configValues.set(key, value);
}

// Helper to clear all mock config values
export function clearMockConfig(): void {
  configValues.clear();
}

// Reset all mocks
export function resetAllMocks(): void {
  jest.clearAllMocks();
  configValues.clear();
}
