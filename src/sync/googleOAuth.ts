/**
 * Google OAuth2 helpers for the loopback + PKCE (S256) Desktop-app flow
 * (issue #11, Phase B). The pure functions (PKCE derivation, URL/body shaping)
 * are unit-tested; {@link runLoopbackAuth} drives the one-shot local HTTP
 * callback server.
 */

import * as crypto from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';

/** Base64url-encode without padding (RFC 7636 / 4648 §5). */
export function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Random PKCE code_verifier (43 chars, RFC 7636 unreserved alphabet). */
export function createVerifier(): string {
  return base64url(crypto.randomBytes(32));
}

/** code_challenge = BASE64URL(SHA256(ascii(verifier))). */
export function challengeS256(verifier: string): string {
  return base64url(crypto.createHash('sha256').update(verifier).digest());
}

/** Random anti-CSRF state value. */
export function createState(): string {
  return base64url(crypto.randomBytes(16));
}

export interface AuthUrlOptions {
  authEndpoint: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
}

/** Build the authorization-request URL (offline access + S256 PKCE). */
export function buildAuthUrl(opts: AuthUrlOptions): string {
  const q = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: opts.scope,
    code_challenge: opts.codeChallenge,
    code_challenge_method: 'S256',
    state: opts.state,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${opts.authEndpoint}?${q.toString()}`;
}

/** Form body for the authorization_code -> tokens exchange. */
export function tokenExchangeParams(opts: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): string {
  return new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code: opts.code,
    code_verifier: opts.codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: opts.redirectUri,
  }).toString();
}

/** Form body for the refresh_token -> access_token exchange. */
export function refreshParams(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): string {
  return new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    refresh_token: opts.refreshToken,
    grant_type: 'refresh_token',
  }).toString();
}

const CALLBACK_HTML =
  '<!doctype html><html><body style="font-family:sans-serif;padding:2rem">' +
  '<h2>SSH Lite</h2><p>Google sign-in complete. You can close this tab and return to VS Code.</p>' +
  '</body></html>';

export interface LoopbackAuthOptions {
  authEndpoint: string;
  clientId: string;
  scope: string;
  /** Opens the consent URL in the user's browser (vscode.env.openExternal). */
  openExternal: (url: string) => Promise<void>;
  /** Abort if the user never completes consent (ms). */
  timeoutMs?: number;
}

export interface LoopbackAuthResult {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/**
 * Run the loopback authorization step: start a one-shot HTTP server on
 * 127.0.0.1:<ephemeral>, open the consent URL, and resolve with the returned
 * auth code once the browser redirects back. Validates the anti-CSRF state.
 */
export function runLoopbackAuth(opts: LoopbackAuthOptions): Promise<LoopbackAuthResult> {
  const codeVerifier = createVerifier();
  const codeChallenge = challengeS256(codeVerifier);
  const state = createState();
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;

  return new Promise<LoopbackAuthResult>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      try {
        const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
        // Ignore favicon and any non-callback noise.
        if (!reqUrl.searchParams.has('code') && !reqUrl.searchParams.has('error')) {
          res.writeHead(204);
          res.end();
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(CALLBACK_HTML);

        const error = reqUrl.searchParams.get('error');
        const code = reqUrl.searchParams.get('code');
        const returnedState = reqUrl.searchParams.get('state');
        cleanup();
        if (error) {
          reject(new Error(`Google sign-in was denied (${error}).`));
          return;
        }
        if (returnedState !== state) {
          reject(new Error('Google sign-in failed: state mismatch (possible CSRF).'));
          return;
        }
        if (!code) {
          reject(new Error('Google sign-in failed: no authorization code returned.'));
          return;
        }
        resolve({ code, codeVerifier, redirectUri });
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });

    let redirectUri = '';
    let timer: NodeJS.Timeout | undefined;
    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      server.close();
    };

    server.on('error', (err) => {
      cleanup();
      reject(err);
    });

    // Bind to loopback only, ephemeral port.
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      redirectUri = `http://127.0.0.1:${port}`;
      const authUrl = buildAuthUrl({
        authEndpoint: opts.authEndpoint,
        clientId: opts.clientId,
        redirectUri,
        scope: opts.scope,
        state,
        codeChallenge,
      });
      timer = setTimeout(() => {
        cleanup();
        reject(new Error('Google sign-in timed out.'));
      }, timeoutMs);
      if (timer.unref) {
        timer.unref();
      }
      opts.openExternal(authUrl).catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  });
}
