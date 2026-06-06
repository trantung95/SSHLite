/**
 * Docker integration test for issue #6 — same-basename temp-file collision.
 *
 * Two files that share a basename but live in DIFFERENT remote folders
 * (e.g. /home/testuser/col-www/domainA/index.php and .../domainB/index.php)
 * must map to DIFFERENT local temp files. Before the fix the local temp path
 * was derived from the connection + basename only, so the second file reused
 * the first file's temp path: opening one showed the other's content, and
 * saving could upload edits to the wrong remote file.
 *
 * The unit suites (connectionPrefix.test.ts, FileService.crud.test.ts) prove
 * the path math with mocks; this closes the gap end-to-end against a real SSH
 * server, including the on-disk content and the recovery metadata round-trip.
 *
 * Run: npm run test:docker
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { IHostConfig } from '../types';
import { SavedCredential, CredentialService } from '../services/CredentialService';
import { FileService } from '../services/FileService';

const S1 = { id: 'col-s1', label: 'hybr8-prod-web-01', host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' };

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

describe('issue #6 same-basename collision — docker integration', () => {
  let conn: SSHConnection;
  let service: FileService;

  const baseDir = '/home/testuser/col-www';
  const dirA = baseDir + '/domainA';
  const dirB = baseDir + '/domainB';
  const pathA = dirA + '/index.php';
  const pathB = dirB + '/index.php';
  const contentA = '<?php echo "DOMAIN A"; ?>';
  const contentB = '<?php echo "DOMAIN B"; ?>';

  beforeAll(async () => {
    conn = await mkConn();
    service = FileService.getInstance();
    // Self-contained: create the two same-named files in different folders.
    // mkdir is single-level, so create the parent before the leaf folders.
    try { await conn.mkdir(baseDir); } catch {}
    try { await conn.mkdir(dirA); } catch {}
    try { await conn.mkdir(dirB); } catch {}
    await conn.writeFile(pathA, Buffer.from(contentA));
    await conn.writeFile(pathB, Buffer.from(contentB));
  });

  afterAll(async () => {
    try { await conn.deleteFile(pathA); } catch {}
    try { await conn.deleteFile(pathB); } catch {}
    try { await conn.disconnect(); } catch {}
  });

  it('maps same-named files in different folders to different local temp paths', () => {
    const localA = service.getLocalFilePath(conn.id, pathA);
    const localB = service.getLocalFilePath(conn.id, pathB);

    expect(localA).not.toBe(localB);
  });

  it('downloads each file to its own temp path with the correct content (no cross-contamination)', async () => {
    const localA = service.getLocalFilePath(conn.id, pathA);
    const localB = service.getLocalFilePath(conn.id, pathB);

    // Real SSH reads, written to each file's own temp path (what openRemoteFile does).
    fs.writeFileSync(localA, await conn.readFile(pathA));
    fs.writeFileSync(localB, await conn.readFile(pathB));

    expect(localA).not.toBe(localB);
    expect(fs.readFileSync(localA, 'utf-8')).toContain('DOMAIN A');
    expect(fs.readFileSync(localB, 'utf-8')).toContain('DOMAIN B');
  });

  it('persists distinct recovery metadata so each temp file resolves to its own remote path', () => {
    const localA = service.getLocalFilePath(conn.id, pathA);
    const localB = service.getLocalFilePath(conn.id, pathB);

    // saveFileMetadata is private; exercise it directly to prove the metadata
    // store no longer collapses both files onto a single basename key.
    (service as any).saveFileMetadata(localA, pathA, conn.id);
    (service as any).saveFileMetadata(localB, pathB, conn.id);

    expect(service.getRemotePathFromMetadata(localA)?.remotePath).toBe(pathA);
    expect(service.getRemotePathFromMetadata(localB)?.remotePath).toBe(pathB);
  });
});
