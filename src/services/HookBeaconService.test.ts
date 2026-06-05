import * as vscode from 'vscode';
import { HookBeaconService, HookBeaconEvent } from './HookBeaconService';

jest.mock('../utils/diagnosticLog', () => ({ infoLog: jest.fn(), diagLog: jest.fn() }));

function makeWatcherFactory() {
  const created: Array<{ fireChange: () => void; dispose: jest.Mock }> = [];
  const create = jest.fn(() => {
    const change: Array<() => void> = [];
    const dispose = jest.fn();
    const watcher = {
      onDidChange: (l: () => void) => {
        change.push(l);
        return { dispose: jest.fn() };
      },
      onDidCreate: () => ({ dispose: jest.fn() }),
      onDidDelete: () => ({ dispose: jest.fn() }),
      dispose,
    } as unknown as vscode.FileSystemWatcher;
    created.push({ fireChange: () => change.forEach((l) => l()), dispose });
    return watcher;
  });
  return { create, created };
}

const BEACON = vscode.Uri.file('/gs/npc-ai-hook-beacon.json');
const enc = (obj: unknown): Uint8Array => Buffer.from(JSON.stringify(obj), 'utf8');
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('HookBeaconService', () => {
  it('does not watch until visible', () => {
    const wf = makeWatcherFactory();
    new HookBeaconService(BEACON, jest.fn(), { readFile: jest.fn() } as any, wf.create as any);
    expect(wf.create).not.toHaveBeenCalled();
  });

  it('emits {id,name,prompt} for a fresh beacon, resolving the display name', async () => {
    const wf = makeWatcherFactory();
    const onEvent = jest.fn();
    const fsApi = { readFile: jest.fn().mockResolvedValue(enc({ v: 1, ts: Date.now(), id: 'claude-code', prompt: 'hello there' })) };
    const svc = new HookBeaconService(BEACON, onEvent, fsApi as any, wf.create as any);
    svc.setVisible(true);

    wf.created[0].fireChange();
    await tick();

    const evt: HookBeaconEvent = onEvent.mock.calls[0][0];
    expect(evt).toEqual({ id: 'claude-code', name: 'Claude Code', prompt: 'hello there' });
  });

  it('ignores a stale beacon (older than the staleness window)', async () => {
    const wf = makeWatcherFactory();
    const onEvent = jest.fn();
    const fsApi = { readFile: jest.fn().mockResolvedValue(enc({ v: 1, ts: Date.now() - 20_000, id: 'codex' })) };
    const svc = new HookBeaconService(BEACON, onEvent, fsApi as any, wf.create as any);
    svc.setVisible(true);

    wf.created[0].fireChange();
    await tick();

    expect(onEvent).not.toHaveBeenCalled();
  });

  it('does not re-emit the same write (duplicate watcher events deduped by ts)', async () => {
    const wf = makeWatcherFactory();
    const onEvent = jest.fn();
    const fsApi = { readFile: jest.fn().mockResolvedValue(enc({ v: 1, ts: Date.now(), id: 'cursor', prompt: 'x' })) };
    const svc = new HookBeaconService(BEACON, onEvent, fsApi as any, wf.create as any);
    svc.setVisible(true);

    wf.created[0].fireChange();
    await tick();
    wf.created[0].fireChange(); // same file, same ts
    await tick();

    expect(onEvent).toHaveBeenCalledTimes(1);
  });

  it('stops watching and is safe to dispose', () => {
    const wf = makeWatcherFactory();
    const svc = new HookBeaconService(BEACON, jest.fn(), { readFile: jest.fn() } as any, wf.create as any);
    svc.setVisible(true);
    expect(wf.created).toHaveLength(1);
    svc.dispose();
    expect(wf.created[0].dispose).toHaveBeenCalled();
  });
});
