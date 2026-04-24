import * as vscode from 'vscode';

export interface Snippet {
  id: string;
  name: string;
  command: string;
  builtin?: boolean;
}

const STORAGE_KEY = 'sshLite.snippets';

const BUILTIN_SNIPPETS: Snippet[] = [
  { id: 'builtin-disk-usage', name: 'Disk usage (df -h)', command: 'df -h', builtin: true },
  { id: 'builtin-top-cpu', name: 'Top 10 processes by CPU', command: 'ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -11', builtin: true },
  { id: 'builtin-top-mem', name: 'Top 10 processes by memory', command: 'ps -eo pid,user,%cpu,%mem,comm --sort=-%mem | head -11', builtin: true },
  { id: 'builtin-listening-ports', name: 'Listening ports (ss -tulnp)', command: 'ss -tulnp 2>/dev/null || netstat -tulnp', builtin: true },
  { id: 'builtin-kernel', name: 'Kernel / OS info', command: 'uname -a; cat /etc/os-release 2>/dev/null | head -5', builtin: true },
  { id: 'builtin-uptime', name: 'Uptime + load', command: 'uptime', builtin: true },
];

export class SnippetService {
  private static _instance: SnippetService;
  private context: vscode.ExtensionContext | null = null;
  private userSnippets: Snippet[] = [];

  private constructor() {}

  static getInstance(): SnippetService {
    if (!SnippetService._instance) {
      SnippetService._instance = new SnippetService();
    }
    return SnippetService._instance;
  }

  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    const stored = context.globalState.get<Snippet[]>(STORAGE_KEY, []);
    this.userSnippets = Array.isArray(stored) ? stored.filter((s) => !s.builtin) : [];
  }

  getAll(): Snippet[] {
    return [...BUILTIN_SNIPPETS, ...this.userSnippets];
  }

  getUserSnippets(): Snippet[] {
    return [...this.userSnippets];
  }

  findById(id: string): Snippet | undefined {
    return this.getAll().find((s) => s.id === id);
  }

  async add(name: string, command: string): Promise<Snippet> {
    const trimmedName = name.trim();
    const trimmedCmd = command.trim();
    if (!trimmedName || !trimmedCmd) {
      throw new Error('Snippet name and command are required');
    }
    const snippet: Snippet = {
      id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: trimmedName,
      command: trimmedCmd,
    };
    this.userSnippets.push(snippet);
    await this.persist();
    return snippet;
  }

  async rename(id: string, newName: string): Promise<boolean> {
    const snippet = this.userSnippets.find((s) => s.id === id);
    if (!snippet) { return false; }
    snippet.name = newName.trim();
    await this.persist();
    return true;
  }

  async update(id: string, newCommand: string): Promise<boolean> {
    const snippet = this.userSnippets.find((s) => s.id === id);
    if (!snippet) { return false; }
    snippet.command = newCommand.trim();
    await this.persist();
    return true;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.userSnippets.length;
    this.userSnippets = this.userSnippets.filter((s) => s.id !== id);
    if (this.userSnippets.length === before) { return false; }
    await this.persist();
    return true;
  }

  private async persist(): Promise<void> {
    if (!this.context) { return; }
    await this.context.globalState.update(STORAGE_KEY, this.userSnippets);
  }
}
