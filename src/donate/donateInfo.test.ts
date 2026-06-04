/**
 * Donate single-source ↔ README sync.
 *
 * `donate/donateInfo.ts` is the single source of truth for donate content; the
 * Donate webview reads from it directly (so it auto-updates). The README mirrors
 * the same data as static markdown — this test FAILS if they drift, so changing
 * an address/message in one place forces updating the other (the project's
 * established "drift test" pattern, like catalogDrift).
 *
 * Addresses are money-critical (see .adn/lessons.md 2026-05-19) — this is the
 * net that catches an accidental edit in just one location.
 */
import * as fs from 'fs';
import * as path from 'path';
import { DONATE } from './donateInfo';

const repoRoot = path.resolve(__dirname, '..', '..');
const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

describe('donate single-source ↔ README sync', () => {
  it('every chain address appears verbatim in README', () => {
    for (const c of DONATE.chains) {
      expect(readme).toContain(c.address);
    }
  });

  it('subtitle, tips and footer appear in README', () => {
    expect(readme).toContain(DONATE.subtitle);
    for (const tip of DONATE.tips) {
      expect(readme).toContain(tip);
    }
    expect(readme).toContain(DONATE.footer);
  });

  it('each QR file is referenced in README and shipped under images/donate/', () => {
    for (const c of DONATE.chains) {
      expect(readme).toContain(c.qrFile);
      expect(fs.existsSync(path.join(repoRoot, 'images', 'donate', c.qrFile))).toBe(true);
    }
  });

  it('the shipped QR (images/donate) is byte-identical to the README QR (docs/images/donate)', () => {
    // docs/** is excluded from the .vsix, so the webview loads QR from images/donate/
    // while README renders docs/images/donate/. They MUST match or a donor scanning
    // the README QR and a donor scanning the panel QR would hit different addresses.
    for (const c of DONATE.chains) {
      const shipped = fs.readFileSync(path.join(repoRoot, 'images', 'donate', c.qrFile));
      const docsCopy = fs.readFileSync(path.join(repoRoot, 'docs', 'images', 'donate', c.qrFile));
      expect(shipped.equals(docsCopy)).toBe(true);
    }
  });
});
