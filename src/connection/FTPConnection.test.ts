import { FTPConnection } from './FTPConnection';
import { ConnectionState, AuthenticationError, IHostConfig } from '../types';
import { window } from '../__mocks__/vscode';

// --- basic-ftp mock (var-hoisted per @swc/jest rules) ---
var mockAccess = jest.fn();
var mockPwd = jest.fn();
var mockList = jest.fn();
var mockDownloadTo = jest.fn();
var mockUploadFrom = jest.fn();
var mockRemove = jest.fn();
var mockRemoveDir = jest.fn();
var mockEnsureDir = jest.fn();
var mockRename = jest.fn();
var mockCd = jest.fn();
var mockClose = jest.fn();
var mockSocketOnce = jest.fn();
// `closed` reflects basic-ftp marking the client dead after a timeout/connection
// error. A getter (not a plain prop) so the factory reads the live `var` per
// @swc/jest mock-hoisting rules.
var mockClosed = false;

jest.mock('basic-ftp', () => ({
  Client: jest.fn().mockImplementation(() => ({
    ftp: { verbose: false, get socket() { return { once: mockSocketOnce }; } },
    get closed() { return mockClosed; },
    access: mockAccess,
    pwd: mockPwd,
    list: mockList,
    downloadTo: mockDownloadTo,
    uploadFrom: mockUploadFrom,
    remove: mockRemove,
    removeDir: mockRemoveDir,
    ensureDir: mockEnsureDir,
    rename: mockRename,
    cd: mockCd,
    close: mockClose,
  })),
}));

var mockGetSecret = jest.fn();
jest.mock('../services/CredentialService', () => ({
  CredentialService: {
    getInstance: jest.fn().mockReturnValue({
      getCredentialSecret: (...a: unknown[]) => mockGetSecret(...a),
      updateCredentialPassword: jest.fn(),
      setSessionCredential: jest.fn(),
      deleteAll: jest.fn(),
    }),
  },
}));

function host(overrides: Partial<IHostConfig> = {}): IHostConfig {
  return { id: 'h:21:u', name: 'h', host: 'h', port: 21, username: 'u', source: 'saved', connectionType: 'ftp', ...overrides };
}

const file = (name: string, isDirectory: boolean, extra: Record<string, unknown> = {}) => ({
  name, isDirectory, size: 10, modifiedAt: new Date(0), ...extra,
});

async function connected(h: IHostConfig = host({ anonymous: true })): Promise<FTPConnection> {
  const conn = new FTPConnection(h);
  await conn.connect();
  return conn;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockClosed = false;
  mockAccess.mockResolvedValue(undefined);
  mockPwd.mockResolvedValue('/home/u');
  mockList.mockResolvedValue([]);
  mockUploadFrom.mockResolvedValue(undefined);
  mockRemove.mockResolvedValue(undefined);
  mockRemoveDir.mockResolvedValue(undefined);
  mockEnsureDir.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
  mockCd.mockResolvedValue(undefined);
  mockDownloadTo.mockImplementation(async (sink: NodeJS.WritableStream) => {
    sink.write(Buffer.from('hello'));
    (sink as { end: () => void }).end();
  });
  mockGetSecret.mockResolvedValue('secret');
});

