import * as path from 'path';
import { HookInstallerService, HookFsApi, HookInstallCtx, HOOK_TOOLS } from './HookInstallerService';

jest.mock('../utils/diagnosticLog', () => ({ infoLog: jest.fn(), diagLog: jest.fn() }));

const HOME = path.join('/home', 'me');
const CTX: HookInstallCtx = {
  assetScriptPath: path.join('/ext', 'assets', 'hooks', 'npc-beacon.js'),
  scriptPath: path.join('/gs', 'hooks', 'npc-beacon.js'),
  beaconPath: path.join('/gs', 'npc-ai-hook-beacon.json'),
};

function cfgPath(id: string): string {
  return HOOK_TOOLS.find((t) => t.id === id)!.configPath(HOME);
}
function homeDir(id: string): string {
  return HOOK_TOOLS.find((t) => t.id === id)!.homeDir(HOME);
}

function makeFakeFs(seed: Record<string, string> = {}) {
  const files = new Map<string, string>(Object.entries(seed));
  const dirs = new Set<string>();
  const fsApi: HookFsApi = {
    existsSync: (p) => files.has(p) || dirs.has(p),
    readFileSync: (p) => {
      const v = files.get(p);
      if (v === undefined) {
        throw new Error('ENOENT');
      }
      return v;
    },
    writeFileSync: (p, d) => void files.set(p, d),
    renameSync: (a, b) => {
      const v = files.get(a);
      if (v === undefined) {
        throw new Error('ENOENT');
      }
      files.set(b, v);
      files.delete(a);
    },
    mkdirSync: (p) => void dirs.add(p),
    copyFileSync: (a, b) => {
      const v = files.get(a);
      if (v === undefined) {
        throw new Error('ENOENT');
      }
      files.set(b, v);
    },
    unlinkSync: (p) => void files.delete(p),
  };
  // The bundled beacon script always exists to be staged.
  files.set(CTX.assetScriptPath, '// beacon script');
  return { files, dirs, fsApi, present: (id: string) => dirs.add(homeDir(id)) };
}

