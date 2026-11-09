// Time helpers for the ACS Pro API.
//
// ACS returns OccurrenceTime as "YYYY-MM-DD hh:mm:ss.fffffff" in UTC (no zone suffix).
// GetExternalData StartTime/EndTime must be sent as "YYYY-MM-DD hh:mm:ss[.fffffff]" in UTC.
// (The PDF says "hh-mm-ss" -- that format is rejected by the server.)

/** Parse an ACS UTC timestamp string into epoch milliseconds. Returns NaN if unparseable. */
export function parseAcsTime(s) {
  if (typeof s !== 'string') return NaN;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(s.trim());
  if (!m) return NaN;
  const ms = m[7] ? Number((m[7] + '000').slice(0, 3)) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
}

/** Format epoch milliseconds as an ACS request timestamp (UTC). */
export function formatAcsTime(ms) {
  const d = new Date(ms);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}`;
}
