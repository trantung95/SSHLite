/**
 * Docker integration test for the v0.8.17 download URI refactor.
 *
 * Verifies the end-to-end SSH-bytes to vscode.workspace.fs.writeFile pipeline:
 *  1. Real SSH read from a Docker test server.
 *  2. FileService.downloadFileTo writes via vscode.workspace.fs.writeFile,
 *     never raw fs.writeFileSync, regardless of saveUri.scheme.
 *
 * The unit suite (FileService.downloadUri.test.ts) already proves the URI
 * routing with mocked SSH; this test closes the integration gap by feeding
 * real SHA256-verifiable bytes through the pipeline.
 *
 * Run:
 *   npm run test:docker
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { IHostConfig, IRemoteFile } from '../types';
import { SavedCredential, CredentialService } from '../services/CredentialService';
import { FileService } from '../services/FileService';

const S1 = { id: 'dl-s1', label: 'prod-server', host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' };

const _knownHosts: Record<string, unknown> = {};

function setupMocks(): void {
  setGlobalState({
    get: <T>(key: string, def?: T) => (_knownHosts[key] as T) ?? (def as T),
    update: async (k: string, v: unknown) => { _knownHosts[k] = v; },
    keys: () => Object.keys(_knownHosts),
  } as vscode.Memento);
  (CredentialService as any)._instance = undefined;
  (CredentialService as any)._instance = {
    getCredentialSecret: jest.fn().mockResolvedValue('testpass'),
    getOrPrompt: jest.fn().mockResolvedValue('testpass'),
    initialize: jest.fn(),
  };
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
  (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('No, use only for this session');
}

async function mkConn(): Promise<SSHConnection> {
  const host: IHostConfig = { id: S1.id, name: S1.label, host: S1.host, port: S1.port, username: S1.username, source: 'saved' };
  const cred: SavedCredential = { id: S1.id + '-pw', label: 'pw', type: 'password' };
  const c = new SSHConnection(host, cred);
  await c.connect();
  await new Promise(r => setTimeout(r, 500));
  return c;
}

beforeAll(() => {
  setupMocks();
  (FileService as any)._instance = undefined;
});

describe('v0.8.17 download URI routing — docker integration', () => {
  let conn: SSHConnection;
  const remoteDir = '/home/testuser/dl-uri';
  const remotePath = remoteDir + '/source.bin';
  let sourceSha: string;
  const fileSize = 64 * 1024;

  beforeAll(async () => {
    conn = await mkConn();
    try { await conn.deleteFile(remotePath); } catch {}
    try { await conn.mkdir(remoteDir); } catch {}
    // 64 KB of deterministic random bytes to exercise SFTP chunking
    // without making the test slow.
    const bytes = crypto.randomBytes(fileSize);
    sourceSha = crypto.createHash('sha256').update(bytes).digest('hex');
    await conn.writeFile(remotePath, bytes);
  });

  afterAll(async () => {
    try { await conn.deleteFile(remotePath); } catch {}
    try { await conn.disconnect(); } catch {}
  });

  beforeEach(() => {
    (vscode.workspace.fs.writeFile as jest.Mock).mockClear().mockResolvedValue(undefined);
    (fs.writeFileSync as unknown as jest.Mock | undefined)?.mockClear?.();
  });

  it('SSH bytes -> vscode.workspace.fs.writeFile(file: URI) preserves SHA256', async () => {
    const saveUri = vscode.Uri.file('/tmp/sshlite-dl-test.bin');
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(saveUri);

    const remoteFile: IRemoteFile = {
      name: 'source.bin',
      path: remotePath,
      isDirectory: false,
      size: fileSize,
      modifiedTime: Date.now(),
      connectionId: conn.id,
    };

    const service = FileService.getInstance();
    await service.downloadFileTo(conn, remoteFile);

    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    const [calledUri, calledBuf] = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls[0];
    expect(calledUri.scheme).toBe('file');
    expect(calledUri.path).toBe(saveUri.path);

    const writtenSha = crypto.createHash('sha256').update(Buffer.from(calledBuf)).digest('hex');
    expect(writtenSha).toBe(sourceSha);
  });

  it('SSH bytes -> vscode.workspace.fs.writeFile(vscode-remote: URI) preserves SHA256 and never falls back to raw fs', async () => {
    const saveUri = vscode.Uri.parse('vscode-remote://ssh-remote+box/home/userA/dl.bin');
    (vscode.window.showSaveDialog as jest.Mock).mockResolvedValueOnce(saveUri);

    const remoteFile: IRemoteFile = {
      name: 'source.bin',
      path: remotePath,
      isDirectory: false,
      size: fileSize,
      modifiedTime: Date.now(),
      connectionId: conn.id,
    };

    const service = FileService.getInstance();
    await service.downloadFileTo(conn, remoteFile);

    expect(vscode.workspace.fs.writeFile).toHaveBeenCalledTimes(1);
    const [calledUri, calledBuf] = (vscode.workspace.fs.writeFile as jest.Mock).mock.calls[0];
    expect(calledUri.scheme).toBe('vscode-remote');

    const writtenSha = crypto.createHash('sha256').update(Buffer.from(calledBuf)).digest('hex');
    expect(writtenSha).toBe(sourceSha);
  });
});
