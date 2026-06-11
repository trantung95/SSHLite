/**
 * Tests for the pure Google OAuth2 helpers (issue #11, Phase B).
 * Loopback + PKCE (S256) flow for a Desktop client. The network-bound
 * loopback server is exercised separately; here we lock down the pure,
 * security-critical pieces: PKCE derivation and request shaping.
 */

import {
  base64url,
  createVerifier,
  challengeS256,
  buildAuthUrl,
  tokenExchangeParams,
  refreshParams,
} from './googleOAuth';

describe('googleOAuth — PKCE', () => {
  it('base64url has no +, / or = padding', () => {
    const s = base64url(Buffer.from([0xfb, 0xff, 0xfe, 0x00]));
    expect(s).not.toMatch(/[+/=]/);
  });

  it('createVerifier returns a 43-128 char RFC 7636 string', () => {
    const v = createVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it('challengeS256 matches the RFC 7636 Appendix B test vector', () => {
    // RFC 7636 Appendix B canonical verifier -> challenge.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(challengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });
});

describe('googleOAuth — buildAuthUrl', () => {
  const url = buildAuthUrl({
    authEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    clientId: 'cid.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:51234',
    scope: 'https://www.googleapis.com/auth/drive.file',
    state: 'st-123',
    codeChallenge: 'chal-abc',
  });
  const q = new URL(url).searchParams;

  it('requests an auth code with S256 PKCE and offline access', () => {
    expect(url.startsWith('https://accounts.google.com/o/oauth2/v2/auth?')).toBe(true);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('cid.apps.googleusercontent.com');
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:51234');
    expect(q.get('scope')).toBe('https://www.googleapis.com/auth/drive.file');
    expect(q.get('code_challenge')).toBe('chal-abc');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe('st-123');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('prompt')).toBe('consent');
  });
});

describe('googleOAuth — token request bodies', () => {
  it('tokenExchangeParams carries code, verifier, secret and authorization_code grant', () => {
    const body = tokenExchangeParams({
      clientId: 'cid',
      clientSecret: 'sec',
      code: 'auth-code',
      codeVerifier: 'ver',
      redirectUri: 'http://127.0.0.1:51234',
    });
    const p = new URLSearchParams(body);
    expect(p.get('grant_type')).toBe('authorization_code');
    expect(p.get('client_id')).toBe('cid');
    expect(p.get('client_secret')).toBe('sec');
    expect(p.get('code')).toBe('auth-code');
    expect(p.get('code_verifier')).toBe('ver');
    expect(p.get('redirect_uri')).toBe('http://127.0.0.1:51234');
  });

  it('refreshParams uses the refresh_token grant', () => {
    const body = refreshParams({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });
    const p = new URLSearchParams(body);
    expect(p.get('grant_type')).toBe('refresh_token');
    expect(p.get('client_id')).toBe('cid');
    expect(p.get('client_secret')).toBe('sec');
    expect(p.get('refresh_token')).toBe('rt');
  });
});
