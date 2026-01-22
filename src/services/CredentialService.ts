import * as vscode from 'vscode';

/**
 * Credential types
 */
export type CredentialType = 'password' | 'privateKey';

/**
 * Pinned folder info
 */
export interface PinnedFolder {
  id: string;
  name: string;
  remotePath: string;
}

/**
 * Saved credential info
 */
export interface SavedCredential {
  id: string;
  label: string;
  type: CredentialType;
  // For privateKey type, this stores the path
  privateKeyPath?: string;
  // Pinned folders for this credential
  pinnedFolders?: PinnedFolder[];
}

/**
 * Credential index stored in settings (list of saved credentials per host)
 */
interface CredentialIndex {
  [hostId: string]: SavedCredential[];
}

/**
 * Credential service - manages multiple credentials per host
 * Supports password and private key authentication
 */
export class CredentialService {
  private static _instance: CredentialService;
  private secretStorage: vscode.SecretStorage | null = null;
  private sessionCredentials: Map<string, string> = new Map();

  private constructor() {}

  static getInstance(): CredentialService {
    if (!CredentialService._instance) {
      CredentialService._instance = new CredentialService();
    }
    return CredentialService._instance;
  }

  /**
   * Initialize with VS Code extension context
   */
  initialize(context: vscode.ExtensionContext): void {
    this.secretStorage = context.secrets;
  }

  /**
   * Get storage key for secret value
   */
  private getSecretKey(hostId: string, credentialId: string): string {
    return `sshLite:${hostId}:${credentialId}`;
  }

  /**
   * Get credential index from settings (deep cloned to avoid proxy issues)
   */
  private getCredentialIndex(): CredentialIndex {
    const config = vscode.workspace.getConfiguration('sshLite');
    const index = config.get<CredentialIndex>('credentialIndex', {});
    // Deep clone to avoid VS Code's proxy trap issues when modifying
    return JSON.parse(JSON.stringify(index));
  }

  /**
   * Save credential index to settings
   */
  private async saveCredentialIndex(index: CredentialIndex): Promise<void> {
    const config = vscode.workspace.getConfiguration('sshLite');
    await config.update('credentialIndex', index, vscode.ConfigurationTarget.Global);
  }

  /**
   * List all credentials for a host (synchronous - reads from local config)
   */
  listCredentials(hostId: string): SavedCredential[] {
    const index = this.getCredentialIndex();
    const credentials = index[hostId] || [];
    console.log(`[CredentialService] listCredentials(${hostId}): found ${credentials.length} credentials`);
    return credentials;
  }

