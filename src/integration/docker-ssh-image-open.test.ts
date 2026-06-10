/**
 * Docker integration test for issue #12 — selecting a photo on the server
 * opened "a strange page" (raw image bytes rendered by the text editor).
 *
 * Fix: openRemoteFile() detects images by extension, downloads the FULL file
 * (no placeholder / progressive partial download — partial bytes corrupt an
 * image), and opens it via the `vscode.open` command so VS Code uses its
 * built-in image viewer instead of showTextDocument.
 *
 * The unit suite (FileService.image.test.ts) proves the routing with mocks.
 * This closes the gap against a REAL ssh2/SFTP connection: it writes real
 * binary image bytes to the server, opens them through the real FileService,
 * and verifies the FULL bytes survived the SFTP round-trip (SHA256 of the
 * on-disk temp file equals the source) and that VS Code was asked to open the
 * image viewer, never the text editor. The >=1MB case exercises real SFTP
 * binary chunking through the image path.
 *
 * Run: npm run test:docker
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { SSHConnection, setGlobalState } from '../connection/SSHConnection';
import { IHostConfig, IRemoteFile } from '../types';
import { SavedCredential, CredentialService } from '../services/CredentialService';
import { FileService } from '../services/FileService';

const WEB = { id: 'img-web', label: 'hybr8-prod-web-01', host: '127.0.0.1', port: 2201, username: 'testuser', password: 'testpass' };
const REMOTE_DIR = '/home/testuser/issue12-images';

// Minimal valid 1x1 PNG header + body (real PNG bytes, < 1MB → silent path)
const SMALL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

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
  const host: IHostConfig = { id: WEB.id, name: WEB.label, host: WEB.host, port: WEB.port, username: WEB.username, source: 'saved' };
  const cred: SavedCredential = { id: WEB.id + '-pw', label: 'pw', type: 'password' };
  const c = new SSHConnection(host, cred);
  await c.connect();
  await new Promise((r) => setTimeout(r, 300));
  return c;
}

function vscodeOpenCalls(): unknown[][] {
  return (vscode.commands.executeCommand as jest.Mock).mock.calls.filter((c) => c[0] === 'vscode.open');
}

describe('issue #12 image open in image viewer — docker integration', () => {
  let conn: SSHConnection;
  let service: FileService;

  beforeAll(async () => {
    setupMocks();
    conn = await mkConn();
    await conn.exec(`rm -rf ${REMOTE_DIR} && mkdir -p ${REMOTE_DIR}`);
    service = FileService.getInstance();
  }, 60000);

  afterAll(async () => {
    try { await conn.exec(`rm -rf ${REMOTE_DIR}`); } catch { /* ignore */ }
    try { await conn.disconnect(); } catch { /* ignore */ }
  });

  beforeEach(() => {
    (vscode.commands.executeCommand as jest.Mock).mockClear();
    (vscode.window.showTextDocument as jest.Mock).mockClear();
    (vscode.workspace.openTextDocument as jest.Mock).mockClear();
  });

  it('downloads a real PNG in full and opens the image viewer (not the text editor)', async () => {
    const remotePath = `${REMOTE_DIR}/photo.png`;
    await conn.writeFile(remotePath, SMALL_PNG);
    const sourceSha = crypto.createHash('sha256').update(SMALL_PNG).digest('hex');

    const remoteFile: IRemoteFile = {
      name: 'photo.png',
      path: remotePath,
      isDirectory: false,
      size: SMALL_PNG.length,
      modifiedTime: Date.now(),
      connectionId: conn.id,
    };

    await service.openRemoteFile(conn, remoteFile);

    // Opened via vscode.open (image viewer), never the text editor
    expect(vscodeOpenCalls()).toHaveLength(1);
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();
    expect(vscode.workspace.openTextDocument).not.toHaveBeenCalled();

    // The FULL bytes survived the SFTP round-trip: temp file SHA256 == source
    const localPath = service.getLocalFilePath(conn.id, remotePath);
    const onDisk = fs.readFileSync(localPath);
    expect(crypto.createHash('sha256').update(onDisk).digest('hex')).toBe(sourceSha);

    await conn.deleteFile(remotePath).catch(() => undefined);
    try { fs.unlinkSync(localPath); } catch { /* ignore */ }
  }, 30000);

  it('a >=1MB image downloads in full (real SFTP binary chunking) with byte integrity', async () => {
    const remotePath = `${REMOTE_DIR}/big.jpg`;
    // 1.5MB of deterministic random bytes — not a valid JPEG, but isImageFile
    // keys on the extension, and we only assert byte integrity + routing here.
    const bytes = crypto.randomBytes(1_500_000);
    await conn.writeFile(remotePath, bytes);
    const sourceSha = crypto.createHash('sha256').update(bytes).digest('hex');

    const remoteFile: IRemoteFile = {
      name: 'big.jpg',
      path: remotePath,
      isDirectory: false,
      size: bytes.length,
      modifiedTime: Date.now(),
      connectionId: conn.id,
    };

    await service.openRemoteFile(conn, remoteFile);

    // >=1MB shows a progress notification while downloading
    expect(vscode.window.withProgress).toHaveBeenCalled();
    expect(vscodeOpenCalls()).toHaveLength(1);
    expect(vscode.window.showTextDocument).not.toHaveBeenCalled();

    const localPath = service.getLocalFilePath(conn.id, remotePath);
    const onDisk = fs.readFileSync(localPath);
    expect(onDisk.length).toBe(bytes.length);
    expect(crypto.createHash('sha256').update(onDisk).digest('hex')).toBe(sourceSha);

    await conn.deleteFile(remotePath).catch(() => undefined);
    try { fs.unlinkSync(localPath); } catch { /* ignore */ }
  }, 30000);
});
