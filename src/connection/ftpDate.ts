/**
 * FTP modification-time parsing.
 *
 * `basic-ftp` only fills `FileInfo.modifiedAt` (a real Date) when the server
 * answers the machine-readable MLSD command. Most FTP/FTPS servers answer the
 * older LIST command instead, where basic-ftp leaves `modifiedAt` undefined and
 * exposes only `rawModifiedAt` — a human string such as `"Dec 11 14:35"`,
 * `"Dec 11 2023"` or the DOS `"06-16-24 10:30AM"`.
 *
 * Before this parser the mapping did `modifiedAt ? modifiedAt.getTime() : 0`, so
 * every LIST-mode file fell back to 0 = 1 Jan 1970 and rendered as "56 years ago"
 * (issue #15). This module turns `rawModifiedAt` into a best-effort Unix-ms
 * timestamp, returning `undefined` only when nothing parseable is available.
 *
 * LIST dates carry no timezone, so they are interpreted in the client's local
 * time — the same limitation every FTP client has. This is a pure function with
 * an injectable `now` so it is deterministic under test.
 */

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Build a local-time timestamp, rejecting calendar overflow (e.g. Feb 29 in a
 * non-leap year, which the Date constructor would silently roll to Mar 1/2).
 * Returns undefined when the components do not round-trip exactly.
 */
function safeLocalTime(year: number, month: number, day: number, hh = 0, mm = 0): number | undefined {
  const d = new Date(year, month, day, hh, mm);
  if (
    d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day ||
    d.getHours() !== hh || d.getMinutes() !== mm
  ) {
    return undefined;
  }
  return d.getTime();
}

/**
 * Resolve a file's modification time to Unix milliseconds.
 *
 * @param modifiedAt    `FileInfo.modifiedAt` (set only for MLSD servers).
 * @param rawModifiedAt `FileInfo.rawModifiedAt` (the raw LIST date string).
 * @param now           Reference "now" — defaults to the current time; injectable for tests.
 * @returns Unix ms, or `undefined` when no usable date can be derived.
 */
export function parseFtpModifiedTime(
  modifiedAt: Date | undefined,
  rawModifiedAt: string | undefined,
  now: Date = new Date(),
): number | undefined {
  // 1. MLSD path: a real Date is authoritative. Treat epoch (0) as "unknown" —
  //    a genuine 1970 mtime is implausible and is how the old bug surfaced.
  if (modifiedAt instanceof Date) {
    const ms = modifiedAt.getTime();
    if (!Number.isNaN(ms) && ms !== 0) {
      return ms;
    }
  }

  const raw = (rawModifiedAt || '').trim();
  if (!raw) {
    return undefined;
  }

  // 2. Unix LIST, recent files: "Mon D HH:MM" (year omitted, time shown).
  //    ls shows the time only for entries < ~6 months old, so assume the
  //    current year and roll back one year if that lands in the future.
  let m = raw.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon === undefined) {
      return undefined;
    }
    const day = Number(m[2]);
    const hh = Number(m[3]);
    const mm = Number(m[4]);
    let ts = safeLocalTime(now.getFullYear(), mon, day, hh, mm);
    if (ts !== undefined && ts - now.getTime() > DAY_MS) {
      ts = safeLocalTime(now.getFullYear() - 1, mon, day, hh, mm);
    }
    return ts;
  }

  // 3. Unix LIST, old files: "Mon D YYYY" (year shown, time omitted).
  m = raw.match(/^([A-Za-z]{3})\s+(\d{1,2})\s+(\d{4})$/);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (mon === undefined) {
      return undefined;
    }
    return safeLocalTime(Number(m[3]), mon, Number(m[2]));
  }

  // 4. DOS / IIS LIST: "MM-DD-YY[YY] HH:MM(AM|PM)" e.g. "06-16-24 10:30AM".
  m = raw.match(/^(\d{2})-(\d{2})-(\d{2,4})\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
  if (m) {
    const month = Number(m[1]) - 1;
    const day = Number(m[2]);
    let year = Number(m[3]);
    if (year < 100) {
      year += year < 70 ? 2000 : 1900; // 2-digit year window
    }
    let hh = Number(m[4]) % 12;
    if (/p/i.test(m[6])) {
      hh += 12;
    }
    return safeLocalTime(year, month, day, hh, Number(m[5]));
  }

  // 5. Fallback: let the engine try ISO ("2024-06-16 10:30") and other
  //    locale-parseable strings.
  const ts = Date.parse(raw);
  return Number.isNaN(ts) ? undefined : ts;
}
