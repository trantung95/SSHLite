import * as path from 'path';
import * as fs from 'fs';
import { buildCatalog } from '../../chaos/catalog/builder';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

describe('chaos catalog drift', () => {
  let fresh: ReturnType<typeof buildCatalog>;

  beforeAll(() => {
    fresh = buildCatalog(repoRoot);
  });

  it('actions.json matches what the parser produces from .adn', () => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/chaos/catalog/actions.json'), 'utf8'));
    expect(onDisk).toEqual(fresh.actions);
  });

  it('flows.json matches what the parser produces from .adn/flow', () => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/chaos/catalog/flows.json'), 'utf8'));
    expect(onDisk).toEqual(fresh.flows);
  });

  it('commands.json matches what the parser produces from package.json', () => {
    const onDisk = JSON.parse(fs.readFileSync(path.join(repoRoot, 'src/chaos/catalog/commands.json'), 'utf8'));
    expect(onDisk).toEqual(fresh.commands);
  });
});
