// Turn raw Secure Entry external-data records into normalized access events.
//
// A Secure Entry record looks like (abridged, from ACS Pro 6.16):
//   { OccurrenceTime: "2026-11-04 03:13:37.0000000", Source: "d1",
//     Data: { Event:      {Value: "Access granted through d1"},
//             Location:   {Value: "d1\nDirection: From side A\nZone: To Zone01\nUnit: AXIS A1610 [...]"},
//             cardholder: {DataType: "HiddenContent", Value: "test test"},
//             cardnumber: {DataType: "HiddenContent", Value: "1000000001"},
//             event_type: {DataType: "HiddenContent", Value: "AccessGranted"} } }

import crypto from 'node:crypto';
import { parseAcsTime } from './time.js';

const val = (data, key) => {
  const v = data?.[key];
  if (v == null) return undefined;
  if (typeof v === 'object') return v.Value ?? v.value;
  return v;
};

/**
 * Read the "Zone:" line of an event's Location text. Badges read "To X", "From X" or "Inside X".
 * Any other wording (another language, a form not seen yet) comes back as 'unknown' rather than a guess.
 */
export function parseZoneLine(lines) {
  const text = lines.map((l) => /^Zone:\s*(.+)$/i.exec(l)?.[1]?.trim()).find(Boolean);
  if (!text) return { zoneAction: null, zoneName: null, zoneText: null };
  const m = /^(To|From|Inside)\s+(.+)$/i.exec(text);
  return m ? { zoneAction: m[1].toLowerCase(), zoneName: m[2], zoneText: text } : { zoneAction: 'unknown', zoneName: null, zoneText: text };
}

/** Stable content fingerprint. ACS records have no ID, so identical content == same record. */
export function fingerprint(rec) {
  const data = rec?.Data ?? {};
  const canon = Object.keys(data).sort().map((k) => [k, val(data, k) ?? null]);
  const s = JSON.stringify([rec?.OccurrenceTime ?? null, rec?.Source ?? null, canon]);
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);
}

/**
 * @returns {{
 *   fp: string, time: number, occurrenceTime: string, door: string|null,
 *   eventType: string|null, eventText: string|null, cardholder: string|null, cardNumber: string|null,
 *   fromSide: 'A'|'B'|null, unit: string|null,
 *   zoneAction: 'to'|'from'|'inside'|'unknown'|null, zoneName: string|null, zoneText: string|null
 * }}
 */
export function normalizeRecord(rec) {
  const data = rec?.Data ?? {};
  const location = String(val(data, 'Location') ?? '');
  const locLines = location.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // Door name: Source, or the first line of Location when Source is missing (e.g. door was deleted).
  const door = (rec?.Source && String(rec.Source).trim()) || locLines[0] || null;
  const dir = /Direction:\s*From side\s*([AB])/i.exec(location);
  const unit = /Unit:\s*(.+)$/im.exec(location)?.[1] ?? null;

  let cardholder = val(data, 'cardholder');
  let cardNumber = val(data, 'cardnumber');
  // Fall back to the display "Cardholder" text: "Name\nCard numbers: 123 (Used)"
  const display = val(data, 'Cardholder');
  if ((!cardholder || !cardNumber) && typeof display === 'string') {
    const lines = display.split(/\r?\n/);
    // Unidentified credentials appear here too ("Card number: ...", "Credential used (PIN code): ..."): never treat those as a name.
    if (!cardholder && lines[0] && !/^(Card number|Credential used)/i.test(lines[0])) cardholder = lines[0].trim();
    if (!cardNumber) cardNumber = /Card numbers?:\s*([^\s(]+)/i.exec(display)?.[1];
  }

  return {
    fp: fingerprint(rec),
    time: parseAcsTime(rec?.OccurrenceTime),
    occurrenceTime: rec?.OccurrenceTime ?? null,
    door,
    eventType: val(data, 'event_type') ?? null,
    eventText: (val(data, 'Event') ?? '').split(/\r?\n/)[0] || null,
    cardholder: cardholder ? String(cardholder).trim() : null,
    cardNumber: cardNumber ? String(cardNumber).trim() : null,
    fromSide: dir ? dir[1].toUpperCase() : null,
    unit,
    ...parseZoneLine(locLines),
  };
}

/** Build the server-side Filter expression for a list of event types. */
export function eventTypeFilter(eventTypes) {
  if (!eventTypes?.length) return undefined;
  // Values are simple identifiers (AccessGranted, ...); reject anything that could break the filter grammar.
  for (const t of eventTypes) if (!/^[A-Za-z0-9_]+$/.test(t)) throw new Error(`invalid event type in config: ${t}`);
  return eventTypes.map((t) => `[event_type] = ${t}`).join(' OR ');
}
