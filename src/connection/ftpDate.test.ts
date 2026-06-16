import { parseFtpModifiedTime } from './ftpDate';

describe('parseFtpModifiedTime (issue #15)', () => {
  // Fixed reference "now": 16 Jun 2026, 12:00 local.
  const now = new Date(2026, 5, 16, 12, 0, 0);

  it('uses MLSD modifiedAt when present (returns Unix ms)', () => {
    const d = new Date(2024, 0, 15, 10, 30, 0);
    expect(parseFtpModifiedTime(d, undefined, now)).toBe(d.getTime());
  });

  it('treats a missing modifiedAt with no raw string as unknown', () => {
    expect(parseFtpModifiedTime(undefined, undefined, now)).toBeUndefined();
    expect(parseFtpModifiedTime(undefined, '', now)).toBeUndefined();
  });

  it('treats epoch (new Date(0)) as unknown and falls through to raw', () => {
    // The old bug: epoch Date rendered as "56 years ago". Now epoch is ignored.
    expect(parseFtpModifiedTime(new Date(0), undefined, now)).toBeUndefined();
    // ...but if a raw string exists, parse it instead of returning 1970.
    const ts = parseFtpModifiedTime(new Date(0), 'Dec 11 2023', now);
    expect(new Date(ts!).getFullYear()).toBe(2023);
  });

  it('parses a recent Unix LIST date "Mon D HH:MM" using the current year', () => {
    const ts = parseFtpModifiedTime(undefined, 'Jun 11 14:35', now)!;
    const d = new Date(ts);
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(5); // June
    expect(d.getDate()).toBe(11);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(35);
  });

  it('rolls a future "Mon D HH:MM" back to last year (ls 6-month convention)', () => {
    // December is in the future relative to June 2026 → must be Dec 2025.
    const ts = parseFtpModifiedTime(undefined, 'Dec 25 09:00', now)!;
    expect(new Date(ts).getFullYear()).toBe(2025);
    expect(new Date(ts).getMonth()).toBe(11);
  });

  it('parses an old Unix LIST date "Mon D YYYY" (no time)', () => {
    const ts = parseFtpModifiedTime(undefined, 'Mar 3 2021', now)!;
    const d = new Date(ts);
    expect(d.getFullYear()).toBe(2021);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(3);
  });

  it('tolerates double-spaced Unix listings', () => {
    const ts = parseFtpModifiedTime(undefined, 'Jun  5  2020', now)!;
    expect(new Date(ts).getFullYear()).toBe(2020);
  });

  it('parses an ISO-like date string via the engine fallback', () => {
    const ts = parseFtpModifiedTime(undefined, '2024-06-16 10:30', now)!;
    expect(new Date(ts).getFullYear()).toBe(2024);
  });

  it('returns undefined for an unparseable raw string', () => {
    expect(parseFtpModifiedTime(undefined, 'not a date at all', now)).toBeUndefined();
    expect(parseFtpModifiedTime(undefined, 'Xyz 99 99:99', now)).toBeUndefined();
  });

  it('parses DOS / IIS LIST dates "MM-DD-YY HH:MM(AM|PM)"', () => {
    const am = parseFtpModifiedTime(undefined, '06-16-24 10:30AM', now)!;
    expect(new Date(am).getFullYear()).toBe(2024);
    expect(new Date(am).getMonth()).toBe(5);
    expect(new Date(am).getDate()).toBe(16);
    expect(new Date(am).getHours()).toBe(10);

    const pm = parseFtpModifiedTime(undefined, '12-31-2023 01:05PM', now)!;
    expect(new Date(pm).getHours()).toBe(13);
    expect(new Date(pm).getFullYear()).toBe(2023);

    const midnight = parseFtpModifiedTime(undefined, '01-02-25 12:00AM', now)!;
    expect(new Date(midnight).getHours()).toBe(0);
  });

  it('rejects an impossible date (Feb 29 in a non-leap year) instead of rolling over', () => {
    // 2025 is not a leap year — Date would silently roll to Mar 1.
    expect(parseFtpModifiedTime(undefined, 'Feb 29 2025', now)).toBeUndefined();
  });

  it('handles the Dec 31 / Jan 1 rollover boundary', () => {
    const newYear = new Date(2026, 0, 1, 0, 30, 0); // 1 Jan 2026 00:30
    // "Dec 31 23:00" with no year, seen on Jan 1, belongs to the prior year.
    const ts = parseFtpModifiedTime(undefined, 'Dec 31 23:00', newYear)!;
    expect(new Date(ts).getFullYear()).toBe(2025);
    expect(new Date(ts).getMonth()).toBe(11);
  });

  it('treats a Date whose getTime() is NaN as unknown', () => {
    expect(parseFtpModifiedTime(new Date('invalid'), undefined, now)).toBeUndefined();
    expect(new Date(parseFtpModifiedTime(new Date('invalid'), 'Mar 3 2021', now)!).getFullYear()).toBe(2021);
  });
});
