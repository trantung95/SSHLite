import * as vscode from 'vscode';
import {
  AiActivityWatchService,
  AiToolDescriptor,
  AiWatchCtx,
  DEFAULT_AI_TOOLS,
} from './AiActivityWatchService';

interface FakeWatcher {
  pattern: vscode.RelativePattern;
  watcher: vscode.FileSystemWatcher;
  fireChange: () => void;
  fireCreate: () => void;
  dispose: jest.Mock;
}

function makeWatcherFactory(): { create: jest.Mock; created: FakeWatcher[] } {
  const created: FakeWatcher[] = [];
  const create = jest.fn((pattern: vscode.RelativePattern) => {
    const change: Array<() => void> = [];
    const createL: Array<() => void> = [];
    const dispose = jest.fn();
    const watcher = {
      onDidChange: (l: () => void) => {
        change.push(l);
        return { dispose: jest.fn() };
      },
      onDidCreate: (l: () => void) => {
        createL.push(l);
        return { dispose: jest.fn() };
      },
      onDidDelete: () => ({ dispose: jest.fn() }),
      dispose,
    } as unknown as vscode.FileSystemWatcher;
    created.push({
      pattern,
      watcher,
      fireChange: () => change.forEach((l) => l()),
      fireCreate: () => createL.forEach((l) => l()),
      dispose,
    });
    return watcher;
  });
  return { create, created };
}

const CTX: AiWatchCtx = {
  home: '/home/me',
  workspaceFolders: [],
  globalStorageParent: vscode.Uri.file('/home/me/.vscode/User/globalStorage'),
};

const TOOLS: AiToolDescriptor[] = [
  { id: 'alpha', name: 'Alpha', roots: () => [{ base: vscode.Uri.file('/home/me/.alpha'), glob: '**/*.jsonl' }] },
  { id: 'beta', name: 'Beta', roots: () => [{ base: vscode.Uri.file('/home/me/.beta'), glob: '*.json' }] },
];

describe('AiActivityWatchService', () => {
  it('creates no watcher while disabled', () => {
    const wf = makeWatcherFactory();
    const svc = new AiActivityWatchService(CTX, jest.fn(), {
      tools: TOOLS,
      fsExists: () => true,
      createWatcher: wf.create,
    });
    svc.setVisible(true);
    expect(wf.create).not.toHaveBeenCalled();
  });

  it('creates no watcher while not visible', () => {
    const wf = makeWatcherFactory();
    const svc = new AiActivityWatchService(CTX, jest.fn(), {
      tools: TOOLS,
      fsExists: () => true,
      createWatcher: wf.create,
    });
    svc.setEnabled(true);
    expect(wf.create).not.toHaveBeenCalled();
  });

  it('only watches tools whose base directory exists', () => {
    const wf = makeWatcherFactory();
    const fsExists = jest.fn((p: string) => p === '/home/me/.alpha');
    const svc = new AiActivityWatchService(CTX, jest.fn(), { tools: TOOLS, fsExists, createWatcher: wf.create });
    svc.setEnabled(true);
    svc.setVisible(true);
    expect(wf.create).toHaveBeenCalledTimes(1);
    expect(wf.created[0].pattern.pattern).toBe('**/*.jsonl');
    expect(wf.created[0].pattern.baseUri.fsPath).toBe('/home/me/.alpha');
  });

  it('fires onToolActive(id, name) on a change event', () => {
    const wf = makeWatcherFactory();
    const onActive = jest.fn();
    const svc = new AiActivityWatchService(CTX, onActive, {
      tools: TOOLS,
      fsExists: () => true,
      createWatcher: wf.create,
    });
    svc.setEnabled(true);
    svc.setVisible(true);

    wf.created[0].fireChange();
    expect(onActive).toHaveBeenCalledWith('alpha', 'Alpha');

    wf.created[1].fireCreate();
    expect(onActive).toHaveBeenCalledWith('beta', 'Beta');
  });

  it('respects the tool filter', () => {
    const wf = makeWatcherFactory();
    const svc = new AiActivityWatchService(CTX, jest.fn(), {
      tools: TOOLS,
      fsExists: () => true,
      createWatcher: wf.create,
    });
    svc.setToolFilter(['beta']);
    svc.setEnabled(true);
    svc.setVisible(true);
    expect(wf.create).toHaveBeenCalledTimes(1);
    expect(wf.created[0].pattern.baseUri.fsPath).toBe('/home/me/.beta');
  });

  it('disposes all watchers when hidden', () => {
    const wf = makeWatcherFactory();
    const svc = new AiActivityWatchService(CTX, jest.fn(), {
      tools: TOOLS,
      fsExists: () => true,
      createWatcher: wf.create,
    });
    svc.setEnabled(true);
    svc.setVisible(true);
    expect(wf.created).toHaveLength(2);

    svc.setVisible(false);
    wf.created.forEach((w) => expect(w.dispose).toHaveBeenCalled());
  });

  it('rebuilds watchers when the filter changes while watching', () => {
    const wf = makeWatcherFactory();
    const svc = new AiActivityWatchService(CTX, jest.fn(), {
      tools: TOOLS,
      fsExists: () => true,
      createWatcher: wf.create,
    });
    svc.setEnabled(true);
    svc.setVisible(true);
    expect(wf.create).toHaveBeenCalledTimes(2);

    svc.setToolFilter(['alpha']);
    // old 2 disposed, 1 new created
    expect(wf.created[0].dispose).toHaveBeenCalled();
    expect(wf.create).toHaveBeenCalledTimes(3);
  });

  it('dispose() tears down watchers', () => {
    const wf = makeWatcherFactory();
    const svc = new AiActivityWatchService(CTX, jest.fn(), {
      tools: TOOLS,
      fsExists: () => true,
      createWatcher: wf.create,
    });
    svc.setEnabled(true);
    svc.setVisible(true);
    svc.dispose();
    wf.created.forEach((w) => expect(w.dispose).toHaveBeenCalled());
  });

  it('ships a registry covering the popular assistants', () => {
    const ids = DEFAULT_AI_TOOLS.map((t) => t.id);
    expect(ids).toEqual(
      expect.arrayContaining(['claude-code', 'codex', 'gemini', 'github-copilot', 'cursor', 'aider', 'cline'])
    );
    // every tool has a non-empty display name
    DEFAULT_AI_TOOLS.forEach((t) => expect(t.name.length).toBeGreaterThan(0));
  });
});
