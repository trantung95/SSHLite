import manifest from '../../package.json';

const commandIconBaseIds = new Set([
  'add', 'archive', 'arrow-circle-down', 'arrow-up', 'bug', 'calendar', 'clear-all',
  'clippy', 'close', 'cloud-download', 'cloud-upload', 'collapse-all', 'copy',
  'dashboard', 'database', 'debug-disconnect', 'diff', 'edit', 'expand-all', 'export',
  'feedback', 'file', 'filter', 'fold-down', 'folder-library', 'folder-opened', 'gear',
  'go-to-file', 'heart', 'history', 'home', 'info', 'key', 'link', 'list-flat',
  'list-tree', 'move', 'new-file', 'new-folder', 'output', 'person', 'pin', 'play',
  'plug', 'pulse', 'refresh', 'remote-explorer', 'root-folder', 'run', 'save',
  'search', 'search-stop', 'server-process', 'shield', 'sign-in', 'sign-out', 'star',
  'stop', 'stop-circle', 'symbol-snippet', 'symbol-variable', 'tag', 'target',
  'terminal', 'terminal-bash', 'trash',
]);

// `sync` is only a modifier-syntax fixture; 66 command icon base IDs remain in use.
const minimumSupportedBaseIcons = new Set([...commandIconBaseIds, 'sync']);

const baseCodiconId = (icon?: string): string | undefined =>
  icon?.match(/^\$\(([a-z][a-z0-9-]*)(?:~spin)?\)$/)?.[1];

const expectedIcons: Record<string, string> = {
  'sshLite.importConnections': '$(arrow-circle-down)',
  'sshLite.forwardPort': '$(add)',
  'sshLite.cancelSearch': '$(search-stop)',
  'sshLite.cutRemoteItem': '$(move)',
  'sshLite.manageSnippets': '$(symbol-snippet)',
  'sshLite.pushPubKeyToHost': '$(key)',
  'sshLite.diagnoseSlowness': '$(pulse)',
  'sshLite.pinFolder': '$(pin)',
  'sshLite.deletePinnedFolder': '$(close)',
  'sshLite.clearAuditLog': '$(clear-all)',
  'sshLite.showBackupLogs': '$(output)',
  'sshLite.showServerBackups': '$(archive)',
  'sshLite.manageRemoteService': '$(gear)',
};

const expectedTitles: Record<string, string> = {
  'sshLite.showSearch': 'Advanced Search — Content, Filenames, Scopes, and Servers',
  'sshLite.searchServerForFilter': 'Deep Scan Current Filter — Add Matches to Remote Files',
  'sshLite.filterFiles': 'Filter Loaded Files by Name',
  'sshLite.forwardPort': 'Create Port Forward — Automatically Save Rule',
  'sshLite.stopForward': 'Stop Port Forward — Keep Saved Rule',
  'sshLite.clearActivities': 'Clear Activity List — Running Operations Continue',
  'sshLite.deleteSavedForward': 'Delete Saved Rule Permanently',
};

const expectedTitleMenus = [
  ['sshLite.addHost', 'view == sshLite.hosts', 'navigation@1'],
  ['sshLite.refreshHosts', 'view == sshLite.hosts', 'navigation@2'],
  ['sshLite.connectionsSyncMenu', 'view == sshLite.hosts', 'navigation@4'],
  ['sshLite.filterHosts', 'view == sshLite.hosts && !sshLite.hasHostFilter', 'navigation@3'],
  ['sshLite.clearHostFilter', 'view == sshLite.hosts && sshLite.hasHostFilter', 'navigation@3'],
  ['sshLite.hostsViewAsList', 'view == sshLite.hosts && sshLite.hostsGrouped', 'navigation@5'],
  ['sshLite.hostsViewAsTree', 'view == sshLite.hosts && !sshLite.hostsGrouped', 'navigation@5'],
  ['sshLite.expandAll', 'view == sshLite.hosts && sshLite.hosts.expandState == 0', 'navigation@99'],
  ['sshLite.expandFirstLevel', 'view == sshLite.hosts && sshLite.hosts.expandState == 1', 'navigation@99'],
  ['sshLite.collapseAll', 'view == sshLite.hosts && sshLite.hosts.expandState == 2', 'navigation@99'],
  ['sshLite.goToPath', 'view == sshLite.fileExplorer', 'navigation@1'],
  ['sshLite.goToParent', 'view == sshLite.fileExplorer', 'navigation@2'],
  ['sshLite.goToHome', 'view == sshLite.fileExplorer', 'navigation@3'],
  ['sshLite.goToRoot', 'view == sshLite.fileExplorer', 'navigation@4'],
  ['sshLite.refreshFiles', 'view == sshLite.fileExplorer', 'navigation@5'],
  ['sshLite.showSearch', 'view == sshLite.fileExplorer', 'navigation@6'],
  ['sshLite.searchServerForFilter', 'view == sshLite.fileExplorer', 'navigation@7'],
  ['sshLite.filterFiles', 'view == sshLite.fileExplorer', 'navigation@8'],
  ['sshLite.revealInTree', 'view == sshLite.fileExplorer', 'navigation@9'],
  ['sshLite.clearFilenameFilter', 'view == sshLite.fileExplorer && sshLite.hasFilenameFilter', 'navigation@10'],
  ['sshLite.expandAll', 'view == sshLite.fileExplorer && sshLite.fileExplorer.expandState == 0', 'navigation@99'],
  ['sshLite.expandFirstLevel', 'view == sshLite.fileExplorer && sshLite.fileExplorer.expandState == 1', 'navigation@99'],
  ['sshLite.collapseAll', 'view == sshLite.fileExplorer && sshLite.fileExplorer.expandState == 2', 'navigation@99'],
  ['sshLite.toggleActivityGrouping', 'view == sshLite.activity', 'navigation@1'],
  ['sshLite.cancelAllActivities', 'view == sshLite.activity', 'navigation@2'],
  ['sshLite.clearActivities', 'view == sshLite.activity', 'navigation@3'],
  ['sshLite.expandAll', 'view == sshLite.activity && sshLite.activity.expandState == 0', 'navigation@99'],
  ['sshLite.expandFirstLevel', 'view == sshLite.activity && sshLite.activity.expandState == 1', 'navigation@99'],
  ['sshLite.collapseAll', 'view == sshLite.activity && sshLite.activity.expandState == 2', 'navigation@99'],
  ['sshLite.forwardPort', 'view == sshLite.portForwards', 'navigation'],
  ['sshLite.expandAll', 'view == sshLite.portForwards && sshLite.portForwards.expandState == 0', 'navigation@99'],
  ['sshLite.expandFirstLevel', 'view == sshLite.portForwards && sshLite.portForwards.expandState == 1', 'navigation@99'],
  ['sshLite.collapseAll', 'view == sshLite.portForwards && sshLite.portForwards.expandState == 2', 'navigation@99'],
];

