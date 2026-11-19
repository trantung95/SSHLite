import * as path from 'path';
import { recordInstall, lookupStorage, markUninstalled, registryFile, RegistryFsApi, normalizeRegistryPath } from './InstallRegistry';

const HOME = path.join('/home', 'me');
const EXT = path.join('/home', 'me', '.vscode', 'extensions', 'hybr8.ssh-lite-1.0.7');
const OLD_EXT = path.join('/home', 'me', '.vscode', 'extensions', 'hybr8.ssh-lite-1.0.6');
const GS = path.join('/data', 'Code', 'User', 'globalStorage', 'hybr8.ssh-lite');

function makeFs(existing: string[] = []) {
  const files = new Map<string, string>();
  const dirs = new Set(existing.map((p) => normalizeRegistryPath(p)));
  let writes = 0;
  const fsApi: RegistryFsApi = {
    existsSync: (p) => files.has(p) || dirs.has(normalizeRegistryPath(p)),
    readFileSync: (p) => {
      const v = files.get(p);
      if (v === undefined) {
        throw new Error('ENOENT');
      }
      return v;
    },
    writeFileSync: (p, d) => {
      writes++;
      files.set(p, d);
    },
    renameSync: (a, b) => {
      files.set(b, files.get(a)!);
      files.delete(a);
    },
    mkdirSync: () => undefined,
  };
  return { files, fsApi, writes: () => writes };
}

describe('InstallRegistry', () => {
  it('records extension folder -> storage and looks it up', () => {
    const { fsApi } = makeFs([EXT]);
    expect(recordInstall(HOME, EXT, GS, fsApi)).toEqual({ reinstalled: false });
    expect(lookupStorage(HOME, EXT, fsApi)).toBe(GS);
  });

  it('does not rewrite the file when nothing changed', () => {
    const { fsApi, writes } = makeFs([EXT]);
    recordInstall(HOME, EXT, GS, fsApi);
    const after = writes();
    recordInstall(HOME, EXT, GS, fsApi);
    expect(writes()).toBe(after);
  });

  it('prunes entries of extension folders that no longer exist (old version after update)', () => {
    const env = makeFs([EXT, OLD_EXT]);
    recordInstall(HOME, OLD_EXT, GS, env.fsApi);
    const env2 = makeFs([EXT]); // the 1.0.6 folder was removed by the update
    env2.files.set(registryFile(HOME), env.files.get(registryFile(HOME))!);
    recordInstall(HOME, EXT, GS, env2.fsApi);
    expect(lookupStorage(HOME, OLD_EXT, env2.fsApi)).toBeUndefined();
    expect(lookupStorage(HOME, EXT, env2.fsApi)).toBe(GS);
  });

  it('uninstall leaves a tombstone that the next activation consumes once (reinstall = fresh)', () => {
    const { fsApi } = makeFs([EXT]);
    recordInstall(HOME, EXT, GS, fsApi);

    markUninstalled(HOME, EXT, {}, fsApi);
    expect(lookupStorage(HOME, EXT, fsApi)).toBeUndefined();

    expect(recordInstall(HOME, EXT, GS, fsApi)).toEqual({ reinstalled: true });
    expect(recordInstall(HOME, EXT, GS, fsApi)).toEqual({ reinstalled: false });
  });

  it('a tombstone for another editor storage does not reset this one', () => {
    const { fsApi } = makeFs([EXT]);
    const otherExt = path.join('/home', 'me', '.cursor', 'extensions', 'hybr8.ssh-lite-1.0.7');
    const otherGs = path.join('/data', 'Cursor', 'User', 'globalStorage', 'hybr8.ssh-lite');
    recordInstall(HOME, otherExt, otherGs, fsApi);
    markUninstalled(HOME, otherExt, {}, fsApi);

    expect(recordInstall(HOME, EXT, GS, fsApi)).toEqual({ reinstalled: false });
  });

  it('matches a symlinked extensions folder (uninstall __dirname is a realpath)', () => {
    const { fsApi } = makeFs([EXT]);
    const real = path.join('/disk2', 'vscode-ext', 'hybr8.ssh-lite-1.0.7');
    fsApi.realpathSync = (p) => (normalizeRegistryPath(p) === normalizeRegistryPath(EXT) ? real : p);
    recordInstall(HOME, EXT, GS, fsApi); // activation sees the link path

    expect(lookupStorage(HOME, real, fsApi)).toBe(GS); // uninstall sees the real path
    markUninstalled(HOME, real, {}, fsApi);
    expect(recordInstall(HOME, EXT, GS, fsApi)).toEqual({ reinstalled: true });
  });

  it('rearmOthers re-arms every other editor install when a shared hook was removed', () => {
    const otherExt = path.join('/home', 'me', '.vscode-insiders', 'extensions', 'hybr8.ssh-lite-1.0.7');
    const otherGs = path.join('/data', 'Code - Insiders', 'User', 'globalStorage', 'hybr8.ssh-lite');
    const { fsApi } = makeFs([EXT, otherExt]);
    recordInstall(HOME, EXT, GS, fsApi);
    recordInstall(HOME, otherExt, otherGs, fsApi);

    markUninstalled(HOME, EXT, { rearmOthers: true }, fsApi);

    expect(lookupStorage(HOME, otherExt, fsApi)).toBe(otherGs); // still installed there
    expect(recordInstall(HOME, otherExt, otherGs, fsApi)).toEqual({ reinstalled: true });
    expect(recordInstall(HOME, otherExt, otherGs, fsApi)).toEqual({ reinstalled: false });
  });

  it('without rearmOthers another editor is not reset', () => {
    const otherExt = path.join('/home', 'me', '.vscode-insiders', 'extensions', 'hybr8.ssh-lite-1.0.7');
    const otherGs = path.join('/data', 'Code - Insiders', 'User', 'globalStorage', 'hybr8.ssh-lite');
    const { fsApi } = makeFs([EXT, otherExt]);
    recordInstall(HOME, EXT, GS, fsApi);
    recordInstall(HOME, otherExt, otherGs, fsApi);

    markUninstalled(HOME, EXT, {}, fsApi);

    expect(recordInstall(HOME, otherExt, otherGs, fsApi)).toEqual({ reinstalled: false });
  });

  it('never throws on a corrupt registry and starts over', () => {
    const { files, fsApi } = makeFs([EXT]);
    files.set(registryFile(HOME), '{ not json');
    expect(lookupStorage(HOME, EXT, fsApi)).toBeUndefined();
    expect(recordInstall(HOME, EXT, GS, fsApi)).toEqual({ reinstalled: false });
    expect(lookupStorage(HOME, EXT, fsApi)).toBe(GS);
  });

  it('normalizes Windows paths case-insensitively', () => {
    expect(normalizeRegistryPath('C:\\Users\\Me\\X\\', 'win32')).toBe('c:/users/me/x');
    expect(normalizeRegistryPath('/Home/Me/', 'linux')).toBe('/Home/Me');
  });
});
