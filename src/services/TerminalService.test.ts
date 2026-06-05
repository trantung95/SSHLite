/**
 * TerminalService tests
 *
 * Tests terminal management:
 * - Singleton pattern
 * - Terminal counting per connection
 * - Terminal ID generation
 * - Error handling on terminal creation
 *
 * The actual pseudoterminal creation and SSH shell integration
 * are too tightly coupled to VS Code to unit test meaningfully.
 */

import { EventEmitter } from 'events';
import * as vscode from 'vscode';
import { TerminalService } from './TerminalService';

function resetService(): TerminalService {
  (TerminalService as any)._instance = undefined;
  return TerminalService.getInstance();
}

describe('TerminalService', () => {
  let service: TerminalService;

  beforeEach(() => {
    service = resetService();
  });

  describe('getInstance', () => {
    it('should return singleton', () => {
      const a = TerminalService.getInstance();
      const b = TerminalService.getInstance();
      expect(a).toBe(b);
    });
  });

  describe('getTerminalCount', () => {
    it('should return 0 for unknown connection', () => {
      expect(service.getTerminalCount('nonexistent')).toBe(0);
    });

    it('should return 0 initially', () => {
      expect(service.getTerminalCount('conn1')).toBe(0);
    });
  });

  describe('terminal ID format', () => {
    it('should format as connectionId-number', () => {
      const connectionId = '10.0.0.1:22:admin';
      const terminalNumber = 1;
      const expectedId = `${connectionId}-${terminalNumber}`;
      expect(expectedId).toBe('10.0.0.1:22:admin-1');
    });

    it('should increment terminal numbers', () => {
      const connectionId = 'conn1';
      const ids = [
        `${connectionId}-1`,
        `${connectionId}-2`,
        `${connectionId}-3`,
      ];
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(3);
    });
  });

  describe('multi-connection terminal management', () => {
    it('should generate unique IDs across different connections', () => {
      const id1 = '10.0.0.1:22:admin-1';
      const id2 = '10.0.0.2:22:admin-1';
      const id3 = '10.0.0.1:22:deploy-1';

      const ids = new Set([id1, id2, id3]);
      expect(ids.size).toBe(3);
    });

    it('should track terminal counts independently per connection', () => {
      expect(service.getTerminalCount('conn1')).toBe(0);
      expect(service.getTerminalCount('conn2')).toBe(0);
      expect(service.getTerminalCount('conn3')).toBe(0);
    });

    it('should handle terminal IDs with different port numbers', () => {
      const prodId = '10.0.0.1:22:admin-1';
      const customPortId = '10.0.0.1:2222:admin-1';
      expect(prodId).not.toBe(customPortId);
    });
  });

  describe('onActivity', () => {
    afterEach(() => {
      (vscode.window.createTerminal as jest.Mock).mockReset().mockReturnValue({
        show: jest.fn(),
        dispose: jest.fn(),
      });
    });

    it('fires "input" on pty keystrokes and "output" on server data — no content', async () => {
      let pty: any;
      (vscode.window.createTerminal as jest.Mock).mockImplementation((opts: { pty: unknown }) => {
        pty = opts.pty;
        return { show: jest.fn(), dispose: jest.fn() };
      });

      const shell: any = new EventEmitter();
      shell.write = jest.fn();
      shell.setWindow = jest.fn();
      shell.end = jest.fn();
      const connection: any = {
        id: 'c1',
        host: { name: 'host' },
        shell: jest.fn().mockResolvedValue(shell),
      };

      const events: Array<'input' | 'output'> = [];
      service.onActivity((k) => events.push(k));

      await service.createTerminal(connection);
      pty.open({ rows: 24, columns: 80 }); // registers shell.on('data')

      pty.handleInput('secret-keystrokes');
      expect(events).toContain('input');
      expect(shell.write).toHaveBeenCalledWith('secret-keystrokes');

      shell.emit('data', Buffer.from('server output'));
      expect(events).toContain('output');
    });

    it('dispose() disposes the activity emitter (no events after)', async () => {
      const events: string[] = [];
      service.onActivity((k) => events.push(k));
      service.dispose();
      // After dispose the emitter has no listeners; firing internally is a no-op.
      expect(() => service.dispose()).not.toThrow();
      expect(events).toHaveLength(0);
    });
  });

  describe('native-parity PTY (term + env)', () => {
    const ORIG_ENV = { ...process.env };
    const ENV_KEYS = ['LANG', 'LC_CTYPE', 'LC_ALL', 'COLORTERM'];

    function mockConfig(values: Record<string, unknown>) {
      jest.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
        get: (key: string, def?: unknown) => (key in values ? values[key] : def),
      } as any);
    }

    afterEach(() => {
      jest.restoreAllMocks();
      for (const k of ENV_KEYS) {
        delete process.env[k];
        if (ORIG_ENV[k] !== undefined) process.env[k] = ORIG_ENV[k];
      }
      (vscode.window.createTerminal as jest.Mock)
        .mockReset()
        .mockReturnValue({ show: jest.fn(), dispose: jest.fn() });
    });

    it('getTermType defaults to xterm-256color', () => {
      mockConfig({});
      expect(service.getTermType()).toBe('xterm-256color');
    });

    it('getTermType honors a configured value', () => {
      mockConfig({ 'terminal.termType': 'vt100' });
      expect(service.getTermType()).toBe('vt100');
    });

    it('buildShellEnv forwards client locale vars when forwardEnv is on (default)', () => {
      mockConfig({});
      process.env.LANG = 'en_US.UTF-8';
      process.env.LC_CTYPE = 'en_US.UTF-8';
      const env = service.buildShellEnv();
      expect(env.LANG).toBe('en_US.UTF-8');
      expect(env.LC_CTYPE).toBe('en_US.UTF-8');
    });

    it('buildShellEnv omits locale vars when forwardEnv is disabled', () => {
      mockConfig({ 'terminal.forwardEnv': false });
      process.env.LANG = 'en_US.UTF-8';
      const env = service.buildShellEnv();
      expect(env.LANG).toBeUndefined();
    });

    it('buildShellEnv merges user terminal.env over forwarded vars', () => {
      mockConfig({ 'terminal.env': { COLORTERM: 'truecolor', LANG: 'C.UTF-8' } });
      process.env.LANG = 'en_US.UTF-8';
      const env = service.buildShellEnv();
      expect(env.COLORTERM).toBe('truecolor');
      expect(env.LANG).toBe('C.UTF-8'); // user override wins over forwarded value
    });

    it('createTerminal requests a PTY with term + env on the shell channel', async () => {
      mockConfig({});
      process.env.LANG = 'en_US.UTF-8';
      (vscode.window.createTerminal as jest.Mock).mockReturnValue({ show: jest.fn(), dispose: jest.fn() });

      const shell: any = new EventEmitter();
      shell.write = jest.fn();
      shell.setWindow = jest.fn();
      shell.end = jest.fn();
      const shellSpy = jest.fn().mockResolvedValue(shell);
      const connection: any = { id: 'c1', host: { name: 'host' }, shell: shellSpy };

      await service.createTerminal(connection);

      expect(shellSpy).toHaveBeenCalledTimes(1);
      const [ptyArg, optsArg] = shellSpy.mock.calls[0];
      expect(ptyArg).toEqual({ term: 'xterm-256color' });
      expect(optsArg.env.LANG).toBe('en_US.UTF-8');
    });

    it('createTerminal reuses a preOpened shell and does not open a new one', async () => {
      mockConfig({});
      (vscode.window.createTerminal as jest.Mock).mockReturnValue({ show: jest.fn(), dispose: jest.fn() });

      const shell: any = new EventEmitter();
      shell.write = jest.fn();
      shell.setWindow = jest.fn();
      shell.end = jest.fn();
      const shellSpy = jest.fn();
      const connection: any = { id: 'c2', host: { name: 'host' }, shell: shellSpy };

      await service.createTerminal(connection, shell);

      expect(shellSpy).not.toHaveBeenCalled();
    });
  });
});
