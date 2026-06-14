/**
 * Shared test helpers and mock factories
 * Used across all test files for consistent mock objects
 */

import { IHostConfig, IRemoteFile, IPortForward, ConnectionState } from '../types';
import { SavedCredential, PinnedFolder } from '../services/CredentialService';
import { setDiagOutputChannel, refreshDiagEnabled } from '../utils/diagnosticLog';
import * as vscode from 'vscode';

/**
 * Captured log line shape, parsed from `[ts] [LEVEL/category] message  k1=v1 k2=v2` format.
 */
export interface CapturedLog {
  raw: string;
  level: 'INFO' | 'DIAG' | string;
  category: string;
  message: string;
  data: Record<string, string>;
}

/**
 * Setup a fresh log capture for the current test. Call this in `beforeEach` and use the
 * returned object to assert on emitted logs. Diagnostic logging is enabled by default so
 * both `infoLog` and `diagLog` calls are captured. Pass `enableDiag: false` to verify
 * gated behavior (i.e. that diagLog DOESN'T fire when disabled).
 */
export function setupLogCapture(opts: { enableDiag?: boolean } = {}): {
  lines: CapturedLog[];
  rawLines: string[];
  channel: { appendLine: jest.Mock; show: jest.Mock; dispose: jest.Mock };
  /** Find logs matching level + category. Optionally also match a substring of the message. */
  find: (level: 'INFO' | 'DIAG', category: string, messageSubstring?: string) => CapturedLog[];
  reset: () => void;
} {
  const enableDiag = opts.enableDiag !== false;
  const rawLines: string[] = [];
  const channel = {
    appendLine: jest.fn((line: string) => { rawLines.push(line); }),
    append: jest.fn(),
    clear: jest.fn(),
    show: jest.fn(),
    hide: jest.fn(),
    dispose: jest.fn(),
    name: 'SSH Lite (test)',
    replace: jest.fn(),
  } as unknown as { appendLine: jest.Mock; show: jest.Mock; dispose: jest.Mock };

  // Make vscode.workspace.getConfiguration('sshLite').get('diagnosticLogging') return enableDiag.
  // setMockConfig writes to the shared configValues Map used by the mock's get().
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vscodeMock = require('vscode') as { setMockConfig?: (k: string, v: unknown) => void };
  if (typeof vscodeMock.setMockConfig === 'function') {
    vscodeMock.setMockConfig('sshLite.diagnosticLogging', enableDiag);
  }

  setDiagOutputChannel(channel as unknown as vscode.OutputChannel);
  refreshDiagEnabled();

  const lines: CapturedLog[] = [];
  // Wrap appendLine to also parse + push into `lines` for structured assertions
  const origAppend = channel.appendLine;
  channel.appendLine = jest.fn((line: string) => {
    origAppend(line);
    const parsed = parseLogLine(line);
    if (parsed) lines.push(parsed);
  });
  // Re-wire the channel since we replaced appendLine
  setDiagOutputChannel(channel as unknown as vscode.OutputChannel);

  return {
    lines,
    rawLines,
    channel,
    find: (level, category, messageSubstring) =>
      lines.filter(l =>
        l.level === level &&
        l.category === category &&
        (messageSubstring === undefined || l.message.includes(messageSubstring))
      ),
    reset: () => {
      rawLines.length = 0;
      lines.length = 0;
      channel.appendLine.mockClear();
    },
  };
}

/**
 * Parse a single output line emitted by diagnosticLog.
 * Format: `[2026-05-04T...] [LEVEL/category] message  k1=v1 k2=v2`
 */
