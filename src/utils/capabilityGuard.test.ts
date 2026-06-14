import { hasCapability, ensureCapability, assertCapability } from './capabilityGuard';
import * as vscode from 'vscode';
import { IConnection } from '../types';

function conn(type: 'ssh' | 'ftp'): IConnection {
  const ssh = type === 'ssh';
  return {
    capabilities: {
      type,
      supportsExec: ssh,
      supportsShell: ssh,
      supportsPortForward: ssh,
      supportsNativeWatch: ssh,
      supportsSearch: ssh,
      supportsServerBackup: ssh,
      supportsSudo: ssh,
    },
  } as unknown as IConnection;
}

describe('capabilityGuard', () => {
  beforeEach(() => {
    (vscode.window.showWarningMessage as jest.Mock).mockReset?.();
  });

  describe('hasCapability', () => {
    it('reflects the flag', () => {
      expect(hasCapability(conn('ssh'), 'supportsExec')).toBe(true);
      expect(hasCapability(conn('ftp'), 'supportsExec')).toBe(false);
      expect(hasCapability(conn('ftp'), 'supportsSearch')).toBe(false);
    });

    it('treats a connection with no capabilities object as capable (legacy/SSH default)', () => {
      expect(hasCapability({} as unknown as IConnection, 'supportsExec')).toBe(true);
    });
  });

  describe('assertCapability', () => {
    it('does not throw when supported', () => {
      expect(() => assertCapability(conn('ssh'), 'supportsExec')).not.toThrow();
    });

    it('throws a clear error mentioning the protocol when unsupported', () => {
      expect(() => assertCapability(conn('ftp'), 'supportsExec')).toThrow(/FTP/);
      expect(() => assertCapability(conn('ftp'), 'supportsShell')).toThrow(/not available over FTP/i);
    });

    it('uses a custom action label when provided', () => {
      expect(() => assertCapability(conn('ftp'), 'supportsExec', 'Pushing a public key')).toThrow(/Pushing a public key/);
    });
  });

  describe('ensureCapability', () => {
    it('returns true and shows nothing when supported', () => {
      expect(ensureCapability(conn('ssh'), 'supportsShell')).toBe(true);
      expect(vscode.window.showWarningMessage).not.toHaveBeenCalled();
    });

    it('returns false and warns when unsupported', () => {
      expect(ensureCapability(conn('ftp'), 'supportsShell')).toBe(false);
      expect(vscode.window.showWarningMessage).toHaveBeenCalledTimes(1);
      const msg = (vscode.window.showWarningMessage as jest.Mock).mock.calls[0][0] as string;
      expect(msg).toMatch(/FTP/);
    });
  });
});
