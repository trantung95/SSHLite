/**
 * VirtualDocProviders tests
 *
 * Covers:
 *  - buildUri constructs correct scheme/authority/path
 *  - RemoteEnvDocumentProvider: returns env output, handles missing connection, handles exec error
 *  - RemoteCronDocumentProvider: returns crontab, empty crontab, missing connection, exec error
 *  - refresh() fires onDidChange
 *  - dispose() cleans up
 */

var mockGetConnection = jest.fn();

jest.mock('../connection/ConnectionManager', () => ({
  ConnectionManager: {
    getInstance: jest.fn().mockImplementation(() => ({
      getConnection: mockGetConnection,
    })),
  },
}));

import * as vscode from 'vscode';
import {
  buildUri,
  RemoteEnvDocumentProvider,
  RemoteCronDocumentProvider,
  ENV_SCHEME,
  CRON_SCHEME,
} from './VirtualDocProviders';

function makeConn(exec: jest.Mock) {
  return { host: { name: 'dev-box' }, exec };
}

describe('buildUri', () => {
  it('uses the supplied scheme and encodes connId in authority', () => {
    const uri = buildUri(ENV_SCHEME, 'my conn:22:user', '/env.txt');
    expect(uri.scheme).toBe(ENV_SCHEME);
    expect(decodeURIComponent(uri.authority)).toBe('my conn:22:user');
  });

  it('prepends / when path does not start with /', () => {
    const uri = buildUri(ENV_SCHEME, 'c1', 'env.txt');
    expect(uri.path).toBe('/env.txt');
  });

  it('does not double-slash when path already starts with /', () => {
    const uri = buildUri(CRON_SCHEME, 'c1', '/crontab.cron');
    expect(uri.path).toBe('/crontab.cron');
  });
});

describe('RemoteEnvDocumentProvider', () => {
  let provider: RemoteEnvDocumentProvider;

  beforeEach(() => {
    mockGetConnection.mockReset();
    provider = new RemoteEnvDocumentProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  it('returns sorted env output with header when connection is active', async () => {
    const exec = jest.fn().mockResolvedValue('HOME=/home/u\nPATH=/usr/bin\n');
    mockGetConnection.mockReturnValue(makeConn(exec));
    const uri = buildUri(ENV_SCHEME, 'c1', '/env.txt');

    const content = await provider.provideTextDocumentContent(uri);

    expect(exec).toHaveBeenCalledWith('env | sort');
    expect(content).toContain('dev-box');
    expect(content).toContain('HOME=/home/u');
  });

  it('returns fallback message when connection is not found', async () => {
    mockGetConnection.mockReturnValue(undefined);
    const uri = buildUri(ENV_SCHEME, 'missing', '/env.txt');

    const content = await provider.provideTextDocumentContent(uri);

    expect(content).toContain('Connection not active');
  });

  it('returns error message when exec throws', async () => {
    const exec = jest.fn().mockRejectedValue(new Error('Permission denied'));
    mockGetConnection.mockReturnValue(makeConn(exec));
    const uri = buildUri(ENV_SCHEME, 'c1', '/env.txt');

    const content = await provider.provideTextDocumentContent(uri);

    expect(content).toContain('Permission denied');
  });

  it('fires onDidChange when refresh() is called', () => {
    const listener = jest.fn();
    provider.onDidChange(listener);
    const uri = buildUri(ENV_SCHEME, 'c1', '/env.txt');

    provider.refresh(uri);

    expect(listener).toHaveBeenCalledWith(uri);
  });
});

describe('RemoteCronDocumentProvider', () => {
  let provider: RemoteCronDocumentProvider;

  beforeEach(() => {
    mockGetConnection.mockReset();
    provider = new RemoteCronDocumentProvider();
  });

  afterEach(() => {
    provider.dispose();
  });

  it('returns crontab content when connection is active', async () => {
    const exec = jest.fn().mockResolvedValue('*/5 * * * * /usr/bin/backup.sh\n');
    mockGetConnection.mockReturnValue(makeConn(exec));
    const uri = buildUri(CRON_SCHEME, 'c1', '/crontab.cron');

    const content = await provider.provideTextDocumentContent(uri);

    expect(exec).toHaveBeenCalledWith('crontab -l 2>/dev/null || true');
    expect(content).toContain('backup.sh');
  });

  it('returns "(no crontab)" placeholder when output is empty', async () => {
    const exec = jest.fn().mockResolvedValue('');
    mockGetConnection.mockReturnValue(makeConn(exec));
    const uri = buildUri(CRON_SCHEME, 'c1', '/crontab.cron');

    const content = await provider.provideTextDocumentContent(uri);

    expect(content).toContain('no crontab');
  });

  it('returns fallback message when connection is not found', async () => {
    mockGetConnection.mockReturnValue(undefined);
    const uri = buildUri(CRON_SCHEME, 'gone', '/crontab.cron');

    const content = await provider.provideTextDocumentContent(uri);

    expect(content).toContain('Connection not active');
  });

  it('returns error message when exec throws', async () => {
    const exec = jest.fn().mockRejectedValue(new Error('crontab not found'));
    mockGetConnection.mockReturnValue(makeConn(exec));
    const uri = buildUri(CRON_SCHEME, 'c1', '/crontab.cron');

    const content = await provider.provideTextDocumentContent(uri);

    expect(content).toContain('crontab not found');
  });

  it('fires onDidChange when refresh() is called', () => {
    const listener = jest.fn();
    provider.onDidChange(listener);
    const uri = buildUri(CRON_SCHEME, 'c1', '/crontab.cron');

    provider.refresh(uri);

    expect(listener).toHaveBeenCalledWith(uri);
  });
});
