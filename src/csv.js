// CSV export of the people on site.

const HEADERS = ['Name', 'CardNumbers', 'Zone', 'LastSeenUtc', 'LastDoor'];

const cell = (value) => {
  let s = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralize spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function buildOnSiteCsv(people) {
  const rows = people.map((p) => [p.name, p.cardNumbers?.join(';'), p.zoneName, p.lastSeen, p.lastDoor]);
  return [HEADERS, ...rows].map((row) => row.map(cell).join(',')).join('\r\n') + '\r\n';
}
