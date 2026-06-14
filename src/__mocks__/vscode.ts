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
    // Parse scheme://authority/path?query#fragment
    const match = value.match(/^([a-zA-Z][a-zA-Z0-9+\-.]*):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/);
    if (match) {
      return new Uri(match[1], match[2], match[3] || '/', match[4] || '', match[5] || '');
    }
    return new Uri('file', '', value, '', '');
  }

  static joinPath(base: Uri, ...segments: string[]): Uri {
    // Join with forward slashes; collapse duplicate separators. Matches
    // VS Code's behaviour for non-file schemes; for file: it preserves the
    // drive letter on Windows-style paths.
    const joined = segments.reduce<string>(
      (acc, seg) => (acc.endsWith('/') ? `${acc}${seg}` : `${acc}/${seg}`),
      base.path,
    );
    return base.with({ path: joined.replace(/\/+/g, '/') });
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
    const auth = this.authority ? `//${this.authority}` : '';
    const q = this.query ? `?${this.query}` : '';
    const f = this.fragment ? `#${this.fragment}` : '';
    return `${this.scheme}:${auth}${this.path}${q}${f}`;
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

// RelativePattern mock
export class RelativePattern {
  public readonly baseUri: Uri;
  constructor(public readonly base: Uri | string, public readonly pattern: string) {
    this.baseUri = typeof base === 'string' ? Uri.file(base) : base;
  }
}

// FileSystemWatcher mock factory. Tests can drive events via _fireCreate/_fireChange/_fireDelete.
export function createMockFileSystemWatcher(): {
  onDidChange: (listener: (e: Uri) => void) => { dispose: () => void };
  onDidCreate: (listener: (e: Uri) => void) => { dispose: () => void };
  onDidDelete: (listener: (e: Uri) => void) => { dispose: () => void };
  dispose: jest.Mock;
  ignoreChangeEvents: boolean;
  ignoreCreateEvents: boolean;
  ignoreDeleteEvents: boolean;
  _fireChange: (u?: Uri) => void;
  _fireCreate: (u?: Uri) => void;
  _fireDelete: (u?: Uri) => void;
} {
  const change = new EventEmitter<Uri>();
  const create = new EventEmitter<Uri>();
  const del = new EventEmitter<Uri>();
  return {
    onDidChange: change.event,
    onDidCreate: create.event,
    onDidDelete: del.event,
    dispose: jest.fn(),
    ignoreChangeEvents: false,
    ignoreCreateEvents: false,
    ignoreDeleteEvents: false,
    _fireChange: (u?: Uri) => change.fire((u ?? Uri.file('/mock')) as Uri),
    _fireCreate: (u?: Uri) => create.fire((u ?? Uri.file('/mock')) as Uri),
    _fireDelete: (u?: Uri) => del.fire((u ?? Uri.file('/mock')) as Uri),
  };
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

// WorkspaceEdit mock (enough for FileService.openRemoteFile content replacement)
export class WorkspaceEdit {
  public edits: Array<{ uri: unknown; range: unknown; text: string }> = [];
  replace(uri: unknown, range: unknown, text: string): void {
    this.edits.push({ uri, range, text });
  }
  insert(uri: unknown, position: unknown, text: string): void {
    this.edits.push({ uri, range: position, text });
  }
  delete(): void { /* no-op */ }
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

// MarkdownString mock
export class MarkdownString {
  value: string;
  isTrusted?: boolean;
  supportThemeIcons?: boolean;
  supportHtml?: boolean;

  constructor(value?: string, supportThemeIcons?: boolean) {
    this.value = value || '';
    this.supportThemeIcons = supportThemeIcons;
  }

  appendText(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendMarkdown(value: string): MarkdownString {
    this.value += value;
    return this;
  }

  appendCodeblock(value: string, language?: string): MarkdownString {
    this.value += `\`\`\`${language || ''}\n${value}\n\`\`\``;
    return this;
  }
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

export enum ExtensionKind {
  UI = 1,
  Workspace = 2
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
  applyEdit: jest.fn().mockResolvedValue(true),
  onDidSaveTextDocument: new EventEmitter<unknown>().event,
  onDidChangeTextDocument: new EventEmitter<unknown>().event,
  onDidCloseTextDocument: new EventEmitter<unknown>().event,
  onDidChangeConfiguration: new EventEmitter<unknown>().event,
  registerTextDocumentContentProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  registerFileSystemProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  createFileSystemWatcher: jest.fn().mockImplementation(() => createMockFileSystemWatcher()),
  fs: {
    readFile: jest.fn(),
    writeFile: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn(),
    stat: jest.fn(),
    createDirectory: jest.fn().mockResolvedValue(undefined),
    readDirectory: jest.fn().mockResolvedValue([]),
  },
};

// Window mock
export const window = {
  showInformationMessage: jest.fn().mockResolvedValue(undefined),
  showWarningMessage: jest.fn().mockResolvedValue(undefined),
  showErrorMessage: jest.fn().mockResolvedValue(undefined),
  showInputBox: jest.fn().mockResolvedValue(undefined),
  showQuickPick: jest.fn().mockResolvedValue(undefined),
  createQuickPick: jest.fn(() => createMockQuickPick()),
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
    name: '',
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
  }),
  registerFileDecorationProvider: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  createTerminal: jest.fn().mockReturnValue({
    name: 'mock-terminal',
    show: jest.fn(),
    hide: jest.fn(),
    sendText: jest.fn(),
    dispose: jest.fn(),
    processId: Promise.resolve(1234),
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
  visibleTextEditors: [] as Array<{ document: { uri: { fsPath: string } } }>,
  onDidChangeActiveTextEditor: new EventEmitter<unknown>().event,
  onDidChangeTextEditorSelection: new EventEmitter<unknown>().event,
  onDidChangeVisibleTextEditors: (_listener: (e: unknown) => void) => ({ dispose: jest.fn() }),
  setStatusBarMessage: jest.fn().mockReturnValue({ dispose: jest.fn() }),
  withProgress: jest.fn().mockImplementation(async (options, task) => {
    const progress = { report: jest.fn() };
    const token = { isCancellationRequested: false, onCancellationRequested: new EventEmitter<void>().event };
    return task(progress, token);
  }),
  createWebviewPanel: jest.fn(() => createMockWebviewPanel()),
  registerWebviewViewProvider: jest.fn(),
  tabGroups: {
    all: [],
    activeTabGroup: { tabs: [] },
    onDidChangeTabs: new EventEmitter<unknown>().event,
    onDidChangeTabGroups: new EventEmitter<unknown>().event,
    close: jest.fn(),
  },
};

/**
 * Reset window mock once-queues between tests.
 * Call this in a global beforeEach in command handler test files.
 */
export function resetWindowMocks(): void {
  (window.showQuickPick as jest.Mock).mockReset().mockResolvedValue(undefined);
  (window.showInputBox as jest.Mock).mockReset().mockResolvedValue(undefined);
  (window.showWarningMessage as jest.Mock).mockReset().mockResolvedValue(undefined);
  (window.showInformationMessage as jest.Mock).mockReset().mockResolvedValue(undefined);
  (window.showErrorMessage as jest.Mock).mockReset().mockResolvedValue(undefined);
  (window.showOpenDialog as jest.Mock).mockReset().mockResolvedValue(undefined);
  (window.showTextDocument as jest.Mock).mockReset().mockResolvedValue({ document: { getText: () => '', uri: { scheme: 'file', authority: '' } } });
  (workspace.openTextDocument as jest.Mock).mockReset().mockResolvedValue({ uri: Uri.file('/test'), getText: () => '', save: jest.fn() });
}

// Commands mock — real registry so executeCommand actually invokes registered handlers
const _commandRegistry = new Map<string, (...args: any[]) => any>();
export const commands = {
  registerCommand: jest.fn().mockImplementation((id: string, handler: (...args: any[]) => any) => {
    _commandRegistry.set(id, handler);
    return {
      dispose: jest.fn().mockImplementation(() => { _commandRegistry.delete(id); }),
    };
  }),
  executeCommand: jest.fn().mockImplementation(async (id: string, ...args: any[]) => {
    const handler = _commandRegistry.get(id);
    if (handler) { return handler(...args); }
    return undefined;
  }),
  getCommands: jest.fn().mockResolvedValue([]),
  // expose for test cleanup
  _clearRegistry: () => _commandRegistry.clear(),
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
  remoteName: undefined as string | undefined,
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
  globalStorageUri: Uri;
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
    globalStorageUri: Uri.file('/globalStorage/hybr8.ssh-lite'),
    logPath: '/logs',
    asAbsolutePath: (relativePath: string) => `/extension/${relativePath}`,
  };
}

// WebviewView mock factory (for WebviewViewProvider tests, e.g. SupportViewProvider).
// Use _fireMessage(msg) to simulate a message posted from the webview.
export function createMockWebviewView(): {
  webview: {
    html: string;
    options: unknown;
    cspSource: string;
    asWebviewUri: (uri: Uri) => Uri;
    onDidReceiveMessage: (listener: (e: unknown) => void) => { dispose: () => void };
    postMessage: jest.Mock;
  };
  visible: boolean;
  onDidChangeVisibility: (listener: () => void) => { dispose: () => void };
  onDidDispose: (listener: () => void) => { dispose: () => void };
  _fireMessage: (msg: unknown) => void;
} {
  const messageEmitter = new EventEmitter<unknown>();
  return {
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri: Uri) => uri,
      onDidReceiveMessage: messageEmitter.event,
      postMessage: jest.fn().mockResolvedValue(true),
    },
    visible: true,
    onDidChangeVisibility: new EventEmitter<void>().event,
    onDidDispose: new EventEmitter<void>().event,
    _fireMessage: (msg: unknown) => messageEmitter.fire(msg),
  };
}

// QuickPick mock factory (for window.createQuickPick — multi-select pickers).
// Drive interactions in tests via _accept(), _hide(), _triggerButton(btn).
export function createMockQuickPick<T = any>(): any {
  const accept = new EventEmitter<void>();
  const hide = new EventEmitter<void>();
  const button = new EventEmitter<unknown>();
  const selection = new EventEmitter<T[]>();
  return {
    items: [] as T[],
    selectedItems: [] as T[],
    activeItems: [] as T[],
    canSelectMany: false,
    title: undefined as string | undefined,
    placeholder: undefined as string | undefined,
    value: '',
    busy: false,
    ignoreFocusOut: false,
    buttons: [] as unknown[],
    onDidAccept: accept.event,
    onDidHide: hide.event,
    onDidTriggerButton: button.event,
    onDidChangeSelection: selection.event,
    onDidChangeActive: new EventEmitter<T[]>().event,
    onDidChangeValue: new EventEmitter<string>().event,
    onDidTriggerItemButton: new EventEmitter<unknown>().event,
    show: jest.fn(),
    hide: jest.fn(function (this: { _hadAccept?: boolean }) { hide.fire(); }),
    dispose: jest.fn(),
    // Test drivers:
    _accept: () => accept.fire(),
    _hide: () => hide.fire(),
    _triggerButton: (b: unknown) => button.fire(b),
  };
}

// WebviewPanel mock factory (for window.createWebviewPanel). Drive the
// webview->extension message channel with _fireMessage(msg) and simulate the
// user closing the tab with _fireDispose().
export function createMockWebviewPanel(): any {
  const messageEmitter = new EventEmitter<unknown>();
  const disposeEmitter = new EventEmitter<void>();
  return {
    viewType: 'mock',
    title: 'mock',
    visible: true,
    webview: {
      html: '',
      options: {},
      cspSource: 'vscode-webview://test',
      asWebviewUri: (uri: Uri) => uri,
      onDidReceiveMessage: messageEmitter.event,
      postMessage: jest.fn().mockResolvedValue(true),
    },
    onDidDispose: disposeEmitter.event,
    onDidChangeViewState: new EventEmitter<unknown>().event,
    reveal: jest.fn(),
    dispose: jest.fn(() => disposeEmitter.fire()),
    _fireMessage: (msg: unknown) => messageEmitter.fire(msg),
    _fireDispose: () => disposeEmitter.fire(),
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
