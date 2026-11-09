import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRecord, fingerprint, eventTypeFilter } from '../src/normalize.js';
import { computeOccupancy, classify } from '../src/occupancy.js';
import { parseAcsTime, formatAcsTime } from '../src/time.js';
import { buildMusterCsv } from '../src/facilityOsSink.js';
import { validateOffSiteZones, securityWarnings, DEFAULTS } from '../src/config.js';
import { makeRecord } from './mockAcs.js';

// Record format captured from ACS Pro 6.16.19560, with identifiers replaced.
const REAL = {
  OccurrenceTime: '2026-11-04 03:13:37.0000000', Source: 'd1',
  Data: {
    Event: { DataType: 'Text', Value: 'Access granted through d1' },
    Cardholder: { DataType: 'Text', Value: 'test test\nCard numbers: 1000000001 (Used)' },
    Photo: { DataType: 'Text', Value: '' },
    Location: { DataType: 'Text', Value: 'd1\nDirection: From side A\nUnit: AXIS A1610 [axis-controller.lan]' },
    cardholder: { DataType: 'HiddenContent', Value: 'test test' },
    cardnumber: { DataType: 'HiddenContent', Value: '1000000001' },
    event_type: { DataType: 'HiddenContent', Value: 'AccessGranted' },
    licenceplate: { DataType: 'HiddenContent', Value: '' },
  },
};

const cfg = () => ({ ...DEFAULTS, offSiteZones: ['Parking garage'] });
const T0 = Date.UTC(2026, 10, 6, 13, 0, 0);
const ev = (o) => normalizeRecord(makeRecord(o));

test('time helpers round-trip and match ACS formats', () => {
  assert.equal(parseAcsTime('2026-11-04 03:13:37.0000000'), Date.UTC(2026, 10, 4, 3, 13, 37));
  assert.equal(formatAcsTime(Date.UTC(2026, 10, 4, 3, 13, 37, 250)), '2026-11-04 03:13:37.250');
  assert.ok(Number.isNaN(parseAcsTime('garbage')));
});

test('normalizes a real Secure Entry AccessGranted record', () => {
  const n = normalizeRecord(REAL);
  assert.equal(n.door, 'd1');
  assert.equal(n.fromSide, 'A');
  assert.equal(n.eventType, 'AccessGranted');
  assert.equal(n.cardholder, 'test test');
  assert.equal(n.cardNumber, '1000000001');
  assert.equal(n.unit, 'AXIS A1610 [axis-controller.lan]');
  assert.equal(n.time, Date.UTC(2026, 10, 4, 3, 13, 37));
});

test('falls back to Location first line when Source is missing (deleted door)', () => {
  const r = structuredClone(REAL); delete r.Source;
  assert.equal(normalizeRecord(r).door, 'd1');
});

test('falls back to display Cardholder text when hidden fields are absent', () => {
  const r = structuredClone(REAL); delete r.Data.cardholder; delete r.Data.cardnumber;
  const n = normalizeRecord(r);
  assert.equal(n.cardholder, 'test test');
  assert.equal(n.cardNumber, '1000000001');
});

test('fingerprint is stable regardless of key order and distinguishes content', () => {
  const reordered = { ...REAL, Data: Object.fromEntries(Object.entries(REAL.Data).reverse()) };
  assert.equal(fingerprint(REAL), fingerprint(reordered));
  const other = structuredClone(REAL); other.Data.cardnumber.Value = '1';
  assert.notEqual(fingerprint(REAL), fingerprint(other));
});

test('event type filter grammar matches what ACS accepts and rejects injection', () => {
  assert.equal(eventTypeFilter(['AccessGranted', 'X']), '[event_type] = AccessGranted OR [event_type] = X');
  assert.throws(() => eventTypeFilter(['a] OR [x']));
});

// Location text verbatim from ACS Pro 6.16 / Secure Entry 2, captured 2026-11-08.
const loc = (zone) => normalizeRecord({ ...REAL, Data: { ...REAL.Data, Location: { DataType: 'Text', Value: `d1\nDirection: From side A\nZone: ${zone}\nUnit: AXIS A1610 [x]` } } });

test('reads the zone line of real badge records', () => {
  assert.deepEqual([loc('To Zone01').zoneAction, loc('To Zone01').zoneName], ['to', 'Zone01']);
  assert.deepEqual([loc('From Zone01').zoneAction, loc('From Zone01').zoneName], ['from', 'Zone01']);
  assert.deepEqual([loc('Inside Zone01').zoneAction, loc('Inside Zone01').zoneName], ['inside', 'Zone01']);
  assert.equal(loc('To To Be Decided').zoneName, 'To Be Decided');
  assert.equal(normalizeRecord(REAL).zoneAction, null);
  assert.equal(loc('Zone01').zoneAction, 'unknown');
  assert.equal(loc('Till Zone01').zoneText, 'Till Zone01');
});