  /**
   * Add a new credential for a host
   */
  async addCredential(
    hostId: string,
    label: string,
    type: CredentialType,
    value: string,
    privateKeyPath?: string
  ): Promise<SavedCredential> {
    console.log(`[CredentialService] addCredential: hostId=${hostId}, label=${label}, type=${type}`);
    const index = this.getCredentialIndex();
    console.log(`[CredentialService] Current index for host: ${JSON.stringify(index[hostId] || [])}`);
    if (!index[hostId]) {
      index[hostId] = [];
    }

    // Generate unique ID
    const id = `cred_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    console.log(`[CredentialService] Generated credential ID: ${id}`);

    const credential: SavedCredential = {
      id,
      label,
      type,
      privateKeyPath,
    };

    // Store the secret value (password or passphrase)
    const secretKey = this.getSecretKey(hostId, id);
    if (this.secretStorage) {
      await this.secretStorage.store(secretKey, value);
      console.log(`[CredentialService] Stored secret in secretStorage`);
    }
    this.sessionCredentials.set(secretKey, value);

    // Add to index
    index[hostId].push(credential);
    console.log(`[CredentialService] Index after push: ${JSON.stringify(index[hostId])}`);
    await this.saveCredentialIndex(index);
    console.log(`[CredentialService] Index saved successfully`);

    return credential;
  }

  /**
   * Get secret value for a credential
   */
  async getCredentialSecret(hostId: string, credentialId: string): Promise<string | undefined> {
    const secretKey = this.getSecretKey(hostId, credentialId);

    // Check session first
    const session = this.sessionCredentials.get(secretKey);
    if (session) return session;

    // Check persistent storage
    if (this.secretStorage) {
      return await this.secretStorage.get(secretKey);
    }

    return undefined;
  }

  /**
   * Store credential in session only (not persisted)
   */
  setSessionCredential(hostId: string, credentialId: string, secret: string): void {
    const secretKey = this.getSecretKey(hostId, credentialId);
    this.sessionCredentials.set(secretKey, secret);
  }

  /**
   * Delete a specific credential
   */
  async deleteCredential(hostId: string, credentialId: string): Promise<void> {
    const index = this.getCredentialIndex();
    if (index[hostId]) {
      index[hostId] = index[hostId].filter((c) => c.id !== credentialId);
      if (index[hostId].length === 0) {
        delete index[hostId];
      }
      await this.saveCredentialIndex(index);
    }

    // Delete secret
    const secretKey = this.getSecretKey(hostId, credentialId);
    this.sessionCredentials.delete(secretKey);
    if (this.secretStorage) {
      await this.secretStorage.delete(secretKey);
    }
  }

  /**
   * Update the password for an existing credential
   */
  async updateCredentialPassword(hostId: string, credentialId: string, newPassword: string): Promise<void> {
    const secretKey = this.getSecretKey(hostId, credentialId);

    // Update in session cache
    this.sessionCredentials.set(secretKey, newPassword);

    // Update in secure storage
    if (this.secretStorage) {
      await this.secretStorage.store(secretKey, newPassword);
    }
  }

  /**
   * Delete all credentials for a host
   */
  async deleteAll(hostId: string): Promise<void> {
    const credentials = this.listCredentials(hostId);
    for (const cred of credentials) {
      await this.deleteCredential(hostId, cred.id);
    }
  }

  /**
   * Get saved credential (legacy - returns first password credential)
   * For backward compatibility with existing auth flow
   */
  async get(hostId: string, type: 'password' | 'passphrase'): Promise<string | undefined> {
    const credentials = this.listCredentials(hostId);
    const cred = credentials.find((c) => c.type === 'password');
    if (cred) {
      return await this.getCredentialSecret(hostId, cred.id);
    }
    return undefined;
  }

  /**
   * Save credential (legacy - creates/updates default password credential)
   * For backward compatibility
   */
  async save(hostId: string, type: 'password' | 'passphrase', value: string): Promise<void> {
    const credentials = this.listCredentials(hostId);
    const existing = credentials.find((c) => c.type === 'password' && c.label === 'Default');

    if (existing) {
      // Update existing
      const secretKey = this.getSecretKey(hostId, existing.id);
      if (this.secretStorage) {
        await this.secretStorage.store(secretKey, value);
      }
      this.sessionCredentials.set(secretKey, value);
    } else {
      // Create new default credential
      await this.addCredential(hostId, 'Default', 'password', value);
    }
  }

  /**
   * Get credential - returns saved one or prompts user
   * Automatically saves for next time (legacy compatibility)
   */
  async getOrPrompt(
    hostId: string,
    type: 'password' | 'passphrase',
    prompt: string
  ): Promise<string | undefined> {
    // Try to get saved credential
    const saved = await this.get(hostId, type);
    if (saved) return saved;

    // Prompt user
    const value = await vscode.window.showInputBox({
      prompt,
      password: true,
      ignoreFocusOut: true,
    });

    if (value) {
      // Auto-save for next time
      await this.save(hostId, type, value);
    }

    return value;
  }

  /**
   * Add a pinned folder to a credential
   */
  async addPinnedFolder(
    hostId: string,
    credentialId: string,
    name: string,
    remotePath: string
  ): Promise<PinnedFolder> {
    const index = this.getCredentialIndex();
    const credentials = index[hostId];
    if (!credentials) {
      throw new Error('Host not found');
    }

    const credential = credentials.find((c) => c.id === credentialId);
    if (!credential) {
      throw new Error('Credential not found');
    }

    // Initialize pinned folders array if needed
    if (!credential.pinnedFolders) {
      credential.pinnedFolders = [];
    }

    // Generate unique ID
    const id = `pin_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    const pinnedFolder: PinnedFolder = {
      id,
      name,
      remotePath,
    };

    credential.pinnedFolders.push(pinnedFolder);
    await this.saveCredentialIndex(index);

    return pinnedFolder;
  }

  /**
   * Delete a pinned folder from a credential
   */
  async deletePinnedFolder(hostId: string, credentialId: string, folderId: string): Promise<void> {
    const index = this.getCredentialIndex();
    const credentials = index[hostId];
    if (!credentials) return;

    const credential = credentials.find((c) => c.id === credentialId);
    if (!credential || !credential.pinnedFolders) return;

    credential.pinnedFolders = credential.pinnedFolders.filter((f) => f.id !== folderId);
    await this.saveCredentialIndex(index);
  }

  /**
   * Rename a pinned folder
   */
  async renamePinnedFolder(
    hostId: string,
    credentialId: string,
    folderId: string,
    newName: string
  ): Promise<void> {
    const index = this.getCredentialIndex();
    const credentials = index[hostId];
    if (!credentials) return;

    const credential = credentials.find((c) => c.id === credentialId);
    if (!credential || !credential.pinnedFolders) return;

    const folder = credential.pinnedFolders.find((f) => f.id === folderId);
    if (folder) {
      folder.name = newName;
      await this.saveCredentialIndex(index);
    }
  }

  /**
   * Get pinned folders for a credential
   */
  getPinnedFolders(hostId: string, credentialId: string): PinnedFolder[] {
    const credentials = this.listCredentials(hostId);
    const credential = credentials.find((c) => c.id === credentialId);
    return credential?.pinnedFolders || [];
  }

  /**
   * Clear session credentials
   */
  clearSession(): void {
    this.sessionCredentials.clear();
  }

  dispose(): void {
    this.sessionCredentials.clear();
  }
}
