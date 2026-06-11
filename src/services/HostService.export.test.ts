/**
 * HostService.getAllHostsForExport tests (issue #11 fix).
 *
 * The export must contain EVERY connection the user sees in the SSH Hosts panel
 * — both saved hosts (sshLite.hosts) AND ~/.ssh/config hosts — deduped by
 * host:port:username, with portable (~) key paths. Bug report: a user with 19
 * saved + 82 ssh-config hosts got an export of only 19. Data loss; LITE violation.
 */

import { setMockConfig, clearMockConfig, workspace } from '../__mocks__/vscode';
import * as os from 'os';

jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(true),
  readFileSync: jest.fn().mockReturnValue('Host myserver'),
  statSync: jest.fn().mockReturnValue({ mtimeMs: 1000 }),
  writeFileSync: jest.fn(),
}));

// ssh-config mock that yields ONE concrete host: myserver -> 1.2.3.4:22 bob, key ~/.ssh/id_rsa
jest.mock('ssh-config', () => ({
  parse: jest.fn(() => ({
    [Symbol.iterator]: function* () {
      yield { type: 1, param: 'Host', value: 'myserver' };
    },
    compute: () => ({ HostName: '1.2.3.4', Port: '22', User: 'bob', IdentityFile: '~/.ssh/id_rsa' }),
  })),
  DIRECTIVE: 1,
}));

import { HostService } from './HostService';

function resetHostService(): HostService {
  (HostService as any)._instance = undefined;
  return HostService.getInstance();
}

describe('HostService.getAllHostsForExport', () => {
  let service: HostService;

  beforeEach(() => {
    jest.clearAllMocks();
    clearMockConfig();
    service = resetHostService();
  });

  afterEach(() => clearMockConfig());

  it('includes BOTH ~/.ssh/config hosts and saved hosts', () => {
    setMockConfig('sshLite.hosts', [
      { name: 'Saved', host: '10.0.0.9', port: 22, username: 'me', privateKeyPath: '~/.ssh/id_saved' },
    ]);

    const hosts = service.getAllHostsForExport();

    expect(hosts).toHaveLength(2);
    expect(hosts.map((h) => h.host).sort()).toEqual(['1.2.3.4', '10.0.0.9']);
  });

  it('preserves the unexpanded ~ path for saved hosts', () => {
    setMockConfig('sshLite.hosts', [
      { name: 'Saved', host: '10.0.0.9', port: 22, username: 'me', privateKeyPath: '~/.ssh/id_saved' },
    ]);

    const saved = service.getAllHostsForExport().find((h) => h.host === '10.0.0.9');
    expect(saved?.privateKeyPath).toBe('~/.ssh/id_saved');
  });

  it('collapses an ssh-config host key path back to ~ for portability', () => {
    const fromConfig = service.getAllHostsForExport().find((h) => h.host === '1.2.3.4');
    // loadSSHConfigHosts expands ~ -> homedir; export must collapse it back.
    expect(fromConfig?.privateKeyPath).toBe('~/.ssh/id_rsa');
    expect(fromConfig?.privateKeyPath?.startsWith(os.homedir())).toBe(false);
  });

  it('dedupes by host:port:username, preferring the saved (raw) entry', () => {
    // Same id as the ssh-config host (1.2.3.4:22:bob) but a different raw key path.
    setMockConfig('sshLite.hosts', [
      { name: 'SavedDup', host: '1.2.3.4', port: 22, username: 'bob', privateKeyPath: '~/.ssh/raw' },
    ]);

    const hosts = service.getAllHostsForExport();
    const matches = hosts.filter((h) => h.host === '1.2.3.4');
    expect(matches).toHaveLength(1);
    expect(matches[0].privateKeyPath).toBe('~/.ssh/raw');
    expect(matches[0].name).toBe('SavedDup');
  });
});
