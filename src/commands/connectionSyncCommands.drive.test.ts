/**
 * Command-glue tests for the Google Drive sync commands (issue #11, Phase B).
 * The Drive service is faked; these verify the command wiring: the
 * not-configured guard, push serialization, and pull -> validate -> apply.
 */

import {
  workspace,
  window,
  commands,
  setMockConfig,
  clearMockConfig,
} from '../__mocks__/vscode';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn().mockReturnValue(''),
  statSync: jest.fn().mockReturnValue({ mtimeMs: 1000 }),
  writeFileSync: jest.fn(),
}));
jest.mock('ssh-config', () => ({
  parse: jest.fn().mockImplementation(() => ({
    [Symbol.iterator]: function* () {},
    compute: jest.fn().mockReturnValue({}),
    remove: jest.fn(),
    toString: jest.fn().mockReturnValue(''),
  })),
  DIRECTIVE: 1,
}));

var fakeDrive = {
  isConfigured: jest.fn().mockReturnValue(true),
  isSignedIn: jest.fn().mockResolvedValue(true),
  signIn: jest.fn().mockResolvedValue(undefined),
  signOut: jest.fn().mockResolvedValue(undefined),
  push: jest.fn().mockResolvedValue(undefined),
  pull: jest.fn().mockResolvedValue(undefined),
};
jest.mock('../services/GoogleDriveSyncService', () => ({
  GoogleDriveSyncService: { getInstance: () => fakeDrive },
}));

import { HostService } from '../services/HostService';
import { CredentialService } from '../services/CredentialService';
import { ConnectionPortabilityService } from '../services/ConnectionPortabilityService';
import { registerConnectionSyncCommands } from './connectionSyncCommands';

const VALID_EXPORT = JSON.stringify({
  schema: 'sshlite-connections',
  version: 1,
  hosts: [{ name: 'H', host: '1.2.3.4', port: 22, username: 'u' }],
  credentials: {},
});

describe('connectionSyncCommands — Google Drive glue', () => {
  let disposables: { dispose(): void }[];

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockConfig();
    (commands as any)._clearRegistry();
    (HostService as any)._instance = undefined;
    (CredentialService as any)._instance = undefined;
    (ConnectionPortabilityService as any)._instance = undefined;
    fakeDrive.isConfigured.mockReturnValue(true);
    fakeDrive.isSignedIn.mockResolvedValue(true);
    fakeDrive.pull.mockResolvedValue(undefined);
    disposables = registerConnectionSyncCommands({ extensionVersion: '0.10.0', now: () => 'T' });
  });

  afterEach(() => {
    disposables.forEach((d) => d.dispose());
    clearMockConfig();
  });

  it('connectGoogleDrive warns and does not sign in when not configured', async () => {
    fakeDrive.isConfigured.mockReturnValue(false);

    await commands.executeCommand('sshLite.connectGoogleDrive');

    expect(window.showWarningMessage).toHaveBeenCalled();
    expect(fakeDrive.signIn).not.toHaveBeenCalled();
  });

  it('syncPushToDrive uploads the serialized export', async () => {
    setMockConfig('sshLite.hosts', [{ name: 'Prod', host: '10.0.0.1', port: 22, username: 'admin' }]);

    await commands.executeCommand('sshLite.syncPushToDrive');

    expect(fakeDrive.push).toHaveBeenCalledTimes(1);
    expect(fakeDrive.push.mock.calls[0][0]).toContain('"schema": "sshlite-connections"');
  });

  it('syncPullFromDrive validates and applies the downloaded file', async () => {
    fakeDrive.pull.mockResolvedValueOnce(VALID_EXPORT);
    (window.showQuickPick as jest.Mock).mockResolvedValueOnce({ label: 'Merge', mode: 'merge' });

    await commands.executeCommand('sshLite.syncPullFromDrive');

    expect(window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('imported connections')
    );
  });

  it('syncPullFromDrive reports when nothing is on Drive yet', async () => {
    fakeDrive.pull.mockResolvedValueOnce(undefined);

    await commands.executeCommand('sshLite.syncPullFromDrive');

    expect(window.showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining('no connections file found')
    );
    expect(window.showQuickPick).not.toHaveBeenCalled();
  });

  it('syncPushToDrive offers to connect when signed out, then aborts if declined', async () => {
    fakeDrive.isSignedIn.mockResolvedValue(false);
    (window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Cancel');

    await commands.executeCommand('sshLite.syncPushToDrive');

    expect(fakeDrive.push).not.toHaveBeenCalled();
  });

  it('syncPushToDrive does NOT push if sign-in does not complete after the user accepts', async () => {
    // Seed hosts so an empty-payload short-circuit cannot hide the bug.
    setMockConfig('sshLite.hosts', [{ name: 'Prod', host: '10.0.0.1', port: 22, username: 'admin' }]);
    fakeDrive.isSignedIn.mockResolvedValue(false); // stays signed out even after "Connect"
    (window.showInformationMessage as jest.Mock).mockResolvedValueOnce('Connect');

    await commands.executeCommand('sshLite.syncPushToDrive');

    expect(fakeDrive.push).not.toHaveBeenCalled();
  });
});
