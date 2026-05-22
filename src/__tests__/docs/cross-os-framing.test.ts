/**
 * Cross-OS framing regression net (enforces .adn/lessons.md 2026-05-22
 * "Never default to one-OS framing when the extension supports all OSes").
 *
 * Background: v0.8.17 docs were initially framed entirely around Windows
 * because the bug reporter was on Windows. SSH Lite runs identically on
 * Windows, macOS, and Linux clients — single-OS framing misleads the other
 * two and trains AI sessions to keep defaulting to Windows. This test scans
 * the sections of project docs that describe user-facing client-side
 * behaviour and asserts each one mentions all three OSes.
 *
 * If you intentionally write a section that targets a single OS (e.g. a
 * historical entry about Windows-specific work like the v0.7.5/v0.7.6
 * chaos-script port), add the section heading to OS_SPECIFIC_EXEMPT_HEADINGS
 * below with a justification comment.
 */

import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Section headings that are intentionally OS-specific and exempt from the
 * three-OS rule. Add new entries with a justification comment.
 */
const OS_SPECIFIC_EXEMPT_HEADINGS = new Set<string>([
  // v0.7.5 / v0.7.6: porting chaos scripts to run on Windows. Genuinely
  // Windows-specific tooling work.
  '## v0.7.5 — Deep-check fixes (search hang, log drift, Windows-portable chaos)',
  '## v0.7.6 — Windows-client → Linux-server cross-coverage tests',
]);

/**
 * Slice a markdown file into sections by `##` headings. Each section's body
 * is the text until the next `##` (or EOF). The section's leading line
 * (the `##` heading itself) is the key.
 */
function splitMarkdownSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  let currentHeading: string | null = null;
  let buf: string[] = [];
  for (const line of lines) {
    if (/^##\s/.test(line)) {
      if (currentHeading) {
        sections.set(currentHeading, buf.join('\n'));
      }
      currentHeading = line.trim();
      buf = [];
    } else if (currentHeading) {
      buf.push(line);
    }
  }
  if (currentHeading) {
    sections.set(currentHeading, buf.join('\n'));
  }
  return sections;
}

/**
 * Returns true if the section body discusses client-side user behaviour
 * (downloads to local filesystem, "your machine", install-in-local, etc.)
 * — those are the sections that must mention all three OSes. Sections that
 * are purely about server-side concerns or implementation internals are
 * exempt.
 */
function isClientFacingSection(body: string): boolean {
  return /Install in Local|your local machine|user's (own |local )?machine|local filesystem|local home|downloads? to (the |your )?local|home directory|extensionKind/i.test(body);
}

function osCounts(body: string): { win: number; mac: number; lin: number } {
  return {
    win: (body.match(/\bWindows\b/g) || []).length,
    mac: (body.match(/\bmacOS\b/g) || []).length,
    lin: (body.match(/\bLinux\b/g) || []).length,
  };
}

function dominantSingleOs(body: string): string | null {
  const c = osCounts(body);
  const total = c.win + c.mac + c.lin;
  if (total === 0) return null;
  // A section "dominantly mentions one OS" when ONE OS appears and at least
  // one of the other two doesn't appear at all.
  const present = [['Windows', c.win], ['macOS', c.mac], ['Linux', c.lin]] as const;
  const mentioned = present.filter(([, n]) => n > 0).map(([name]) => name);
  if (mentioned.length === 3) return null; // balanced
  if (mentioned.length === 1) return mentioned[0]; // single-OS domination
  // Exactly 2 of 3 mentioned: also flag, missing one is enough to mislead.
  return `missing: ${present.filter(([, n]) => n === 0).map(([name]) => name).join('+')}`;
}

describe('cross-OS doc framing (.adn/lessons.md 2026-05-22 enforcement)', () => {
  const docsToScan = [
    { rel: '.adn/lessons.md', anchorPredicate: (h: string) => h.startsWith('## 2026-') },
    { rel: '.adn/CHANGELOG.md', anchorPredicate: (h: string) => h.startsWith('## v0.8.17') || h.startsWith('## v0.9') || h.startsWith('## v1.') },
    { rel: 'README.md', anchorPredicate: (h: string) => /Remote-SSH compatibility|Release Notes/i.test(h) },
  ];

  for (const { rel, anchorPredicate } of docsToScan) {
    const abs = path.join(REPO_ROOT, rel);

    it(`${rel}: every client-facing section discusses all three of Windows / macOS / Linux`, () => {
      const content = fs.readFileSync(abs, 'utf8');
      const sections = splitMarkdownSections(content);
      const offenders: string[] = [];

      for (const [heading, body] of sections) {
        if (!anchorPredicate(heading)) continue;
        if (OS_SPECIFIC_EXEMPT_HEADINGS.has(heading)) continue;
        if (!isClientFacingSection(body)) continue;
        const issue = dominantSingleOs(body);
        if (issue) {
          offenders.push(`  - ${heading.slice(0, 80)} → ${issue}`);
        }
      }

      if (offenders.length > 0) {
        throw new Error(
          `Cross-OS framing violation in ${rel}.\n` +
          `The following section(s) mention only one OS (or are missing one of Win/macOS/Linux) ` +
          `while discussing client-side behaviour. SSH Lite supports all three equally; ` +
          `enumerate all of them or add the heading to OS_SPECIFIC_EXEMPT_HEADINGS with a justification.\n` +
          offenders.join('\n')
        );
      }
    });
  }

  it('the v0.8.17 README "Remote-SSH compatibility" section names per-OS home directories', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8');
    const sections = splitMarkdownSections(readme);
    const remoteSshSection = [...sections.entries()].find(
      ([h]) => /Remote-SSH compatibility/i.test(h),
    );
    expect(remoteSshSection).toBeDefined();
    const body = remoteSshSection![1];
    // The home-directory examples are the most user-visible OS-coverage signal.
    expect(body).toMatch(/C:\\Users/);            // Windows example
    expect(body).toMatch(/\/Users\//);             // macOS example
    expect(body).toMatch(/\/home\//);              // Linux example
  });
});
