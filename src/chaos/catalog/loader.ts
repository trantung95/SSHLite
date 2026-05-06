/**
 * Chaos catalog loader
 *
 * Reads the generated catalog JSON files at test time and validates them
 * against the registered primitive set.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Action } from '../ChaosTypes';
import type { CatalogCommand, CatalogFlow } from './builder';

export interface LoadedCatalog {
  actions: Action[];
  flows: CatalogFlow[];
  commands: CatalogCommand[];
}

export function loadCatalog(repoRoot: string): LoadedCatalog {
  const dir = path.join(repoRoot, 'src', 'chaos', 'catalog');
  return {
    actions: JSON.parse(fs.readFileSync(path.join(dir, 'actions.json'), 'utf8')),
    flows: JSON.parse(fs.readFileSync(path.join(dir, 'flows.json'), 'utf8')),
    commands: JSON.parse(fs.readFileSync(path.join(dir, 'commands.json'), 'utf8')),
  };
}

/** Throws if any action references a primitive name not in the registered set. */
export function validateAgainstPrimitives(catalog: LoadedCatalog, primitiveNames: Set<string>): void {
  for (const a of catalog.actions) {
    for (const p of a.primitives) {
      if (!primitiveNames.has(p)) {
        throw new Error(`Action "${a.name}" (${a.source}) references unknown primitive: ${p}`);
      }
    }
  }
}