test('a badge enters, leaves or confirms a zone from its own zone line, whichever side was used', () => {
  const c = cfg();
  assert.deepEqual(classify(ev({ t: T0, door: 'D', side: 'A', name: 'Ann', card: 1, zone: 'To Zone01' }), c), { action: 'enter', zone: 'Zone01' });
  assert.deepEqual(classify(ev({ t: T0, door: 'D', side: 'A', name: 'Ann', card: 1, zone: 'From Zone01' }), c), { action: 'leave', zone: 'Zone01' });
  assert.deepEqual(classify(ev({ t: T0, door: 'D', side: 'B', name: 'Ann', card: 1, zone: 'Inside Zone01' }), c), { action: 'confirm', zone: 'Zone01' });
  assert.match(classify(ev({ t: T0, door: 'D', side: 'A', name: 'Ann', card: 1, zone: 'To Zone01', type: 'AccessDeniedAnonymous' }), c).reason, /event type/);
  assert.equal(classify(ev({ t: T0, door: 'D', side: 'A', name: 'Ann', card: 1, zone: null }), c).reason, 'door is not in a zone');
});

test('wording that cannot be read is not counted and is flagged', () => {
  const c = cfg();
  const ctx = { zones: new Set(['A', 'B']), doorZones: new Map([['D', ['A', 'B']]]) };
  const read = (zone) => classify(ev({ t: T0, door: 'D', side: 'A', name: 'Ann', card: 1, zone }), c, ctx);
  assert.equal(read('Vers A').unreadable, true);
  assert.equal(read('From A to B').unreadable, true); // must not be read as leaving a zone called "A to B"
  assert.equal(read(null).unreadable, true);          // ACS says the door has a zone, but the badge names none
  assert.equal(read('From A').action, 'leave');
});

test('only the latest badge at a door decides whether it is flagged as unreadable', () => {
  const c = cfg();
  const ctx = { zones: new Set(['Z']), doorZones: new Map([['D', ['Z']]]) };
  const old = ev({ t: T0, door: 'D', side: 'A', name: 'Ann', card: 1, zone: null }); // before the door joined a zone
  const good = ev({ t: T0 + 1000, door: 'D', side: 'A', name: 'Ann', card: 1, zone: 'To Z' });
  assert.equal(computeOccupancy([old], c, T0, ctx).unreadableDoors.length, 1);
  assert.deepEqual(computeOccupancy([old, good], c, T0, ctx).unreadableDoors, []);
});

test('leaving a zone takes a person off site and they are never unconfirmed', () => {
  const c = cfg();
  const j = [ev({ t: T0, door: 'D', side: 'A', name: 'Ann', card: 1, zone: 'To Z' }), ev({ t: T0 + 1000, door: 'D', side: 'A', name: 'Ann', card: 1, zone: 'From Z' })];
  const o = computeOccupancy(j, c, T0 + 19 * 3600_000);
  assert.equal(o.totals.onSite, 0);
  assert.equal(o.totals.onSiteStale, 0);
  assert.equal(o.totals.offSite, 1);
  assert.equal(o.people[0].stale, false);
  assert.equal(o.people[0].zoneName, 'Not in a zone');
});

test('an inside-door badge resets the unconfirmed timer and places someone whose entry was missed', () => {
  const c = cfg();
  const inn = ev({ t: T0, door: 'Front', side: 'A', name: 'Ann', card: 1, zone: 'To Z' });
  const confirm = ev({ t: T0 + 10 * 3600_000, door: 'Lab', side: 'A', name: 'Ann', card: 1, zone: 'Inside Z' });
  assert.equal(computeOccupancy([inn], c, T0 + 19 * 3600_000).totals.onSite, 0);
  const o = computeOccupancy([inn, confirm], c, T0 + 19 * 3600_000);
  assert.equal(o.totals.onSite, 1);
  assert.equal(o.people[0].lastAction, 'confirm');
  const missed = computeOccupancy([ev({ t: T0, door: 'Lab', side: 'A', name: 'Bob', card: 2, zone: 'Inside Z' })], c, T0);
  assert.deepEqual(missed.musterList.map((p) => p.zoneName), ['Z']);
});

