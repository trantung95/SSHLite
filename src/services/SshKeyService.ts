import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { SSHConnection } from '../connection/SSHConnection';

export interface KeyGenOptions {
  type: 'ed25519' | 'rsa';
  bits?: number;
  comment: string;
  passphrase: string;
  outFile: string;
}

export interface KeyGenResult {
  privateKeyPath: string;
  publicKeyPath: string;
}

/**
 * Local SSH-key generation + remote public-key install.
 */
export class SshKeyService {
  private static _instance: SshKeyService;

  private constructor() {}

  static getInstance(): SshKeyService {
    if (!SshKeyService._instance) {
      SshKeyService._instance = new SshKeyService();
    }
    return SshKeyService._instance;
  }

  /**
   * Generate a new SSH keypair using the local `ssh-keygen` binary.
   */
  async generateKey(options: KeyGenOptions): Promise<KeyGenResult> {
    const args: string[] = ['-t', options.type];
    if (options.type === 'rsa' && options.bits) {
      args.push('-b', String(options.bits));
    }
    args.push('-f', options.outFile);
    args.push('-C', options.comment || '');
    args.push('-N', options.passphrase || '');

    return new Promise((resolve, reject) => {
      const proc = spawn('ssh-keygen', args, { windowsHide: true });
      let stderr = '';
      proc.stderr?.on('data', (d) => { stderr += d.toString(); });
      proc.on('error', (err) => reject(new Error(`ssh-keygen failed to start: ${err.message}`)));
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ssh-keygen exited ${code}: ${stderr.trim()}`));
          return;
        }
        resolve({
          privateKeyPath: options.outFile,
          publicKeyPath: options.outFile + '.pub',
        });
      });
    });
  }

  /**
   * Default directory for generated keys.
   */
  defaultKeyDir(): string {
    return path.join(os.homedir(), '.ssh');
  }

  /**
   * Escape a path/string for safe use in single-quoted shell strings.
   */
  private esc(p: string): string {
    return p.replace(/'/g, "'\\''");
  }

  /**
   * Append a public key file to the remote ~/.ssh/authorized_keys.
   * Creates ~/.ssh with mode 700 and authorized_keys with mode 600 when needed.
   * Skips if the exact key line already exists.
   */
  async pushPublicKey(connection: SSHConnection, localPubKeyPath: string): Promise<{ added: boolean; reason?: string }> {
    if (!fs.existsSync(localPubKeyPath)) {
      throw new Error(`Public key not found: ${localPubKeyPath}`);
    }
    const pubContent = fs.readFileSync(localPubKeyPath, 'utf8').trim();
    if (!pubContent) {
      throw new Error('Public key file is empty');
    }

    const home = (await connection.exec('echo $HOME')).trim() || `/home/${connection.host.username}`;
    const sshDir = `${home}/.ssh`;
    const authFile = `${sshDir}/authorized_keys`;
    const escSshDir = this.esc(sshDir);
    const escAuthFile = this.esc(authFile);

    await connection.exec(`mkdir -p '${escSshDir}' && chmod 700 '${escSshDir}'`);

    let existing = '';
    try {
      existing = await connection.exec(`cat '${escAuthFile}' 2>/dev/null || true`);
    } catch {
      existing = '';
    }

    if (existing.split('\n').some((line) => line.trim() === pubContent)) {
      return { added: false, reason: 'Key already present in authorized_keys' };
    }

    const escLine = this.esc(pubContent);
    await connection.exec(`printf '%s\\n' '${escLine}' >> '${escAuthFile}' && chmod 600 '${escAuthFile}'`);
    return { added: true };
  }
}