const commands = new Map(manifest.contributes.commands.map(command => [command.command, command]));
const titleMenus = manifest.contributes.menus['view/title'];
const itemMenus = manifest.contributes.menus['view/item/context'];

describe('UI manifest contract', () => {
  it('uses the approved command icon mapping', () => {
    expect(Object.fromEntries(Object.keys(expectedIcons).map(id => [id, commands.get(id)?.icon])))
      .toEqual(expectedIcons);
  });

  it('uses only Codicons supported by VS Code 1.85.2 for every command', () => {
    expect(manifest.contributes.commands).toHaveLength(117);
    for (const command of manifest.contributes.commands) {
      const id = baseCodiconId(command.icon);
      expect(id && minimumSupportedBaseIcons.has(id)).toBe(true);
    }
  });

  it('accepts a supported Codicon with a spin modifier', () => {
    const id = baseCodiconId('$(sync~spin)');
    expect(id).toBe('sync');
    expect(id && minimumSupportedBaseIcons.has(id)).toBe(true);
  });

  it.each([
    ['$(sync~)', undefined],
    ['$(sync~bogus)', undefined],
    ['$(sync~spin~extra)', undefined],
  ])('rejects malformed Codicon modifier syntax %s', (icon, expected) => {
    expect(baseCodiconId(icon)).toBe(expected);
  });

  it('keeps adjacent Remote Files actions visually and verbally distinct', () => {
    expect(commands.get('sshLite.showSearch')).toMatchObject({ icon: '$(search)' });
    expect(commands.get('sshLite.searchServerForFilter')).toMatchObject({ icon: '$(remote-explorer)' });
    expect(commands.get('sshLite.filterFiles')).toMatchObject({ icon: '$(filter)' });
    expect(commands.get('sshLite.showSearch')?.title).toContain('Advanced Search');
    expect(commands.get('sshLite.searchServerForFilter')?.title).toContain('Deep Scan');
  });

  it('explains stop, clear, and delete consequences in action titles', () => {
    expect(commands.get('sshLite.stopForward')?.title).toContain('Keep Saved Rule');
    expect(commands.get('sshLite.clearActivities')?.title).toContain('Running Operations Continue');
    expect(commands.get('sshLite.deleteSavedForward')?.title).toContain('Delete Saved Rule');
  });

  it('uses the approved descriptive command titles exactly', () => {
    expect(Object.fromEntries(Object.keys(expectedTitles).map(id => [id, commands.get(id)?.title])))
      .toEqual(expectedTitles);
  });

  it('keeps the manifest entries that encode approved visible title states', () => {
    const navigation = (view: string) => titleMenus.filter(item =>
      item.when?.includes(`view == ${view}`) && item.group?.startsWith('navigation'));
    expect(navigation('sshLite.hosts')).toHaveLength(10);
    expect(navigation('sshLite.fileExplorer')).toHaveLength(13);
    expect(navigation('sshLite.activity')).toHaveLength(6);
    expect(navigation('sshLite.portForwards')).toHaveLength(4);
  });

  it('keeps approved title-toolbar command, condition, and group mappings', () => {
    const views = ['sshLite.hosts', 'sshLite.fileExplorer', 'sshLite.activity', 'sshLite.portForwards'];
    const mappings = titleMenus
      .filter(item => views.some(view => item.when?.includes(`view == ${view}`)) && item.group?.startsWith('navigation'))
      .map(item => [item.command ?? item.submenu, item.when, item.group]);
    const sortMappings = (items: string[][]) => items.sort((left, right) => left.join('\0').localeCompare(right.join('\0')));
    expect(sortMappings(mappings)).toEqual(sortMappings([...expectedTitleMenus]));
  });

  it('keeps Port Forwards row action parity', () => {
    const portForwardRows = itemMenus
      .filter(item => item.when === 'view == sshLite.portForwards && viewItem == forward'
        || item.when === 'view == sshLite.portForwards && viewItem == savedForward')
      .map(item => [item.command, item.when, item.group]);
    expect(portForwardRows).toEqual([
      ['sshLite.stopForward', 'view == sshLite.portForwards && viewItem == forward', 'inline'],
      ['sshLite.activateSavedForward', 'view == sshLite.portForwards && viewItem == savedForward', 'inline@1'],
      ['sshLite.deleteSavedForward', 'view == sshLite.portForwards && viewItem == savedForward', 'inline@2'],
    ]);
  });
});
