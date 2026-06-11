import * as vscode from 'vscode';
import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  DRIVE_SCOPE,
  AUTH_ENDPOINT,
  TOKEN_ENDPOINT,
  REVOKE_ENDPOINT,
  DRIVE_API,
  DRIVE_UPLOAD_API,
  isDriveConfigured,
} from '../sync/googleClient';
import { runLoopbackAuth, tokenExchangeParams, refreshParams } from '../sync/googleOAuth';
import { infoLog } from '../utils/diagnosticLog';

interface TokenBundle {
  accessToken?: string;
  refreshToken: string;
  /** Epoch ms when the access token expires. */
  expiry: number;
}

const TOKEN_KEY = 'sshLite:googleDrive:tokens';
const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded' };
/** Refresh slightly early to avoid using an about-to-expire token. */
const EXPIRY_SKEW_MS = 60_000;

/**
 * Native Google Drive sync for connections (issue #11, Phase B).
 *
 * Implements the loopback + PKCE Desktop-app OAuth flow and the minimal Drive
 * REST calls needed to keep ONE small JSON file (the connections export) in
 * sync — all via global `fetch` (no `googleapis` dependency). Tokens live in
 * VS Code SecretStorage; the access token is refreshed on demand and on 401.
 * Only the `drive.file` scope is used, so the app can touch only the file it
 * created.
 */
export class GoogleDriveSyncService {
  private static _instance: GoogleDriveSyncService;
  private secrets: vscode.SecretStorage | null = null;

  private constructor() {}

  static getInstance(): GoogleDriveSyncService {
    if (!GoogleDriveSyncService._instance) {
      GoogleDriveSyncService._instance = new GoogleDriveSyncService();
    }
    return GoogleDriveSyncService._instance;
  }

  initialize(secrets: vscode.SecretStorage): void {
    this.secrets = secrets;
  }

  /** True once the build carries a real OAuth client (see googleClient.ts). */
  isConfigured(): boolean {
    return isDriveConfigured();
  }

  async isSignedIn(): Promise<boolean> {
    const bundle = await this.readTokens();
    return !!bundle?.refreshToken;
  }

  // ─── OAuth ────────────────────────────────────────────────────────────