describe('FTPConnection', () => {
  it('reports all-false shell capabilities', () => {
    const c = new FTPConnection(host());
    expect(c.capabilities).toEqual({
      type: 'ftp', supportsExec: false, supportsShell: false, supportsPortForward: false,
      supportsNativeWatch: false, supportsSearch: false, supportsServerBackup: false, supportsSudo: false,
    });
  });

  describe('connect', () => {
    it('connects anonymously with empty password and caches the login dir', async () => {
      const conn = await connected(host({ anonymous: true }));
      expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ host: 'h', port: 21, user: 'anonymous', password: '' }));
      expect(conn.state).toBe(ConnectionState.Connected);
      expect(await conn.resolveHomePath()).toBe('/home/u');
    });

    it('uses explicit FTPS when secure is set', async () => {
      await connected(host({ anonymous: true, secure: true }));
      expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
    });

    it('uses plain FTP (secure:false) by default', async () => {
      await connected(host({ anonymous: true }));
      expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ secure: false }));
    });

    it('maps a 530 login failure to AuthenticationError and sets Error state', async () => {
      mockAccess.mockRejectedValueOnce(Object.assign(new Error('530 Login incorrect'), { code: 530 }));
      const conn = new FTPConnection(host({ anonymous: true }));
      await expect(conn.connect()).rejects.toBeInstanceOf(AuthenticationError);
      expect(conn.state).toBe(ConnectionState.Error);
    });
  });

  describe('file operations', () => {
    it('listFiles maps FileInfo to IRemoteFile, directories first', async () => {
      mockList.mockResolvedValueOnce([
        file('b.txt', false, { user: 'u', group: 'g' }),
        file('adir', true),
      ]);
      const conn = await connected();
      const out = await conn.listFiles('/data');
      expect(out.map((f) => f.name)).toEqual(['adir', 'b.txt']);
      expect(out[0]).toMatchObject({ path: '/data/adir', isDirectory: true, connectionId: 'h:21:u' });
      expect(out[1]).toMatchObject({ path: '/data/b.txt', isDirectory: false, owner: 'u', group: 'g' });
    });

    it('parses rawModifiedAt for LIST-mode servers instead of 1970 (issue #15)', async () => {
      // basic-ftp leaves modifiedAt undefined for LIST servers and exposes only
      // rawModifiedAt. The old code collapsed that to 0 = "56 years ago".
      mockList.mockResolvedValueOnce([
        { name: 'recent.txt', isDirectory: false, size: 5, modifiedAt: undefined, rawModifiedAt: 'Jun 11 14:35' },
        { name: 'old.txt', isDirectory: false, size: 5, modifiedAt: undefined, rawModifiedAt: 'Mar 3 2021' },
        { name: 'nodate.txt', isDirectory: false, size: 5, modifiedAt: undefined, rawModifiedAt: undefined },
      ]);
      const conn = await connected();
      const out = await conn.listFiles('/data');
      const byName = Object.fromEntries(out.map((f) => [f.name, f.modifiedTime]));
      expect(byName['recent.txt']).toBeGreaterThan(0);
      expect(new Date(byName['old.txt']).getFullYear()).toBe(2021);
      expect(byName['nodate.txt']).toBe(0); // genuinely unknown stays 0 (rendered blank)
    });

    it("listFiles resolves '~' to the cached login dir", async () => {
      const conn = await connected();
      await conn.listFiles('~');
      expect(mockList).toHaveBeenLastCalledWith('/home/u');
    });

    it('readFile downloads into a buffer', async () => {
      const conn = await connected();
      const buf = await conn.readFile('/data/x.txt');
      expect(buf.toString()).toBe('hello');
      expect(mockDownloadTo).toHaveBeenCalled();
    });

    it('writeFile uploads the content', async () => {
      const conn = await connected();
      await conn.writeFile('/data/x.txt', Buffer.from('hi'));
      expect(mockUploadFrom).toHaveBeenCalledWith(expect.anything(), '/data/x.txt');
    });

    it('deleteFile uses remove for files and removeDir for directories', async () => {
      const conn = await connected();
      mockList.mockResolvedValueOnce([file('x.txt', false)]); // statRaw of /data/x.txt parent
      await conn.deleteFile('/data/x.txt');
      expect(mockRemove).toHaveBeenCalledWith('/data/x.txt');

      mockList.mockResolvedValueOnce([file('sub', true)]); // statRaw of /data/sub parent
      await conn.deleteFile('/data/sub');
      expect(mockRemoveDir).toHaveBeenCalledWith('/data/sub');
    });

    it('mkdir ensures the dir then restores the working directory', async () => {
      const conn = await connected();
      await conn.mkdir('/data/new');
      expect(mockEnsureDir).toHaveBeenCalledWith('/data/new');
      expect(mockCd).toHaveBeenLastCalledWith('/home/u');
    });

    it('rename maps to the FTP rename command', async () => {
      const conn = await connected();
      await conn.rename('/a', '/b');
      expect(mockRename).toHaveBeenCalledWith('/a', '/b');
    });

    it('stat resolves via the parent listing', async () => {
      const conn = await connected();
      mockList.mockResolvedValueOnce([file('x.txt', false)]);
      const s = await conn.stat('/data/x.txt');
      expect(s).toMatchObject({ name: 'x.txt', path: '/data/x.txt', isDirectory: false });
    });

    it('fileExists is false when the basename is absent from the parent listing', async () => {
      const conn = await connected();
      mockList.mockResolvedValueOnce([file('other', false)]);
      expect(await conn.fileExists('/data/missing')).toBe(false);
    });

    it('throws when listing a missing directory (empty LIST confirmed absent in parent)', async () => {
      const conn = await connected();
      mockList.mockResolvedValueOnce([]); // list('/data/ghost') — server swallows the 550
      mockList.mockResolvedValueOnce([file('other', true)]); // statRaw parent '/data' lacks 'ghost'
      await expect(conn.listFiles('/data/ghost')).rejects.toThrow(/No such directory/);
    });

    it('returns [] for a real empty directory (present in parent listing)', async () => {
      const conn = await connected();
      mockList.mockResolvedValueOnce([]); // list('/data/empty')
      mockList.mockResolvedValueOnce([file('empty', true)]); // statRaw parent '/data' finds it
      expect(await conn.listFiles('/data/empty')).toEqual([]);
    });

    it('returns [] (not an error) when the dir lists empty but its parent is unreadable', async () => {
      const conn = await connected();
      mockList.mockResolvedValueOnce([]); // list('/data/empty') succeeds, empty
      mockList.mockRejectedValueOnce(Object.assign(new Error('550 Permission denied'))); // statRaw parent fails
      // The dir's own LIST succeeded, so trust it; do not surface the parent error.
      expect(await conn.listFiles('/data/empty')).toEqual([]);
    });

    it('returns [] for an empty home dir without a parent round-trip', async () => {
      const conn = await connected(); // home is /home/u
      mockList.mockResolvedValueOnce([]); // list('/home/u')
      expect(await conn.listFiles('/home/u')).toEqual([]);
      expect(mockList).toHaveBeenCalledTimes(1); // statRaw short-circuits home, no parent LIST
    });
  });

  describe('serialization queue', () => {
    it('runs operations one at a time (never concurrently)', async () => {
      const conn = await connected();
      let active = 0;
      let maxActive = 0;
      mockList.mockImplementation(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        return [file('placeholder', false)]; // non-empty so the missing-dir guard stays out of the way
      });
      await Promise.all([conn.listFiles('/a'), conn.listFiles('/b'), conn.listFiles('/c')]);
      expect(maxActive).toBe(1);
    });
  });

  describe('disconnect', () => {
    it('closes the client and sets Disconnected', async () => {
      const conn = await connected();
      await conn.disconnect();
      expect(mockClose).toHaveBeenCalled();
      expect(conn.state).toBe(ConnectionState.Disconnected);
    });
  });

  describe('stored credential password', () => {
    const cred = () => ({ id: 'c1', type: 'password', label: 'Default' }) as any;

    it('uses a legitimately EMPTY stored password without re-prompting', async () => {
      // Regression: `if (!password)` treated a saved empty password ('') as missing
      // and re-prompted on every connect. Only `undefined` means "no secret stored".
      mockGetSecret.mockResolvedValueOnce('');
      const conn = new FTPConnection(host(), cred());
      await conn.connect();
      expect(window.showInputBox).not.toHaveBeenCalled();
      expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ user: 'u', password: '' }));
      expect(conn.state).toBe(ConnectionState.Connected);
    });

    it('prompts only when NO secret is stored (undefined)', async () => {
      mockGetSecret.mockResolvedValueOnce(undefined);
      (window.showInputBox as jest.Mock).mockResolvedValueOnce('typed-pw');
      const conn = new FTPConnection(host(), cred());
      await conn.connect();
      expect(window.showInputBox).toHaveBeenCalled();
      expect(mockAccess).toHaveBeenCalledWith(expect.objectContaining({ password: 'typed-pw' }));
    });
  });

  describe('drop detection on a failed op', () => {
    it('flips to Disconnected when an op fails and the client is closed', async () => {
      // basic-ftp marks the client `closed` after a connection error; the cached-socket
      // close handler can miss a swapped socket (TLS upgrade / reconnect), so the op
      // failure path must reconcile state for ConnectionManager's reconnect logic.
      const conn = await connected();
      const seen: ConnectionState[] = [];
      conn.onStateChange((s) => seen.push(s));
      mockClosed = true;
      mockList.mockRejectedValueOnce(new Error('Server sent FIN packet unexpectedly'));
      await expect(conn.listFiles('/x')).rejects.toThrow(/FTP list failed/);
      expect(conn.state).toBe(ConnectionState.Disconnected);
      expect(seen).toContain(ConnectionState.Disconnected);
    });

    it('stays Connected when an op fails but the client is still open (transient error)', async () => {
      const conn = await connected();
      mockClosed = false;
      mockList.mockRejectedValueOnce(new Error('550 transient failure'));
      await expect(conn.listFiles('/x')).rejects.toThrow();
      expect(conn.state).toBe(ConnectionState.Connected);
    });
  });
});
