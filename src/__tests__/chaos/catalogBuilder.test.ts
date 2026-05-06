import { parseUserActions, parseFlows, parseCommands } from '../../chaos/catalog/builder';

describe('catalog builder', () => {
  describe('parseUserActions', () => {
    it('extracts actions from a User Actions table', () => {
      const md = [
        '# Feature',
        '',
        '## User Actions',
        '| Action | Primitives | Notes |',
        '|---|---|---|',
        '| Browse files | listFiles, listDirectories, stat | comment |',
        '| Edit a file | readFile, writeFile | |',
        '',
        '## Other',
        '| Other | thing | |',
      ].join('\n');
      const actions = parseUserActions(md, 'features/test.md');
      expect(actions).toEqual([
        { name: 'Browse files', primitives: ['listFiles', 'listDirectories', 'stat'], source: 'features/test.md' },
        { name: 'Edit a file', primitives: ['readFile', 'writeFile'], source: 'features/test.md' },
      ]);
    });

    it('returns empty array when there is no User Actions section', () => {
      const md = '# Feature\n\nSome text.\n';
      expect(parseUserActions(md, 'features/x.md')).toEqual([]);
    });

    it('parses unordered marker from notes column', () => {
      const md = [
        '## User Actions',
        '| Action | Primitives | Notes |',
        '|---|---|---|',
        '| Bulk upload | mkdir, writeFile, writeFile | unordered |',
      ].join('\n');
      const actions = parseUserActions(md, 'x.md');
      expect(actions[0].unordered).toBe(true);
    });

    it('skips rows with empty primitives', () => {
      const md = [
        '## User Actions',
        '| Action | Primitives | Notes |',
        '|---|---|---|',
        '| Empty action |  | |',
        '| Real action | readFile | |',
      ].join('\n');
      const actions = parseUserActions(md, 'x.md');
      expect(actions.map(a => a.name)).toEqual(['Real action']);
    });
  });

  describe('parseCommands', () => {
    it('extracts commands from package.json contributes.commands', () => {
      const pkg = {
        contributes: {
          commands: [
            { command: 'sshlite.connect', title: 'Connect' },
            { command: 'sshlite.disconnect', title: 'Disconnect' },
          ],
        },
      };
      expect(parseCommands(pkg)).toEqual([
        { id: 'sshlite.connect', title: 'Connect' },
        { id: 'sshlite.disconnect', title: 'Disconnect' },
      ]);
    });

    it('returns empty array when contributes.commands is missing', () => {
      expect(parseCommands({})).toEqual([]);
    });
  });

  describe('parseFlows', () => {
    it('extracts numbered steps under ## Flow heading', () => {
      const md = [
        '# Flow doc',
        '## Flow',
        '1. Connect',
        '2. List files',
        '3. Read a file',
        '## Other',
        '1. Ignored',
      ].join('\n');
      expect(parseFlows(md, 'flow/x.md')).toEqual([
        { name: 'flow/x.md', steps: ['Connect', 'List files', 'Read a file'] },
      ]);
    });

    it('handles a doc with no Flow section', () => {
      expect(parseFlows('# Hello\n\nNo flows here.\n', 'flow/x.md')).toEqual([]);
    });
  });
});