  /**
   * Interactive sign-in: loopback + PKCE consent, then exchange the auth code
   * for tokens and persist them.
   */
  async signIn(openExternal: (url: string) => Promise<void>): Promise<void> {
    this.assertConfigured();
    infoLog('drive-sync', 'signin-start', {});

    const { code, codeVerifier, redirectUri } = await runLoopbackAuth({
      authEndpoint: AUTH_ENDPOINT,
      clientId: GOOGLE_CLIENT_ID,
      scope: DRIVE_SCOPE,
      openExternal,
    });

    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: tokenExchangeParams({
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        code,
        codeVerifier,
        redirectUri,
      }),
    });
    if (!res.ok) {
      throw new Error(`Google token exchange failed (HTTP ${res.status}).`);
    }
    const data = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
    if (!data.refresh_token) {
      throw new Error('Google did not return a refresh token. Try again and approve offline access.');
    }
    await this.writeTokens({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiry: Date.now() + (data.expires_in || 3600) * 1000,
    });
    infoLog('drive-sync', 'signin-done', {});
  }

  /** Revoke the refresh token (best-effort) and clear local tokens. */
  async signOut(): Promise<void> {
    const bundle = await this.readTokens();
    if (bundle?.refreshToken) {
      try {
        await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(bundle.refreshToken)}`, {
          method: 'POST',
          headers: FORM_HEADERS,
        });
      } catch {
        // Revocation is best-effort; clearing local tokens is what matters.
      }
    }
    await this.clearTokens();
    infoLog('drive-sync', 'signout', {});
  }

  // ─── Drive operations ───────────────────────────────────────────────────

  /** Create or overwrite the synced connections file with `json`. */
  async push(json: string): Promise<void> {
    this.assertConfigured();
    const fileName = this.fileName();
    const fileId = await this.findFileId(fileName);

    if (fileId) {
      const res = await this.driveFetch(
        `${DRIVE_UPLOAD_API}/files/${fileId}?uploadType=media`,
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: json }
      );
      if (!res.ok) {
        throw new Error(`Drive update failed (HTTP ${res.status}).`);
      }
      infoLog('drive-sync', 'push-update', { fileId });
      return;
    }

    const boundary = `sshlite_${Math.random().toString(36).slice(2)}`;
    const metadata = JSON.stringify({ name: fileName, mimeType: 'application/json' });
    const body =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${metadata}\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: application/json\r\n\r\n' +
      `${json}\r\n` +
      `--${boundary}--`;
    const res = await this.driveFetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary="${boundary}"` },
      body,
    });
    if (!res.ok) {
      throw new Error(`Drive upload failed (HTTP ${res.status}).`);
    }
    infoLog('drive-sync', 'push-create', {});
  }

  /** Download the synced file's content, or undefined if it does not exist. */
  async pull(): Promise<string | undefined> {
    this.assertConfigured();
    const fileId = await this.findFileId(this.fileName());
    if (!fileId) {
      infoLog('drive-sync', 'pull-absent', {});
      return undefined;
    }
    const res = await this.driveFetch(`${DRIVE_API}/files/${fileId}?alt=media`, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Drive download failed (HTTP ${res.status}).`);
    }
    infoLog('drive-sync', 'pull-done', { fileId });
    return await res.text();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private fileName(): string {
    return vscode.workspace
      .getConfiguration('sshLite')
      .get<string>('googleDrive.fileName', 'sshlite-connections.json');
  }

  /** Find the app-created file by name (drive.file scope sees only its own). */
  private async findFileId(name: string): Promise<string | undefined> {
    const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and trashed=false`);
    const res = await this.driveFetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)&spaces=drive`, {
      method: 'GET',
    });
    if (!res.ok) {
      throw new Error(`Drive lookup failed (HTTP ${res.status}).`);
    }
    const data = (await res.json()) as { files?: Array<{ id: string }> };
    return data.files && data.files.length ? data.files[0].id : undefined;
  }

  /**
   * Fetch a Drive endpoint with a valid bearer token, refreshing once and
   * retrying if the server answers 401.
   */
  private async driveFetch(url: string, init: { method: string; headers?: Record<string, string>; body?: string }): Promise<Response> {
    let token = await this.ensureAccessToken();
    let res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    if (res.status === 401) {
      token = await this.refreshAccessToken();
      res = await fetch(url, { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
    }
    return res;
  }

  /** Return a non-expired access token, refreshing if needed. */
  private async ensureAccessToken(): Promise<string> {
    const bundle = await this.readTokens();
    if (!bundle?.refreshToken) {
      throw new Error('Not signed in to Google Drive.');
    }
    if (bundle.accessToken && bundle.expiry - EXPIRY_SKEW_MS > Date.now()) {
      return bundle.accessToken;
    }
    return await this.refreshAccessToken();
  }

  private async refreshAccessToken(): Promise<string> {
    const bundle = await this.readTokens();
    if (!bundle?.refreshToken) {
      throw new Error('Not signed in to Google Drive.');
    }
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: FORM_HEADERS,
      body: refreshParams({
        clientId: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        refreshToken: bundle.refreshToken,
      }),
    });
    if (!res.ok) {
      throw new Error(`Google token refresh failed (HTTP ${res.status}). You may need to reconnect Google Drive.`);
    }
    const data = (await res.json()) as { access_token: string; expires_in: number };
    await this.writeTokens({
      accessToken: data.access_token,
      refreshToken: bundle.refreshToken,
      expiry: Date.now() + (data.expires_in || 3600) * 1000,
    });
    return data.access_token;
  }

  private assertConfigured(): void {
    if (!this.isConfigured()) {
      throw new Error(
        'Google Drive sync is not configured in this build of SSH Lite. (No OAuth client provisioned.)'
      );
    }
  }

  private async readTokens(): Promise<TokenBundle | undefined> {
    if (!this.secrets) {
      return undefined;
    }
    const raw = await this.secrets.get(TOKEN_KEY);
    if (!raw) {
      return undefined;
    }
    try {
      return JSON.parse(raw) as TokenBundle;
    } catch {
      return undefined;
    }
  }

  private async writeTokens(bundle: TokenBundle): Promise<void> {
    if (this.secrets) {
      await this.secrets.store(TOKEN_KEY, JSON.stringify(bundle));
    }
  }

  private async clearTokens(): Promise<void> {
    if (this.secrets) {
      await this.secrets.delete(TOKEN_KEY);
    }
  }
}
