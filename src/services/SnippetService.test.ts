/**
 * SnippetService tests
 */

import { SnippetService } from './SnippetService';

function resetService(): SnippetService {
  (SnippetService as any)._instance = undefined;
  return SnippetService.getInstance();
}

function mockContext() {
  const storage = new Map<string, unknown>();
  return {
    globalState: {
      get: jest.fn().mockImplementation((k: string, def?: unknown) => storage.get(k) ?? def),
      update: jest.fn().mockImplementation((k: string, v: unknown) => { storage.set(k, v); return Promise.resolve(); }),
    },
  } as any;
}

describe('SnippetService', () => {
  let service: SnippetService;

  beforeEach(() => {
    service = resetService();
    service.initialize(mockContext());
  });

  it('returns a singleton', () => {
    expect(SnippetService.getInstance()).toBe(SnippetService.getInstance());
  });

  it('ships with built-in snippets', () => {
    const all = service.getAll();
    expect(all.length).toBeGreaterThanOrEqual(6);
    const names = all.map((s) => s.name.toLowerCase());
    expect(names.some((n) => n.includes('disk'))).toBe(true);
    expect(names.some((n) => n.includes('cpu'))).toBe(true);
  });

  it('adds a user snippet', async () => {
    const snippet = await service.add('My DF', 'df -h /');
    expect(snippet.id).toMatch(/^user-/);
    expect(snippet.builtin).toBeUndefined();
    expect(service.getUserSnippets()).toHaveLength(1);
  });

  it('rejects empty name or command', async () => {
    await expect(service.add('', 'df')).rejects.toThrow();
    await expect(service.add('name', '')).rejects.toThrow();
  });

  it('renames a user snippet', async () => {
    const s = await service.add('Old name', 'df -h');
    const ok = await service.rename(s.id, 'New name');
    expect(ok).toBe(true);
    expect(service.findById(s.id)?.name).toBe('New name');
  });

  it('updates a user snippet command', async () => {
    const s = await service.add('df', 'df -h');
    await service.update(s.id, 'df -h /');
    expect(service.findById(s.id)?.command).toBe('df -h /');
  });

  it('removes a user snippet', async () => {
    const s = await service.add('gone', 'echo bye');
    const ok = await service.remove(s.id);
    expect(ok).toBe(true);
    expect(service.findById(s.id)).toBeUndefined();
  });

  it('returns false when removing unknown id', async () => {
    const ok = await service.remove('nonexistent');
    expect(ok).toBe(false);
  });

  it('does not expose built-ins as user snippets', () => {
    expect(service.getUserSnippets()).toHaveLength(0);
  });
});
