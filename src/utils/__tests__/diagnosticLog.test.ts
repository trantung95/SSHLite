// src/utils/__tests__/diagnosticLog.test.ts

import * as vscode from 'vscode';
import {
  setDiagOutputChannel,
  refreshDiagEnabled,
  isDiagEnabled,
  infoLog,
  diagLog,
} from '../diagnosticLog';
import { setupLogCapture } from '../../__mocks__/testHelpers';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { setMockConfig, clearMockConfig } = require('vscode') as {
  setMockConfig: (k: string, v: unknown) => void;
  clearMockConfig: () => void;
};

describe('diagnosticLog', () => {
  describe('infoLog (always emits)', () => {
    it('writes to the configured channel even when diagnosticLogging is off', () => {
      const cap = setupLogCapture({ enableDiag: false });
      infoLog('lifecycle', 'extension activating', { version: '1.2.3' });
      const found = cap.find('INFO', 'lifecycle', 'extension activating');
      expect(found).toHaveLength(1);
      expect(found[0].data.version).toBe('1.2.3');
    });

    it('formats the timestamp + level + category + message + data', () => {
      const cap = setupLogCapture({ enableDiag: false });
      infoLog('semaphore', 'create', { label: 'host:22:user', maxSlots: 8 });
      const line = cap.rawLines[0];
      expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z?\] \[INFO\/semaphore\] create  label=host:22:user maxSlots=8$/);
    });

    it('emits with no data block when data is omitted', () => {
      const cap = setupLogCapture({ enableDiag: false });
      infoLog('lifecycle', 'just a message');
      expect(cap.rawLines[0]).toMatch(/\[INFO\/lifecycle\] just a message$/);
      expect(cap.rawLines[0]).not.toContain('  ='); // no trailing data separator
    });
  });

  describe('diagLog (gated)', () => {
    it('does NOT emit when diagnosticLogging is false', () => {
      const cap = setupLogCapture({ enableDiag: false });
      diagLog('semaphore', 'acquire/immediate', { active: 1 });
      expect(cap.find('DIAG', 'semaphore')).toHaveLength(0);
      expect(cap.rawLines).toHaveLength(0);
    });

    it('emits when diagnosticLogging is true', () => {
      const cap = setupLogCapture({ enableDiag: true });
      diagLog('semaphore', 'acquire/immediate', { active: 1 });
      const found = cap.find('DIAG', 'semaphore', 'acquire/immediate');
      expect(found).toHaveLength(1);
      expect(found[0].data.active).toBe('1');
    });

    it('refreshDiagEnabled picks up runtime config changes', () => {
      const cap = setupLogCapture({ enableDiag: false });
      diagLog('test', 'hidden');
      expect(cap.rawLines).toHaveLength(0);

      setMockConfig('sshLite.diagnosticLogging', true);
      refreshDiagEnabled();
      expect(isDiagEnabled()).toBe(true);

      diagLog('test', 'visible');
      expect(cap.find('DIAG', 'test', 'visible')).toHaveLength(1);
    });
  });

  describe('formatting', () => {
    it('truncates string values longer than 200 chars with ellipsis', () => {
      const cap = setupLogCapture();
      const longStr = 'a'.repeat(300);
      infoLog('test', 'long', { v: longStr });
      const line = cap.rawLines[0];
      expect(line).toContain('v=' + 'a'.repeat(200) + '…');
      expect(line).not.toContain('a'.repeat(201)); // truncated, not full
    });

    it('serializes nested objects as JSON, also truncated at 200 chars', () => {
      const cap = setupLogCapture();
      infoLog('test', 'obj', { v: { a: 1, b: 'two' } });
      expect(cap.rawLines[0]).toContain('v={"a":1,"b":"two"}');
    });

    it('emits null/undefined as literal strings', () => {
      const cap = setupLogCapture();
      infoLog('test', 'nil', { a: null, b: undefined });
      expect(cap.rawLines[0]).toContain('a=null');
      expect(cap.rawLines[0]).toContain('b=undefined');
    });

    it('handles unserializable values (circular refs) without throwing', () => {
      const cap = setupLogCapture();
      const circular: { self?: unknown } = {};
      circular.self = circular;
      expect(() => infoLog('test', 'circ', { v: circular })).not.toThrow();
      expect(cap.rawLines[0]).toContain('v=[unserializable]');
    });
  });

  describe('channel wiring', () => {
    it('silently drops logs when no channel has been configured', () => {
      // Reset to a state where no channel is set.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      setDiagOutputChannel(undefined as unknown as vscode.OutputChannel);
      // No throw, no captured output.
      expect(() => infoLog('test', 'orphan')).not.toThrow();
      expect(() => diagLog('test', 'orphan')).not.toThrow();
    });
  });

  afterEach(() => {
    clearMockConfig();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setDiagOutputChannel(undefined as unknown as vscode.OutputChannel);
    refreshDiagEnabled();
  });
});