describe('HookInstallerService', () => {
  it('installs a Claude Code hook into an absent config (nested schema) and stages the script', () => {
    const { files, fsApi, present } = makeFakeFs();
    present('claude-code');
    const svc = new HookInstallerService(HOME, CTX, fsApi);

    const r = svc.install('claude-code');

    expect(r.ok).toBe(true);
    const cfg = JSON.parse(files.get(cfgPath('claude-code'))!);
    expect(cfg.hooks.UserPromptSubmit[0].hooks[0].type).toBe('command');
    expect(cfg.hooks.UserPromptSubmit[0].hooks[0].command).toContain('npc-beacon.js');
    // The beacon script was copied to its stable location.
    expect(files.get(CTX.scriptPath)).toBe('// beacon script');
  });

  it('is idempotent — installing twice does not duplicate the entry', () => {
    const { files, fsApi, present } = makeFakeFs();
    present('claude-code');
    const svc = new HookInstallerService(HOME, CTX, fsApi);

    svc.install('claude-code');
    svc.install('claude-code');

    const cfg = JSON.parse(files.get(cfgPath('claude-code'))!);
    expect(cfg.hooks.UserPromptSubmit).toHaveLength(1);
  });

  it('clicking install again is a no-op that preserves the ORIGINAL backup', () => {
    const original = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'theirs.sh' }] }] } });
    const { files, fsApi, present } = makeFakeFs({ [cfgPath('claude-code')]: original });
    present('claude-code');
    const svc = new HookInstallerService(HOME, CTX, fsApi);

    svc.install('claude-code'); // 1st: backup captures the original
    expect(files.get(cfgPath('claude-code') + '.sshlite.bak')).toBe(original);
    const afterFirst = files.get(cfgPath('claude-code'))!;

    svc.install('claude-code'); // 2nd: must not rewrite config nor clobber the backup

    expect(files.get(cfgPath('claude-code'))).toBe(afterFirst); // config unchanged
    expect(files.get(cfgPath('claude-code') + '.sshlite.bak')).toBe(original); // still the ORIGINAL
  });

  it('clicking Remove when our hook is absent does not rewrite the config', () => {
    const original = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'theirs.sh' }] }] } });
    const { files, fsApi, present } = makeFakeFs({ [cfgPath('claude-code')]: original });
    present('claude-code');
    const svc = new HookInstallerService(HOME, CTX, fsApi);

    const r = svc.uninstall('claude-code'); // our hook was never installed

    expect(r.ok).toBe(true);
    expect(files.get(cfgPath('claude-code'))).toBe(original); // untouched, byte-for-byte
    expect(files.has(cfgPath('claude-code') + '.sshlite.bak')).toBe(false); // no needless backup
  });

  it('preserves the user\'s existing hooks and unrelated keys', () => {
    const original = {
      $schema: 'https://example/schema.json',
      permissions: { allow: ['Bash'] },
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'their-script.sh' }] }] },
    };
    const { files, fsApi, present } = makeFakeFs({ [cfgPath('claude-code')]: JSON.stringify(original) });
    present('claude-code');
    const svc = new HookInstallerService(HOME, CTX, fsApi);

    svc.install('claude-code');

    const cfg = JSON.parse(files.get(cfgPath('claude-code'))!);
    expect(cfg.$schema).toBe('https://example/schema.json');
    expect(cfg.permissions).toEqual({ allow: ['Bash'] });
    const commands = cfg.hooks.UserPromptSubmit.flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands).toContain('their-script.sh'); // theirs untouched
    expect(commands.some((c: string) => c.includes('npc-beacon.js'))).toBe(true); // ours added
  });

  it('NEVER overwrites a config that is not valid JSON (parse-or-abort)', () => {
    const broken = '{ this is not: valid json,, ';
    const { files, fsApi, present } = makeFakeFs({ [cfgPath('claude-code')]: broken });
    present('claude-code');
    const svc = new HookInstallerService(HOME, CTX, fsApi);

    const r = svc.install('claude-code');

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not valid JSON/);
    expect(files.get(cfgPath('claude-code'))).toBe(broken); // left byte-for-byte untouched
  });

  it('backs up the prior config before writing', () => {
    const original = JSON.stringify({ hooks: {} });
    const { files, fsApi, present } = makeFakeFs({ [cfgPath('claude-code')]: original });
    present('claude-code');
    const svc = new HookInstallerService(HOME, CTX, fsApi);

    svc.install('claude-code');

    expect(files.get(cfgPath('claude-code') + '.sshlite.bak')).toBe(original);
  });

  it('uninstall removes only our entry, leaving the user\'s hook intact', () => {
    const { files, fsApi, present } = makeFakeFs();
    present('claude-code');
    const svc = new HookInstallerService(HOME, CTX, fsApi);
    svc.install('claude-code');
    // Add a user hook alongside ours.
    const withUser = JSON.parse(files.get(cfgPath('claude-code'))!);
    withUser.hooks.UserPromptSubmit.push({ hooks: [{ type: 'command', command: 'user-thing.sh' }] });
    files.set(cfgPath('claude-code'), JSON.stringify(withUser));

    svc.uninstall('claude-code');

    const cfg = JSON.parse(files.get(cfgPath('claude-code'))!);
    const commands = (cfg.hooks?.UserPromptSubmit ?? []).flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(commands).toContain('user-thing.sh');
    expect(commands.some((c: string) => c.includes('npc-beacon.js'))).toBe(false);
  });

  it('writes Cursor with the flat schema and a version field', () => {
    const { files, fsApi, present } = makeFakeFs();
    present('cursor');
    const svc = new HookInstallerService(HOME, CTX, fsApi);

    expect(svc.install('cursor').ok).toBe(true);
    const cfg = JSON.parse(files.get(cfgPath('cursor'))!);
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.beforeSubmitPrompt[0].command).toContain('npc-beacon.js');
    expect(cfg.hooks.beforeSubmitPrompt[0].type).toBeUndefined(); // flat shape: no type
  });

  it('writes Copilot to its own dedicated file (bash + powershell) and deletes it on uninstall', () => {
    const { files, fsApi, present } = makeFakeFs();
    present('github-copilot');
    const svc = new HookInstallerService(HOME, CTX, fsApi);

    expect(svc.install('github-copilot').ok).toBe(true);
    const cfg = JSON.parse(files.get(cfgPath('github-copilot'))!);
    expect(cfg.version).toBe(1);
    expect(cfg.hooks.userPromptSubmitted[0].bash).toContain('npc-beacon.js');
    expect(cfg.hooks.userPromptSubmitted[0].powershell).toContain('npc-beacon.js');

    svc.uninstall('github-copilot');
    expect(files.has(cfgPath('github-copilot'))).toBe(false);
  });

  it('refuses to install for a tool that is not present on the machine', () => {
    const { files, fsApi } = makeFakeFs(); // nothing marked present
    const svc = new HookInstallerService(HOME, CTX, fsApi);

    const r = svc.install('claude-code');

    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not installed/);
    expect(files.has(cfgPath('claude-code'))).toBe(false);
  });

  it('installAll only touches present tools; status reflects present + installed', () => {
    const { fsApi, present } = makeFakeFs();
    present('claude-code');
    present('cursor');
    const svc = new HookInstallerService(HOME, CTX, fsApi);

    const results = svc.installAll();
    expect(results.map((r) => r.id).sort()).toEqual(['claude-code', 'cursor']);
    expect(results.every((r) => r.ok)).toBe(true);

    const status = svc.status();
    const claude = status.find((s) => s.id === 'claude-code')!;
    const codex = status.find((s) => s.id === 'codex')!;
    expect(claude).toEqual(
      expect.objectContaining({ id: 'claude-code', name: 'Claude Code', present: true, installed: true })
    );
    // configPath is home-shortened for display.
    expect(claude.configPath.startsWith('~')).toBe(true);
    expect(claude.configPath).toContain('.claude');
    expect(codex.present).toBe(false);
    expect(codex.installed).toBe(false);
  });

  it('uninstallAll removes hook entries AND cleans up the staged script + beacon', () => {
    const { files, fsApi, present } = makeFakeFs({ [CTX.beaconPath]: '{"v":1}' });
    present('claude-code');
    present('cursor');
    const svc = new HookInstallerService(HOME, CTX, fsApi);
    svc.installAll();
    expect(files.has(CTX.scriptPath)).toBe(true); // staged during install

    svc.uninstallAll();

    // No tool reports installed anymore...
    expect(svc.status().every((s) => !s.installed)).toBe(true);
    // ...and the orphaned globalStorage artifacts are gone (housekeeper never sweeps there).
    expect(files.has(CTX.scriptPath)).toBe(false);
    expect(files.has(CTX.beaconPath)).toBe(false);
  });
});
