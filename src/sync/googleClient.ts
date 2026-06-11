/**
 * Google OAuth2 + Drive constants for connection sync (issue #11, Phase B).
 *
 * SSH Lite registers as a Google **Desktop app** OAuth client. For a desktop
 * client the "client secret" is NOT confidential — it ships inside every copy
 * of the extension and Google treats it as such. PKCE (S256) is the real
 * protection, so binding the auth code to a per-flow code_verifier is what
 * keeps the flow safe. See .adn/features/connection-portability.md.
 *
 * SETUP (one-time, by the project owner — until done, Drive sync is disabled
 * and the commands explain why):
 *   1. Google Cloud Console -> new project -> enable the Google Drive API.
 *   2. Create an OAuth client of type "Desktop app".
 *   3. Consent screen: add ONLY the drive.file scope (non-sensitive -> no CASA
 *      security assessment) and publish to "In production" (while in Testing,
 *      Google expires refresh tokens after 7 days).
 *   4. Paste the client id/secret below.
 */

/** Placeholder marker — replace when the Google Cloud client is provisioned. */
const PLACEHOLDER = '__SET_ME__';

export const GOOGLE_CLIENT_ID = PLACEHOLDER;
export const GOOGLE_CLIENT_SECRET = PLACEHOLDER;

/**
 * Least-privilege scope: the app may only touch files it created. The synced
 * connections file is visible in the user's Drive. Non-sensitive scope.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

/** True once a real Google Cloud OAuth client has been wired in. */
export function isDriveConfigured(): boolean {
  return GOOGLE_CLIENT_ID !== PLACEHOLDER && GOOGLE_CLIENT_SECRET !== PLACEHOLDER;
}
