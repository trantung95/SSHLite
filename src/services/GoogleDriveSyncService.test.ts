/**
 * GoogleDriveSyncService tests (issue #11, Phase B). Drive REST + OAuth token
 * lifecycle, with global fetch and the loopback step mocked. Verifies:
 *  - sign-in exchanges the auth code and stores tokens in SecretStorage
 *  - push creates a new file or overwrites the existing one
 *  - pull downloads content (alt=media) or returns undefined when absent
 *  - a 401 triggers a refresh-then-retry
 *  - sign-out revokes and clears the stored tokens
 */

import { createMockExtensionContext, clearMockConfig } from '../__mocks__/vscode';

// Pretend the Google Cloud client is provisioned.
jest.mock('../sync/googleClient', () => {
  const actual = jest.requireActual('../sync/googleClient');
  return {
    ...actual,
    GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
    GOOGLE_CLIENT_SECRET: 'test-secret',
    isDriveConfigured: () => true,
  };
});

// Keep the pure helpers real; stub only the network-bound loopback step.
jest.mock('../sync/googleOAuth', () => {
  const actual = jest.requireActual('../sync/googleOAuth');
  return { ...actual, runLoopbackAuth: jest.fn() };
});

import { GoogleDriveSyncService } from './GoogleDriveSyncService';
import { runLoopbackAuth } from '../sync/googleOAuth';

const TOKEN_KEY = 'sshLite:googleDrive:tokens';

function jsonRes(obj: unknown, status = 200): any {
  return { ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}
function textRes(text: string, status = 200): any {
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

describe('GoogleDriveSyncService', () => {
  let service: GoogleDriveSyncService;
  let secrets: ReturnType<typeof createMockExtensionContext>['secrets'];
  let fetchMock: jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();
    clearMockConfig();
    (GoogleDriveSyncService as any)._instance = undefined;
    secrets = createMockExtensionContext().secrets;
    service = GoogleDriveSyncService.getInstance();
    service.initialize(secrets as unknown as Parameters<typeof service.initialize>[0]);
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  // Seed a valid (non-expired) access token so Drive calls skip the refresh.
  async function seedValidToken(): Promise<void> {
    await secrets.store(
      TOKEN_KEY,
      JSON.stringify({ accessToken: 'AT', refreshToken: 'RT', expiry: Date.now() + 3600_000 })
    );
  }

  describe('signIn', () => {
    it('exchanges the auth code and stores the tokens', async () => {
      (runLoopbackAuth as jest.Mock).mockResolvedValueOnce({
        code: 'auth-code',
        codeVerifier: 'ver',
        redirectUri: 'http://127.0.0.1:50000',
      });
      fetchMock.mockResolvedValueOnce(jsonRes({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }));

      await service.signIn(async () => {});

      expect(await service.isSignedIn()).toBe(true);
      // The token exchange hit the token endpoint with an authorization_code grant.
      const [tokenUrl, init] = fetchMock.mock.calls[0];
      expect(tokenUrl).toBe('https://oauth2.googleapis.com/token');
      expect(String(init.body)).toContain('grant_type=authorization_code');
      expect(String(init.body)).toContain('code_verifier=ver');
      const stored = JSON.parse((await secrets.get(TOKEN_KEY)) as string);
      expect(stored.refreshToken).toBe('RT');
    });
  });

  describe('push', () => {
    it('creates a new file via multipart upload when none exists', async () => {
      await seedValidToken();
      fetchMock
        .mockResolvedValueOnce(jsonRes({ files: [] })) // files.list -> none
        .mockResolvedValueOnce(jsonRes({ id: 'NEW' })); // multipart create

      await service.push('{"hello":"world"}');

      const [listUrl] = fetchMock.mock.calls[0];
      expect(listUrl).toContain('/drive/v3/files');
      const [createUrl, createInit] = fetchMock.mock.calls[1];
      expect(createUrl).toContain('/upload/drive/v3/files');
      expect(createUrl).toContain('uploadType=multipart');
      expect(createInit.method).toBe('POST');
      expect(createInit.headers.Authorization).toBe('Bearer AT');
      expect(String(createInit.headers['Content-Type'])).toContain('multipart/related');
    });

    it('overwrites the existing file content with a media PATCH', async () => {
      await seedValidToken();
      fetchMock
        .mockResolvedValueOnce(jsonRes({ files: [{ id: 'F1', name: 'sshlite-connections.json' }] }))
        .mockResolvedValueOnce(jsonRes({ id: 'F1' }));

      await service.push('{"a":1}');

      const [updateUrl, updateInit] = fetchMock.mock.calls[1];
      expect(updateUrl).toContain('/upload/drive/v3/files/F1');
      expect(updateUrl).toContain('uploadType=media');
      expect(updateInit.method).toBe('PATCH');
      expect(updateInit.body).toBe('{"a":1}');
    });
  });

  describe('pull', () => {
    it('downloads the file content with alt=media', async () => {
      await seedValidToken();
      fetchMock
        .mockResolvedValueOnce(jsonRes({ files: [{ id: 'F1', name: 'sshlite-connections.json' }] }))
        .mockResolvedValueOnce(textRes('{"from":"drive"}'));

      const content = await service.pull();

      expect(content).toBe('{"from":"drive"}');
      const [getUrl] = fetchMock.mock.calls[1];
      expect(getUrl).toContain('/drive/v3/files/F1');
      expect(getUrl).toContain('alt=media');
    });

    it('returns undefined when no synced file exists yet', async () => {
      await seedValidToken();
      fetchMock.mockResolvedValueOnce(jsonRes({ files: [] }));

      expect(await service.pull()).toBeUndefined();
    });
  });

  describe('token refresh', () => {
    it('refreshes the access token and retries after a 401', async () => {
      // Stored token is expired -> forces a refresh before the first Drive call.
      await secrets.store(
        TOKEN_KEY,
        JSON.stringify({ accessToken: 'OLD', refreshToken: 'RT', expiry: Date.now() - 1000 })
      );
      fetchMock
        .mockResolvedValueOnce(jsonRes({ access_token: 'NEW', expires_in: 3600 })) // refresh
        .mockResolvedValueOnce(jsonRes({ files: [] })); // files.list with NEW token

      await service.pull();

      const [refreshUrl, refreshInit] = fetchMock.mock.calls[0];
      expect(refreshUrl).toBe('https://oauth2.googleapis.com/token');
      expect(String(refreshInit.body)).toContain('grant_type=refresh_token');
      const [, listInit] = fetchMock.mock.calls[1];
      expect(listInit.headers.Authorization).toBe('Bearer NEW');
    });
  });

  describe('signOut', () => {
    it('revokes and clears the stored tokens', async () => {
      await seedValidToken();
      fetchMock.mockResolvedValueOnce(jsonRes({})); // revoke

      await service.signOut();

      expect(await service.isSignedIn()).toBe(false);
      expect(await secrets.get(TOKEN_KEY)).toBeUndefined();
    });
  });
});
