/**
 * RemoteDiffService tests
 */

jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    existsSync: jest.fn(),
    mkdtempSync: jest.fn(),
    writeFileSync: jest.fn(),
  };
});

import * as fs from 'fs';
import * as vscode from 'vscode';
import { RemoteDiffService } from './RemoteDiffService';

function reset(): RemoteDiffService {
  (RemoteDiffService as any)._instance = undefined;
  return RemoteDiffService.getInstance();
}

describe('RemoteDiffService', () => {
  let service: RemoteDiffService;
  let executeCommand: jest.SpyInstance;

  beforeEach(() => {
    service = reset();
    (fs.existsSync as jest.Mock).mockReset();
    (fs.mkdtempSync as jest.Mock).mockReset().mockReturnValue('/tmp/sshlite-diff-abc');
    (fs.writeFileSync as jest.Mock).mockReset();
    executeCommand = jest.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined as any);
  });

  afterEach(() => {
    executeCommand.mockRestore();
  });

  it('returns singleton', () => {
    expect(RemoteDiffService.getInstance()).toBe(RemoteDiffService.getInstance());
  });

  it('rejects when local file does not exist', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(false);
    const conn = { host: { name: 'h' }, readFile: jest.fn() } as any;
    await expect(service.diffRemoteWithLocal(conn, '/remote.txt', '/missing.txt')).rejects.toThrow('Local file not found');
  });

  it('writes remote contents to temp and opens vscode.diff', async () => {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    const buffer = Buffer.from('remote content');
    const conn = {
      host: { name: 'dev-box' },
      readFile: jest.fn().mockResolvedValue(buffer),
    } as any;

    await service.diffRemoteWithLocal(conn, '/etc/motd', '/local/motd');

    expect(conn.readFile).toHaveBeenCalledWith('/etc/motd');
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('remote-motd'),
      buffer
    );
    expect(executeCommand).toHaveBeenCalledWith(
      'vscode.diff',
      expect.anything(),
      expect.anything(),
      expect.stringContaining('dev-box')
    );
  });
});
