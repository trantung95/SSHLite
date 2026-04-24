/**
 * SshKeyService tests
 * Only pushPublicKey is tested here — generateKey shells out to ssh-keygen
 * and is covered by a smoke test that the spawn path is reachable.
 */

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
  };
});

import * as fs from 'fs';
import { SshKeyService } from './SshKeyService';

function reset(): SshKeyService {
  (SshKeyService as any)._instance = undefined;
  return SshKeyService.getInstance();
}

function mockConnection() {
  const exec = jest.fn<Promise<string>, [string]>();
  exec.mockResolvedValue('');
  return {
    id: 'test',
    host: { name: 'h', host: 'h', port: 22, username: 'u' },
    state: 'connected',
    exec,
  } as any;
}

describe('SshKeyService.pushPublicKey', () => {
  let service: SshKeyService;

  beforeEach(() => {
    service = reset();
    (fs.existsSync as jest.Mock).mockReset();
    (fs.readFileSync as jest.Mock).mockReset();
  });

  it('errors when local file does not exist', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const conn = mockConnection();
    await expect(service.pushPublicKey(conn, '/missing.pub')).rejects.toThrow('Public key not found');
  });

  it('errors when local file is empty', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('');
    const conn = mockConnection();
    await expect(service.pushPublicKey(conn, '/empty.pub')).rejects.toThrow('empty');
  });

  it('appends key to authorized_keys when not present', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('ssh-ed25519 AAAAC3Nza me@laptop\n');
    const conn = mockConnection();
    conn.exec.mockImplementation(async (cmd: string) => {
      if (cmd === 'echo $HOME') { return '/home/u\n'; }
      if (cmd.startsWith('mkdir')) { return ''; }
      if (cmd.startsWith('cat')) { return '# other keys\n'; }
      if (cmd.startsWith('printf')) { return ''; }
      return '';
    });
    const result = await service.pushPublicKey(conn, '/key.pub');
    expect(result.added).toBe(true);
    const calls: string[] = conn.exec.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((c: string) => c.startsWith('mkdir -p'))).toBe(true);
    expect(calls.some((c: string) => c.startsWith('printf'))).toBe(true);
  });

  it('skips when the exact key line already exists', async () => {
    const keyLine = 'ssh-ed25519 AAAAC3Nza me@laptop';
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue(keyLine + '\n');
    const conn = mockConnection();
    conn.exec.mockImplementation(async (cmd: string) => {
      if (cmd === 'echo $HOME') { return '/home/u'; }
      if (cmd.startsWith('cat')) { return 'ssh-rsa XYZ other\n' + keyLine + '\n'; }
      return '';
    });
    const result = await service.pushPublicKey(conn, '/key.pub');
    expect(result.added).toBe(false);
    expect(result.reason).toMatch(/already/i);
    const calls: string[] = conn.exec.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((c: string) => c.startsWith('printf'))).toBe(false);
  });

  it('falls back to /home/<user> when $HOME resolves empty', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (fs.readFileSync as jest.Mock).mockReturnValue('ssh-ed25519 NEW me@laptop');
    const conn = mockConnection();
    conn.host.username = 'bob';
    conn.exec.mockImplementation(async (cmd: string) => {
      if (cmd === 'echo $HOME') { return ''; }
      return '';
    });
    await service.pushPublicKey(conn, '/key.pub');
    const calls: string[] = conn.exec.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((c: string) => c.includes("'/home/bob/.ssh'"))).toBe(true);
  });
});

describe('SshKeyService.defaultKeyDir', () => {
  it('returns a path ending in .ssh', () => {
    const dir = SshKeyService.getInstance().defaultKeyDir();
    expect(dir).toMatch(/[\\/]\.ssh$/);
  });
});
