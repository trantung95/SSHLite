import * as vscode from 'vscode';
import { BeaconService, BeaconFsApi } from './BeaconService';

/** Wait for queued microtasks (onChange awaits readFile). */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const BEACON_URI = vscode.Uri.file('/globalStorage/hybr8.ssh-lite/npc-beacon.json');

function makeFs(initialJson?: string): BeaconFsApi & {
  _store: Map<string, Buffer>;
  readFile: jest.Mock;
  writeFile: jest.Mock;
  delete: jest.Mock;
  createDirectory: jest.Mock;
} {
  const store = new Map<string, Buffer>();
  const api = {
    _store: store,
    readFile: jest.fn(async (uri: vscode.Uri) => {
      const b = store.get(uri.toString());
      if (!b) {
        throw new Error('ENOENT');
      }
      return new Uint8Array(b);
    }),
    writeFile: jest.fn(async (uri: vscode.Uri, content: Uint8Array) => {
      store.set(uri.toString(), Buffer.from(content));
    }),
    delete: jest.fn(async (uri: vscode.Uri) => {
      store.delete(uri.toString());
    }),
    createDirectory: jest.fn(async () => {}),
  };
  if (initialJson !== undefined) {
    store.set(BEACON_URI.toString(), Buffer.from(initialJson));
  }
  return api as BeaconFsApi & {
    _store: Map<string, Buffer>;
    readFile: jest.Mock;
    writeFile: jest.Mock;
    delete: jest.Mock;
    createDirectory: jest.Mock;
  };
}

function makeWatcher(): {
  watcher: vscode.FileSystemWatcher;
  fireChange: () => void;
  fireCreate: () => void;
  dispose: jest.Mock;
} {
  const change: Array<() => void> = [];
  const create: Array<() => void> = [];
  const dispose = jest.fn();
  const watcher = {
    onDidChange: (l: () => void) => {
      change.push(l);
      return { dispose: jest.fn() };
    },
    onDidCreate: (l: () => void) => {
      create.push(l);
      return { dispose: jest.fn() };
    },
    onDidDelete: () => ({ dispose: jest.fn() }),
    dispose,
    ignoreChangeEvents: false,
    ignoreCreateEvents: false,
    ignoreDeleteEvents: false,
  } as unknown as vscode.FileSystemWatcher;
  return {
    watcher,
    fireChange: () => change.forEach((l) => l()),
    fireCreate: () => create.forEach((l) => l()),
    dispose,
  };
}

