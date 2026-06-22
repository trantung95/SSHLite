/**
 * Docker integration test — issue #18 ("no move file").
 *
 * The reporter dragged a file from one server's folder onto a DIFFERENT server's
 * folder in the SSH Lite tree and nothing happened — a completely silent no-op
 * (no move, no error, no feedback). Root cause: FileTreeProvider's drag-and-drop
 * controller only handled connection REORDER; a dragged file/folder wrote no
 * transfer data and handleDrop early-returned. Drag-to-move was never implemented.
 *
 * The unit suite (FileTreeProvider.test.ts "issue #18") pins the handleDrag /
 * handleDrop wiring with mocks. This proves the fix end-to-end by driving the REAL
 * FileTreeProvider.handleDrag -> handleDrop against real ssh2 connections and
 * asserting the file actually relocated on the servers:
 *   - same-host move (SFTP rename),
 *   - cross-host move (copy then delete source) — exactly the reporter's scenario,
 *   - cross-host folder move (recursive copy then delete source tree).
 *
 * Run: npm run test:docker
 */

import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { ConnectionManager } from '../connection/ConnectionManager';
import { FileTreeProvider, FileTreeItem } from '../providers/FileTreeProvider';
import { IHostConfig, IRemoteFile } from '../types';
import { SavedCredential, CredentialService } from '../services/CredentialService';

