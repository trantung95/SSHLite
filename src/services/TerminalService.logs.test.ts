/**
 * TerminalService log tests (v0.7.3 diagnostics)
 */

import { TerminalService } from './TerminalService';
import { createMockConnection, setupLogCapture } from '../__mocks__/testHelpers';

function reset(): TerminalService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (TerminalService as any)._instance = undefined;
  return TerminalService.getInstance();
}

describe('TerminalService — diagnostic logs', () => {
  let svc: TerminalService;
  beforeEach(() => { svc = reset(); });

  it('emits create/begin and create/success on success (always-on)', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection({ id: 'host:22:user' }) as any;
    const fakeShell = { on: jest.fn() };
    conn['shell'] = jest.fn().mockResolvedValue(fakeShell);
    await svc.createTerminal(conn);
    const begin = cap.find('INFO', 'terminal', 'create/begin');
    expect(begin).toHaveLength(1);
    expect(begin[0].data.connectionId).toBe('host:22:user');
    expect(begin[0].data.terminalNumber).toBe('1');
    expect(begin[0].data.preOpened).toBe('false');
    const success = cap.find('INFO', 'terminal', 'create/success');
    expect(success).toHaveLength(1);
    expect(success[0].data.terminalNumber).toBe('1');
  });

  it('emits create/failed (always-on) when underlying shell call rejects', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    conn['shell'] = jest.fn().mockRejectedValue(new Error('channel timeout'));
    await expect(svc.createTerminal(conn)).rejects.toThrow('channel timeout');
    const failed = cap.find('INFO', 'terminal', 'create/failed');
    expect(failed).toHaveLength(1);
    expect(failed[0].data.errorMessage).toBe('channel timeout');
  });

  it('emits preOpened=true when a shell channel is supplied', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const preOpenedShell = { on: jest.fn() } as any;
    await svc.createTerminal(conn, preOpenedShell);
    const begin = cap.find('INFO', 'terminal', 'create/begin')[0];
    expect(begin.data.preOpened).toBe('true');
  });

  it('increments terminalNumber on subsequent creates for the same connection', async () => {
    const cap = setupLogCapture({ enableDiag: false });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = createMockConnection() as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    conn['shell'] = jest.fn().mockResolvedValue({ on: jest.fn() } as any);
    await svc.createTerminal(conn);
    await svc.createTerminal(conn);
    const begins = cap.find('INFO', 'terminal', 'create/begin');
    expect(begins).toHaveLength(2);
    expect(begins[0].data.terminalNumber).toBe('1');
    expect(begins[1].data.terminalNumber).toBe('2');
  });
});
