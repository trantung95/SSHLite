/**
 * Chaos personas
 *
 * A persona is a weighted distribution over user actions, defining "what kind
 * of user is this chain pretending to be". Action names are looked up against
 * the catalog at runtime; missing actions are silently dropped by the chain
 * generator (so personas can reference forward-looking actions that ship later).
 *
 * v0.8.0: 6 personas covering the SSH + credential surface. Monitor/watcher
 * personas will gain richer actions in v0.8.1 once monitor and watcher
 * primitives ship.
 */

import { Persona } from '../ChaosTypes';

export const PERSONAS: Persona[] = [
  {
    name: 'explorer',
    weights: {
      'Browse files': 5,
      'Reveal in tree': 3,
      'Load file tree': 2,
    },
    chainLengthRange: [3, 7],
  },
  {
    name: 'editor',
    weights: {
      'Edit a file': 5,
      'Browse files': 2,
      'Rename a file': 1,
      'Delete a file': 1,
      // v0.8.15: exercise the new sudo-write path under chaos faults.
      // Lower weight than plain edits so most editor sessions stay non-elevated.
      'Save as root': 2,
    },
    chainLengthRange: [3, 8],
  },
  {
    name: 'operator',
    weights: {
      'Run terminal': 5,
      'Run command': 3,
      // v0.8.15: operators frequently shell out with sudo.
      'Sudo exec': 2,
    },
    chainLengthRange: [3, 6],
  },
  {
    name: 'watcher',
    weights: {
      'Watch file': 4,
      'Tail logs': 3,
      // v0.8.15: watchers occasionally read root-only files (/etc/shadow-style).
      'Read as root': 1,
    },
    chainLengthRange: [2, 5],
  },
  {
    name: 'searcher',
    weights: {
      'Cross-file search': 4,
      'Edit a file': 1,
    },
    chainLengthRange: [2, 4],
  },
  {
    name: 'admin',
    weights: {
      'Save credential': 3,
      'Delete credential': 2,
      'Look up credential': 2,
      'Connect to host': 2,
      'Disconnect': 1,
      'Browse files': 1,
    },
    chainLengthRange: [2, 5],
  },
];