// Same Docker containers as docker-ssh-tools.test.ts. S1 + S3 = two distinct
// servers (S3 even has a different user) so the cross-host path is genuinely
// server-A -> server-B, like the report.
const S1 = { id: 'dnd-s1', label: 'hybr8-prod-web-01', host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' };
const S3 = { id: 'dnd-s3', label: 'hybr8-prod-db-01',  host: '127.0.0.1', port: 2203, username: 'admin',    password: 'adminpass' };

const _knownHosts: Record<string, unknown> = {};

function setupMocks(): void {
  setGlobalState({
    get: <T>(key: string, def?: T) => (_knownHosts[key] as T) ?? (def as T),
    update: async (k: string, v: unknown) => { _knownHosts[k] = v; },
    keys: () => Object.keys(_knownHosts),
  } as vscode.Memento);
  (CredentialService as any)._instance = undefined;
  (CredentialService as any)._instance = {
    getCredentialSecret: jest.fn().mockImplementation((_id: string, cid: string) =>
      Promise.resolve(cid.includes('s3') ? 'adminpass' : 'testpass')),
    getOrPrompt: jest.fn().mockResolvedValue('testpass'),
    initialize: jest.fn(),
  };
  (vscode.window.showInformationMessage as jest.Mock).mockResolvedValue('Yes, Connect');
  (vscode.window.showWarningMessage as jest.Mock).mockResolvedValue('Accept New Key');
  (vscode.window.showQuickPick as jest.Mock).mockResolvedValue('No, use only for this session');
}

async function mkConn(s: typeof S1): Promise<SSHConnection> {
  const host: IHostConfig = { id: s.id, name: s.label, host: s.host, port: s.port, username: s.username, source: 'saved' };
  const cred: SavedCredential = { id: s.id + '-pw', label: 'pw', type: 'password' };
  const c = new SSHConnection(host, cred);
  await c.connect();
  await new Promise((r) => setTimeout(r, 600));
  return c;
}

/** Build the FileTreeItem VS Code would hand to handleDrag/handleDrop. */
function fileItem(conn: SSHConnection, p: string, isDir: boolean): FileTreeItem {
  const file: IRemoteFile = {
    name: p.substring(p.lastIndexOf('/') + 1),
    path: p,
    isDirectory: isDir,
    size: 0,
    modifiedTime: Date.now(),
    connectionId: conn.id,
  };
  return new FileTreeItem(file, conn);
}

describe('issue #18 — drag-and-drop file move (e2e)', () => {
  let s1: SSHConnection;
  let s3: SSHConnection;
  let provider: FileTreeProvider;
  const stamp = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const baseDir1 = `/tmp/dnd_${stamp}_s1`;
  const baseDir3 = `/tmp/dnd_${stamp}_s3`;

  beforeAll(async () => {
    setupMocks();
    s1 = await mkConn(S1);
    s3 = await mkConn(S3);
    // Register both live connections so FileTreeProvider resolves them by id.
    const cm = ConnectionManager.getInstance() as any;
    cm._connections.set(s1.id, s1);
    cm._connections.set(s3.id, s3);
    provider = new FileTreeProvider();
    provider.setCurrentPath(s1.id, baseDir1);
    provider.setCurrentPath(s3.id, baseDir3);
    await s1.exec(`mkdir -p ${baseDir1}/src ${baseDir1}/dst`);
    await s3.exec(`mkdir -p ${baseDir3}/test`);
  }, 60000);

  afterAll(async () => {
    try { provider.dispose(); } catch { /* ignore */ }
    try { await s1.exec(`rm -rf ${baseDir1}`); } catch { /* ignore */ }
    try { await s3.exec(`rm -rf ${baseDir3}`); } catch { /* ignore */ }
    const cm = ConnectionManager.getInstance() as any;
    try { cm._connections.delete(s1.id); } catch { /* ignore */ }
    try { cm._connections.delete(s3.id); } catch { /* ignore */ }
    try { await s1.disconnect(); } catch { /* ignore */ }
    try { await s3.disconnect(); } catch { /* ignore */ }
  });

  it('moves a file into a folder on the SAME server (rename)', async () => {
    const src = `${baseDir1}/src/same.txt`;
    await s1.exec(`printf 'hello-same' > ${src}`);
    expect(await s1.fileExists(src)).toBe(true);

    const dt = new vscode.DataTransfer();
    provider.handleDrag([fileItem(s1, src, false)], dt, {} as any);
    await provider.handleDrop(fileItem(s1, `${baseDir1}/dst`, true), dt, {} as any);

    const moved = `${baseDir1}/dst/same.txt`;
    expect(await s1.fileExists(src)).toBe(false);   // source gone
    expect(await s1.fileExists(moved)).toBe(true);  // present at destination
    expect((await s1.readFile(moved)).toString()).toBe('hello-same');
  }, 30000);

  it('moves a file ACROSS servers — copy then delete source (the reporter scenario)', async () => {
    const src = `${baseDir1}/src/index-copy.html`;
    await s1.exec(`printf 'cross-server-move' > ${src}`);
    expect(await s1.fileExists(src)).toBe(true);

    const dt = new vscode.DataTransfer();
    provider.handleDrag([fileItem(s1, src, false)], dt, {} as any);
    await provider.handleDrop(fileItem(s3, `${baseDir3}/test`, true), dt, {} as any);

    const dest = `${baseDir3}/test/index-copy.html`;
    expect(await s1.fileExists(src)).toBe(false);   // source removed on S1
    expect(await s3.fileExists(dest)).toBe(true);    // landed on S3
    expect((await s3.readFile(dest)).toString()).toBe('cross-server-move');
  }, 30000);

  it('moves a folder across servers and removes the source tree', async () => {
    const srcDir = `${baseDir1}/src/bundle`;
    await s1.exec(`mkdir -p ${srcDir} && printf a > ${srcDir}/a.txt && printf b > ${srcDir}/b.txt`);

    const dt = new vscode.DataTransfer();
    provider.handleDrag([fileItem(s1, srcDir, true)], dt, {} as any);
    await provider.handleDrop(fileItem(s3, `${baseDir3}/test`, true), dt, {} as any);

    expect(await s1.fileExists(srcDir)).toBe(false);
    expect(await s3.fileExists(`${baseDir3}/test/bundle/a.txt`)).toBe(true);
    expect(await s3.fileExists(`${baseDir3}/test/bundle/b.txt`)).toBe(true);
    expect((await s3.readFile(`${baseDir3}/test/bundle/a.txt`)).toString()).toBe('a');
  }, 30000);

  it('does NOT move when dropped onto the folder the file already lives in', async () => {
    const src = `${baseDir1}/dst/stay.txt`;
    await s1.exec(`printf 'stay' > ${src}`);

    const dt = new vscode.DataTransfer();
    provider.handleDrag([fileItem(s1, src, false)], dt, {} as any);
    await provider.handleDrop(fileItem(s1, `${baseDir1}/dst`, true), dt, {} as any);

    // Still there, not renamed to a "copy" — the no-op guard held.
    expect(await s1.fileExists(src)).toBe(true);
    expect(await s1.fileExists(`${baseDir1}/dst/stay copy.txt`)).toBe(false);
  }, 30000);
});
