/**
 * RemoteClipboardService tests
 *
 * Covers:
 *  - singleton identity
 *  - copy/cut state storage
 *  - hasClipboard()
 *  - clear() transitions
 *  - setContext side-effect for sshLite.hasClipboard
 *  - onDidChange fires
 */

import * as vscode from 'vscode';
import { RemoteClipboardService, ClipboardEntry } from './RemoteClipboardService';

function reset(): RemoteClipboardService {
  (RemoteClipboardService as any)._instance = undefined;
  return RemoteClipboardService.getInstance();
}

function makeEntry(overrides: Partial<ClipboardEntry> = {}): ClipboardEntry {
  return {
    connectionId: 'conn-1',
    remotePath: '/home/u/file.txt',
    isDirectory: false,
    name: 'file.txt',
    ...overrides,
  };
}

describe('RemoteClipboardService', () => {
  let service: RemoteClipboardService;
  let executeCommandMock: jest.SpyInstance;

  beforeEach(() => {
    service = reset();
    executeCommandMock = jest.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    executeCommandMock.mockRestore();
  });

  describe('getInstance', () => {
    it('returns a singleton', () => {
      const a = RemoteClipboardService.getInstance();
      const b = RemoteClipboardService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('setClipboard', () => {
    it('stores a copy operation and sets hasClipboard context key to true', () => {
      const entry = makeEntry();
      service.setClipboard([entry], 'copy');

      const state = service.getClipboard();
      expect(state).not.toBeNull();
      expect(state!.operation).toBe('copy');
      expect(state!.items).toEqual([entry]);
      expect(service.hasClipboard()).toBe(true);
      expect(executeCommandMock).toHaveBeenCalledWith('setContext', 'sshLite.hasClipboard', true);
    });

    it('stores a cut operation', () => {
      const entry = makeEntry({ name: 'dir', isDirectory: true, remotePath: '/home/u/dir' });
      service.setClipboard([entry], 'cut');

      expect(service.getClipboard()!.operation).toBe('cut');
      expect(service.getClipboard()!.items[0].isDirectory).toBe(true);
    });

    it('treats empty items as clear', () => {
      service.setClipboard([makeEntry()], 'copy');
      executeCommandMock.mockClear();

      service.setClipboard([], 'copy');

      expect(service.getClipboard()).toBeNull();
      expect(service.hasClipboard()).toBe(false);
      expect(executeCommandMock).toHaveBeenCalledWith('setContext', 'sshLite.hasClipboard', false);
    });

    it('fires onDidChange when clipboard is updated', () => {
      const listener = jest.fn();
      service.onDidChange(listener);

      service.setClipboard([makeEntry()], 'copy');

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('clear', () => {
    it('clears state and toggles the context key back to false', () => {
      service.setClipboard([makeEntry()], 'copy');
      executeCommandMock.mockClear();

      service.clear();

      expect(service.getClipboard()).toBeNull();
      expect(service.hasClipboard()).toBe(false);
      expect(executeCommandMock).toHaveBeenCalledWith('setContext', 'sshLite.hasClipboard', false);
    });

    it('is a no-op when clipboard is already empty', () => {
      const listener = jest.fn();
      service.onDidChange(listener);

      service.clear();

      expect(executeCommandMock).not.toHaveBeenCalled();
      expect(listener).not.toHaveBeenCalled();
    });

    it('fires onDidChange exactly once on clear', () => {
      service.setClipboard([makeEntry()], 'copy');
      const listener = jest.fn();
      service.onDidChange(listener);

      service.clear();

      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('multi-item', () => {
    it('preserves order of items in clipboard', () => {
      const a = makeEntry({ name: 'a', remotePath: '/a' });
      const b = makeEntry({ name: 'b', remotePath: '/b' });
      const c = makeEntry({ name: 'c', remotePath: '/c' });
      service.setClipboard([a, b, c], 'copy');

      expect(service.getClipboard()!.items.map((i) => i.name)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('dispose', () => {
    it('dispose() does not throw', () => {
      expect(() => service.dispose()).not.toThrow();
    });

    it('after dispose(), onDidChange no longer fires', () => {
      const listener = jest.fn();
      service.onDidChange(listener);
      service.dispose();
      // Firing after dispose should be a no-op (EventEmitter disposed)
      try { (service as any)._onDidChange.fire(); } catch { /* some emitters throw when disposed */ }
      expect(listener).not.toHaveBeenCalled();
    });
  });
});
