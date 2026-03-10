/**
 * Chaos Bug Discovery Module - Connection Helpers
 *
 * Wraps multios-helpers.ts patterns for chaos testing.
 * Provides connection factory, cleanup, and seeded random utilities.
 */

import * as vscode from 'vscode';
import { IHostConfig, ConnectionState } from '../types';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { CredentialService, SavedCredential } from '../services/CredentialService';
import { ChaosServerConfig } from './ChaosConfig';

// ---- Known Hosts Mock ----

const knownHostsStore: Record<string, unknown> = {};

function getMockGlobalState(): vscode.Memento {
  return {
    get: <T>(key: string, defaultValue?: T): T => {
      return (knownHostsStore[key] as T) ?? (defaultValue as T);
    },
    update: async (key: string, value: unknown) => {
      knownHostsStore[key] = value;
    },
    keys: () => Object.keys(knownHostsStore),
  } as vscode.Memento;
}

// ---- Setup Functions ----

/**
 * Setup CredentialService mock for chaos testing.
 * Returns passwords for testuser and admin accounts.
 */
export function setupCredentialServiceMock(): void {
  (CredentialService as any)._instance = undefined;

  const mockInstance = {
    getCredentialSecret: jest.fn().mockImplementation(
      (_hostId: string, credId: string) => {
        if (credId === 'test-password') return Promise.resolve('testpass');
        if (credId === 'admin-password') return Promise.resolve('adminpass');
        return Promise.resolve(null);
      }
    ),
    getOrPrompt: jest.fn().mockImplementation(
      (_hostId: string, _type: string, _prompt: string) => {
        return Promise.resolve('testpass');
      }
    ),
    deleteAll: jest.fn(),
    listCredentials: jest.fn().mockReturnValue([]),
    updateCredentialPassword: jest.fn().mockResolvedValue(undefined),
    setSessionCredential: jest.fn(),
    initialize: jest.fn(),
  };

  (CredentialService as any)._instance = mockInstance;
}

/**
 * Setup vscode mocks for chaos testing.
 */
export function setupVscodeMocks(): void {
  setGlobalState(getMockGlobalState());
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
  (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('No, use only for this session');
}

// ---- Timeout Utility ----

/**
 * Wrap any promise with a timeout. Resolves/rejects with the original result
 * if it completes in time, otherwise rejects with a timeout error.
 * Used to prevent cleanup and connection operations from hanging indefinitely.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// ---- Connection Factory ----

/**
 * Create a real SSHConnection to a chaos test server.
 * Wrapped with 45s timeout to prevent TCP SYN hangs.
 */
export async function createChaosConnection(server: ChaosServerConfig): Promise<SSHConnection> {
  const hostConfig: IHostConfig = {
    id: `chaos-${server.label}-${server.username}`,
    name: `Chaos ${server.os} (${server.label})`,
    host: server.host,
    port: server.port,
    username: server.username,
    source: 'saved',
  };

  const credential: SavedCredential = {
    id: server.username === 'admin' ? 'admin-password' : 'test-password',
    label: `${server.username} Password`,
    type: 'password',
  };

  const conn = new SSHConnection(hostConfig, credential);
  await withTimeout(conn.connect(), 45000, `createChaosConnection(${server.label})`);

  // Wait for capability detection
  await new Promise(resolve => setTimeout(resolve, 1000));

  return conn;
}

/**
 * Safely disconnect a connection, ignoring errors.
 * Wrapped with 10s timeout to prevent hanging on stuck close events.
 */
export async function safeChaosDisconnect(conn: SSHConnection | null): Promise<void> {
  if (!conn) return;
  try {
    await withTimeout(conn.disconnect(), 10000, 'safeChaosDisconnect');
  } catch {
    // Ignore disconnect errors and timeouts in cleanup
  }
}

/**
 * Wait for a connection to reach a specific state.
 */
export async function waitForState(
  conn: SSHConnection,
  targetState: ConnectionState,
  timeoutMs = 5000,
): Promise<void> {
  if (conn.state === targetState) return;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      disposable.dispose();
      reject(new Error(`Timed out waiting for state ${targetState}, current: ${conn.state}`));
    }, timeoutMs);
    const disposable = conn.onStateChange((state: ConnectionState) => {
      if (state === targetState) {
        clearTimeout(timer);
        disposable.dispose();
        resolve();
      }
    });
  });
}

// ---- Seeded Random ----

/**
 * Simple seeded pseudo-random number generator (xorshift32).
 * Produces deterministic sequences for reproducible chaos runs.
 */
export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    // xorshift32 requires non-zero state; seed 0 explicitly maps to 1
    this.state = seed === 0 ? 1 : (seed || 1);
  }

  /** Returns a float in [0, 1) */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    this.state = x;
    return (x >>> 0) / 4294967296;
  }

  /** Returns an integer in [min, max] inclusive */
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  /** Pick a random element from an array */
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Shuffle an array in place */
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Generate a random string of given length */
  string(length: number, charset = 'abcdefghijklmnopqrstuvwxyz0123456789'): string {
    let result = '';
    for (let i = 0; i < length; i++) {
      result += charset[Math.floor(this.next() * charset.length)];
    }
    return result;
  }

  /** Generate random bytes as Buffer */
  bytes(length: number): Buffer {
    const buf = Buffer.alloc(length);
    for (let i = 0; i < length; i++) {
      buf[i] = Math.floor(this.next() * 256);
    }
    return buf;
  }
}