test('zones marked off site do not count; zones with nobody still appear', () => {
  const c = cfg();
  const j = [
    ev({ t: T0, door: 'Gate', side: 'A', name: 'Ann', card: 1, zone: 'To Parking garage' }),
    ev({ t: T0 + 1000, door: 'Gate', side: 'A', name: 'Bob', card: 2, zone: 'To Parking garage' }),
    ev({ t: T0 + 60_000, door: 'Lobby', side: 'A', name: 'Ann', card: 1, zone: 'To Building' }),
  ];
  const o = computeOccupancy(j, c, T0 + 120_000, { zones: new Set(['Empty wing']) });
  assert.equal(o.totals.onSite, 1);
  assert.deepEqual(o.musterList.map((p) => p.name), ['Ann']);
  assert.equal(o.zones.find((z) => z.name === 'Parking garage').count, 1);
  assert.equal(o.zones.find((z) => z.name === 'Empty wing').count, 0);
  c.offSiteZones = [];
  assert.equal(computeOccupancy(j, c, T0 + 120_000).totals.onSite, 2);
});

test('late-arriving older event does not override a newer one', () => {
  const c = cfg();
  const exitLater = ev({ t: T0 + 3600_000, door: 'Front door', side: 'B', name: 'Ann', card: 1 }); // left at 14:00
  const enterEarlier = ev({ t: T0, door: 'Front door', side: 'A', name: 'Ann', card: 1 });         // entered 13:00, delivered late
  const o = computeOccupancy([exitLater, enterEarlier], c, T0 + 2 * 3600_000);
  assert.equal(o.people[0].zoneName, 'Not in a zone');
  assert.equal(o.totals.onSite, 0);
});

test('people without a badge for staleAfterHours are reported as unconfirmed, not on site', () => {
  const c = cfg();
  const j = [ev({ t: T0, door: 'Front door', side: 'A', name: 'Ann', card: 1 })];
  assert.equal(computeOccupancy(j, c, T0 + 17 * 3600_000).totals.onSite, 1);
  const o = computeOccupancy(j, c, T0 + 19 * 3600_000);
  assert.equal(o.totals.onSite, 0);
  assert.equal(o.totals.onSiteStale, 1);
});

test('person key by card number keeps same-name cardholders apart', () => {
  const c = cfg(); c.presence = { ...c.presence, personKey: 'cardnumber' };
  const j = [
    ev({ t: T0, door: 'Front door', side: 'A', name: 'Alex Smith', card: 1 }),
    ev({ t: T0 + 1, door: 'Front door', side: 'A', name: 'Alex Smith', card: 2 }),
  ];
  assert.equal(computeOccupancy(j, c, T0).totals.onSite, 2);
  assert.equal(computeOccupancy(j, cfg(), T0).totals.onSite, 1); // default: by name (documented limitation)
});

test('a PIN in the display text is never taken for a cardholder name', () => {
  const n = normalizeRecord({ OccurrenceTime: REAL.OccurrenceTime, Source: 'd1', Data: {
    Cardholder: { DataType: 'Text', Value: 'Credential used (PIN code): 1234' },
    Location: { DataType: 'Text', Value: 'd1' }, event_type: { DataType: 'HiddenContent', Value: 'AccessDeniedAnonymous' },
  } });
  assert.equal(n.cardholder, null);
});

test('startup warnings cover risky network settings only', () => {
  const base = { server: { host: '127.0.0.1' }, acs: { baseUrl: 'https://localhost:29204', tls: { allowSelfSigned: true } } };
  assert.deepEqual(securityWarnings(base), []);
  assert.match(securityWarnings({ ...base, server: { host: '0.0.0.0' } })[0], /no login/);
  assert.match(securityWarnings({ ...base, acs: { baseUrl: 'https://acs:29204', tls: { allowSelfSigned: true } } })[0], /not being verified/);
  assert.deepEqual(securityWarnings({ ...base, acs: { baseUrl: 'https://acs:29204', tls: { fingerprint256: 'AA' } } }), []);
  assert.match(securityWarnings({ ...base, acs: { baseUrl: 'http://acs:29204', tls: {} } })[0], /unencrypted/);
});

test('off-site zone setting validation', () => {
  assert.deepEqual(validateOffSiteZones(['Garage']), []);
  assert.match(validateOffSiteZones('Garage')[0], /list/);
  assert.match(validateOffSiteZones([''])[0], /invalid/);
});

test('muster CSV escapes and neutralizes formula injection', () => {
  const csv = buildMusterCsv([{ name: '=HYPERLINK("x")', cardNumbers: ['1'], zoneName: 'Bldg, North', lastSeen: 'T', lastDoor: 'd1', stale: false }], DEFAULTS.facilityOs.csvColumns);
  const row = csv.split('\r\n')[1];
  assert.ok(row.startsWith(`"'=HYPERLINK(""x"")"`), row);
  assert.ok(row.includes('"Bldg, North"'));
});