function parseLogLine(line: string): CapturedLog | null {
  const m = line.match(/^\[[^\]]+\] \[(INFO|DIAG)\/([^\]]+)\] (.*?)(?:  (.*))?$/);
  if (!m) return null;
  const [, level, category, message, dataStr] = m;
  const data: Record<string, string> = {};
  if (dataStr) {
    // The formatter joins k=v pairs with single space; values themselves may contain
    // spaces (cmd previews, error messages). Reconstruct by greedily appending tokens
    // that don't contain '=' to the previous value.
    const tokens = dataStr.split(' ');
    let curKey: string | null = null;
    let curVal = '';
    const flush = () => {
      if (curKey !== null) data[curKey] = curVal;
    };
    for (const tok of tokens) {
      const eq = tok.indexOf('=');
      if (eq > 0) {
        flush();
        curKey = tok.slice(0, eq);
        curVal = tok.slice(eq + 1);
      } else if (curKey !== null) {
        curVal += ' ' + tok;
      }
    }
    flush();
  }
  return { raw: line, level, category, message, data };
}

/**
 * Create a mock IHostConfig
 */
export function createMockHostConfig(overrides: Partial<IHostConfig> = {}): IHostConfig {
  return {
    id: 'test-host-1',
    name: 'Test Server',
    host: '192.168.1.100',
    port: 22,
    username: 'testuser',
    source: 'saved',
    ...overrides,
  };
}

/**
 * Create a mock IRemoteFile
 */
export function createMockRemoteFile(name: string, overrides: Partial<IRemoteFile> = {}): IRemoteFile {
  return {
    name,
    path: `/${name}`,
    isDirectory: false,
    size: 1024,
    modifiedTime: Date.now(),
    connectionId: 'test-connection',
    ...overrides,
  };
}

/**
 * Create a mock SavedCredential
 */
export function createMockCredential(overrides: Partial<SavedCredential> = {}): SavedCredential {
  return {
    id: `cred_${Date.now()}_test`,
    label: 'Default',
    type: 'password',
    ...overrides,
  };
}

/**
 * Create a mock PinnedFolder
 */
export function createMockPinnedFolder(overrides: Partial<PinnedFolder> = {}): PinnedFolder {
  return {
    id: `pin_${Date.now()}_test`,
    name: 'Projects',
    remotePath: '/home/user/projects',
    ...overrides,
  };
}

/**
 * Create a mock IPortForward
 */
export function createMockPortForward(overrides: Partial<IPortForward> = {}): IPortForward {
  return {
    id: 'fwd-1',
    connectionId: 'test-connection',
    localPort: 3000,
    remoteHost: 'localhost',
    remotePort: 3000,
    active: true,
    ...overrides,
  };
}

/**
 * Create a mock SSHConnection-like object with all methods mocked
 */
export function createMockConnection(overrides: Partial<{
  id: string;
  host: IHostConfig;
  state: ConnectionState;
}> = {}) {
  const host = overrides.host || createMockHostConfig();
  return {
    id: overrides.id || `${host.host}:${host.port}:${host.username}`,
    host,
    state: overrides.state || ConnectionState.Connected,
    client: null,
    capabilities: {
      type: 'ssh',
      supportsExec: true,
      supportsShell: true,
      supportsPortForward: true,
      supportsNativeWatch: true,
      supportsSearch: true,
      supportsServerBackup: true,
      supportsSudo: true,
    },
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    exec: jest.fn().mockResolvedValue(''),
    resolveHomePath: jest.fn().mockResolvedValue(`/home/${host.username}`),
    shell: jest.fn().mockResolvedValue({}),
    listFiles: jest.fn().mockResolvedValue([]),
    readFile: jest.fn().mockResolvedValue(Buffer.from('')),
    writeFile: jest.fn().mockResolvedValue(undefined),
    deleteFile: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    stat: jest.fn().mockResolvedValue(createMockRemoteFile('test')),
    fileExists: jest.fn().mockResolvedValue(false),
    forwardPort: jest.fn().mockResolvedValue(undefined),
    stopForward: jest.fn().mockResolvedValue(undefined),
    searchFiles: jest.fn().mockResolvedValue([]),
    listDirectories: jest.fn().mockResolvedValue([]),
    listEntries: jest.fn().mockResolvedValue({ files: [], dirs: [] }),
    onStateChange: jest.fn().mockReturnValue({ dispose: jest.fn() }),
    dispose: jest.fn(),
  };
}