describe('BeaconService', () => {
  let nowMs: number;

  beforeEach(() => {
    nowMs = 100000;
    jest.spyOn(Date, 'now').mockImplementation(() => nowMs);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('does not write while disabled', async () => {
    const fs = makeFs();
    const svc = new BeaconService(BEACON_URI, jest.fn(), fs, 'inst-A', () => makeWatcher().watcher);
    await svc.writeActivity('editor');
    expect(fs.writeFile).not.toHaveBeenCalled();
  });

  it('debounces writes to at most one per 250ms', async () => {
    const fs = makeFs();
    const svc = new BeaconService(BEACON_URI, jest.fn(), fs, 'inst-A', () => makeWatcher().watcher);
    svc.setEnabled(true);

    await svc.writeActivity('editor');
    nowMs += 100;
    await svc.writeActivity('editor'); // within 250ms → suppressed
    expect(fs.writeFile).toHaveBeenCalledTimes(1);

    nowMs += 200; // total 300ms since first
    await svc.writeActivity('editor');
    expect(fs.writeFile).toHaveBeenCalledTimes(2);
  });

  it('writes only {v,ts,kind,from} — no extra keys (privacy guard)', async () => {
    const fs = makeFs();
    const svc = new BeaconService(BEACON_URI, jest.fn(), fs, 'inst-A', () => makeWatcher().watcher);
    svc.setEnabled(true);
    await svc.writeActivity('terminal');

    const written = JSON.parse(fs._store.get(BEACON_URI.toString())!.toString());
    expect(Object.keys(written).sort()).toEqual(['from', 'kind', 'ts', 'v']);
    expect(written).toMatchObject({ v: 1, kind: 'terminal', from: 'inst-A', ts: nowMs });
  });

  it('ensures the storage directory once before the first write', async () => {
    const fs = makeFs();
    const svc = new BeaconService(BEACON_URI, jest.fn(), fs, 'inst-A', () => makeWatcher().watcher);
    svc.setEnabled(true);
    await svc.writeActivity('editor');
    nowMs += 300;
    await svc.writeActivity('editor');
    expect(fs.createDirectory).toHaveBeenCalledTimes(1);
  });

  it('suppresses our own beacon writes (no self-echo)', async () => {
    const fs = makeFs(JSON.stringify({ v: 1, ts: nowMs, kind: 'editor', from: 'inst-A' }));
    const onRemote = jest.fn();
    const w = makeWatcher();
    const svc = new BeaconService(BEACON_URI, onRemote, fs, 'inst-A', () => w.watcher);
    svc.setEnabled(true);
    svc.setVisible(true);

    w.fireChange();
    await flush();
    expect(onRemote).not.toHaveBeenCalled();
  });

  it('fires onRemoteActivity for a fresh beacon from another window', async () => {
    const fs = makeFs(JSON.stringify({ v: 1, ts: nowMs, kind: 'terminal', from: 'inst-B' }));
    const onRemote = jest.fn();
    const w = makeWatcher();
    const svc = new BeaconService(BEACON_URI, onRemote, fs, 'inst-A', () => w.watcher);
    svc.setEnabled(true);
    svc.setVisible(true);

    w.fireChange();
    await flush();
    expect(onRemote).toHaveBeenCalledTimes(1);
    expect(onRemote).toHaveBeenCalledWith('terminal');
  });

  it('reacts to create events too', async () => {
    const fs = makeFs(JSON.stringify({ v: 1, ts: nowMs, kind: 'editor', from: 'inst-B' }));
    const onRemote = jest.fn();
    const w = makeWatcher();
    const svc = new BeaconService(BEACON_URI, onRemote, fs, 'inst-A', () => w.watcher);
    svc.setEnabled(true);
    svc.setVisible(true);

    w.fireCreate();
    await flush();
    expect(onRemote).toHaveBeenCalledWith('editor');
  });

  it('ignores malformed JSON', async () => {
    const fs = makeFs('{ not valid json');
    const onRemote = jest.fn();
    const w = makeWatcher();
    const svc = new BeaconService(BEACON_URI, onRemote, fs, 'inst-A', () => w.watcher);
    svc.setEnabled(true);
    svc.setVisible(true);

    w.fireChange();
    await flush();
    expect(onRemote).not.toHaveBeenCalled();
  });

  it('ignores beacons with a bad shape', async () => {
    const fs = makeFs(JSON.stringify({ v: 2, kind: 'evil' }));
    const onRemote = jest.fn();
    const w = makeWatcher();
    const svc = new BeaconService(BEACON_URI, onRemote, fs, 'inst-A', () => w.watcher);
    svc.setEnabled(true);
    svc.setVisible(true);

    w.fireChange();
    await flush();
    expect(onRemote).not.toHaveBeenCalled();
  });

  it('ignores stale beacons (older than 10s)', async () => {
    const fs = makeFs(JSON.stringify({ v: 1, ts: nowMs - 20000, kind: 'editor', from: 'inst-B' }));
    const onRemote = jest.fn();
    const w = makeWatcher();
    const svc = new BeaconService(BEACON_URI, onRemote, fs, 'inst-A', () => w.watcher);
    svc.setEnabled(true);
    svc.setVisible(true);

    w.fireChange();
    await flush();
    expect(onRemote).not.toHaveBeenCalled();
  });

  it('creates the watcher only when enabled AND visible', () => {
    const fs = makeFs();
    const createWatcher = jest.fn(() => makeWatcher().watcher);
    const svc = new BeaconService(BEACON_URI, jest.fn(), fs, 'inst-A', createWatcher);

    svc.setEnabled(true);
    expect(createWatcher).not.toHaveBeenCalled(); // not visible yet
    svc.setVisible(true);
    expect(createWatcher).toHaveBeenCalledTimes(1);

    // idempotent
    svc.setVisible(true);
    svc.setEnabled(true);
    expect(createWatcher).toHaveBeenCalledTimes(1);
  });

  it('disposes the watcher when hidden and recreates when visible again', () => {
    const fs = makeFs();
    const w1 = makeWatcher();
    const w2 = makeWatcher();
    const watchers = [w1, w2];
    const createWatcher = jest.fn(() => watchers.shift()!.watcher);
    const svc = new BeaconService(BEACON_URI, jest.fn(), fs, 'inst-A', createWatcher);

    svc.setEnabled(true);
    svc.setVisible(true);
    expect(createWatcher).toHaveBeenCalledTimes(1);

    svc.setVisible(false);
    expect(w1.dispose).toHaveBeenCalled();

    svc.setVisible(true);
    expect(createWatcher).toHaveBeenCalledTimes(2);
  });

  it('dispose() tears down the watcher and deletes the beacon file', () => {
    const fs = makeFs();
    const w = makeWatcher();
    const svc = new BeaconService(BEACON_URI, jest.fn(), fs, 'inst-A', () => w.watcher);
    svc.setEnabled(true);
    svc.setVisible(true);

    svc.dispose();
    expect(w.dispose).toHaveBeenCalled();
    expect(fs.delete).toHaveBeenCalledWith(BEACON_URI);
  });

  it('makeInstanceId produces unique-ish ids', () => {
    const a = BeaconService.makeInstanceId();
    const b = BeaconService.makeInstanceId();
    expect(a).not.toEqual(b);
    expect(a).toMatch(/^\d+-/);
  });
});
