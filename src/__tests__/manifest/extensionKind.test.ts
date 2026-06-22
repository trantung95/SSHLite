/**
 * Regression net for the "host list empty / cannot Add Host inside a Remote-SSH
 * window" bug — a recurrence of the v0.8.17 extension-placement bug.
 *
 * Root cause: package.json declared `extensionKind: ["ui", "workspace"]`. The
 * "workspace" entry let VS Code run SSH Lite on the REMOTE (workspace) extension
 * host inside a Remote-SSH window. Running there,
 * `getConfiguration('sshLite').get('hosts')` reads the SERVER's settings (empty)
 * and `os.homedir()` is the SERVER's home, so the saved host list — which lives
 * on the user's LOCAL machine — is invisible and Add Host writes to the wrong
 * scope. Symptom: "no host list, cannot add host" in the Remote-SSH window,
 * while the same user's local window works fine.
 *
 * Fix: `extensionKind` MUST be exactly ["ui"] so VS Code always runs SSH Lite on
 * the user's local machine, even inside a Remote-SSH window (Marketplace shows
 * "Install in Local", same as Remote-SSH itself and the PDF Viewer). This test
 * fails the moment "workspace" — or anything other than a lone "ui" — creeps
 * back into the manifest.
 *
 * See .adn/lessons.md "2026-06-22" and overview.md "Extension host model".
 */
import * as fs from 'fs';
import * as path from 'path';

describe('package.json extensionKind — Remote-SSH host-list regression net', () => {
  const pkg = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'package.json'),
      'utf-8',
    ),
  );

  it('is declared (never relies on VS Code default placement)', () => {
    expect(pkg.extensionKind).toBeDefined();
  });

  it('is exactly ["ui"] so SSH Lite always runs on the user\'s local machine', () => {
    expect(pkg.extensionKind).toEqual(['ui']);
  });

  it('does NOT include "workspace" (would let it run on the remote host and hide the local host list)', () => {
    expect(Array.isArray(pkg.extensionKind)).toBe(true);
    expect(pkg.extensionKind).not.toContain('workspace');
  });
});
