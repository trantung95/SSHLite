import * as vscode from 'vscode';

/**
 * Credential types
 */
export type CredentialType = 'password' | 'passphrase';

/**
 * Simple credential service - stores credentials automatically
 * No prompts, no profiles, just works.
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
   * Get storage key
   */
  private getKey(hostId: string, type: CredentialType): string {
    return `sshLite:${hostId}:${type}`;
  }

  /**
   * Get saved credential (returns immediately if saved, otherwise undefined)
   */
  async get(hostId: string, type: CredentialType): Promise<string | undefined> {
    const key = this.getKey(hostId, type);

    // Check session first
    const session = this.sessionCredentials.get(key);
    if (session) return session;

    // Check persistent storage
    if (this.secretStorage) {
      return await this.secretStorage.get(key);
    }

    return undefined;
  }

  /**
   * Save credential (always saves persistently for convenience)
   */
  async save(hostId: string, type: CredentialType, value: string): Promise<void> {
    const key = this.getKey(hostId, type);

    // Save to session
    this.sessionCredentials.set(key, value);

    // Save persistently
    if (this.secretStorage) {
      await this.secretStorage.store(key, value);
    }
  }

  /**
   * Delete credential
   */
  async delete(hostId: string, type: CredentialType): Promise<void> {
    const key = this.getKey(hostId, type);
    this.sessionCredentials.delete(key);
    if (this.secretStorage) {
      await this.secretStorage.delete(key);
    }
  }

  /**
   * Delete all credentials for a host
   */
  async deleteAll(hostId: string): Promise<void> {
    await this.delete(hostId, 'password');
    await this.delete(hostId, 'passphrase');
  }

  /**
   * Get credential - returns saved one or prompts user
   * Automatically saves for next time
   */
  async getOrPrompt(
    hostId: string,
    type: CredentialType,
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
   * Clear session credentials
   */
  clearSession(): void {
    this.sessionCredentials.clear();
  }

  dispose(): void {
    this.sessionCredentials.clear();
  }
}
