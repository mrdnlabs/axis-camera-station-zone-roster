// Occupancy engine: folds the de-duplicated event journal into "who is in which zone".
//
// Secure Entry states the movement on every badge at a zoned door, in the event's Location text:
//   Zone: To Zone01       the person entered Zone01
//   Zone: From Zone01     the person left Zone01 (and is now in no zone)
//   Zone: Inside Zone01   an inside door: the person is still in Zone01
// The zone comes from each event, so door sides don't matter and a door that gets reversed in
// Secure Entry keeps working.
//
// State is derived purely from the journal ordered by *occurrence time*, so late-arriving records
// (edge controllers uploading after a network blip) slot into the right place and re-reading
// the same window never double counts.

export function personKeyOf(ev, mode = 'cardholder') {
  if (mode === 'cardnumber') return ev.cardNumber ? `card:${ev.cardNumber}` : (ev.cardholder ? `name:${ev.cardholder.toLowerCase()}` : null);
  return ev.cardholder ? `name:${ev.cardholder.toLowerCase()}` : (ev.cardNumber ? `card:${ev.cardNumber}` : null);
}

const isGranted = (ev, cfg) => (cfg.polling?.eventTypes ?? ['AccessGranted']).includes(ev.eventType);
const unreadable = (reason) => ({ action: 'ignore', reason, unreadable: true });

/**
 * Decide what an event does.
 * @param ctx {zones: Set<zone name>, doorZones: Map<door, zone names>} from the ACS door list; may be empty.
 * @returns {{action:'enter'|'leave'|'confirm', zone:string} | {action:'ignore', reason:string, unreadable?:boolean}}
 */
export function classify(ev, cfg, ctx = {}) {
  if (!isGranted(ev, cfg)) return { action: 'ignore', reason: `event type ${ev.eventType}` };
  if (!ev.door) return { action: 'ignore', reason: 'no door' };
  if (!ev.zoneAction) {
    // Either the door has no zone, or (door is in a zone) the event predates that or is worded differently.
    return ctx.doorZones?.get(ev.door)?.length
      ? unreadable('no zone information in this badge')
      : { action: 'ignore', reason: 'door is not in a zone' };
  }
  const notRecognised = () => unreadable(`zone text not recognised: "${ev.zoneText}"`);
  if (ev.zoneAction === 'unknown') return notRecognised();
  // "From X" must name a real zone: wording we haven't seen (such as a door between two zones)
  // must not be read as someone leaving the site.
  // A zone named by earlier badges counts too, so renaming or deleting a zone doesn't undo past exits.
  if (ev.zoneAction === 'from' && ctx.zones?.size && !ctx.zones.has(ev.zoneName) && !ctx.pastZones?.has(ev.zoneName)) return notRecognised();
  const action = { to: 'enter', from: 'leave', inside: 'confirm' }[ev.zoneAction];
  return { action, zone: ev.zoneName };
}

/** Zones that badges in the journal say someone entered or was inside, whether or not ACS still lists them. */
export function pastZones(journal) {
  const names = new Set();
  for (const ev of journal) if (ev.zoneAction === 'to' || ev.zoneAction === 'inside') names.add(ev.zoneName);
  return names;
}

/**
 * @param {Iterable<object>} journal  normalized events
 * @param {object} cfg                full config (offSiteZones, polling.eventTypes, presence)
 * @param {number} nowMs
 * @param {{zones?: Set<string>, doorZones?: Map<string,string[]>}} ctx  zones from the ACS door list
 */
export function computeOccupancy(journal, cfg, nowMs = Date.now(), ctx = {}) {
  const offSite = new Set(cfg.offSiteZones ?? []);
  const countsOnSite = (name) => !offSite.has(name);
  const staleMs = (cfg.presence?.staleAfterHours ?? 18) * 3600_000;
  const keyMode = cfg.presence?.personKey ?? 'cardholder';

  const sorted = [...journal].filter((e) => Number.isFinite(e.time))
    .sort((a, b) => a.time - b.time || (a.fp < b.fp ? -1 : a.fp > b.fp ? 1 : 0));

  const people = new Map();
  const latestAtDoor = new Map();
  const classifyCtx = { ...ctx, pastZones: pastZones(sorted) };
  for (const ev of sorted) {
    const c = classify(ev, cfg, classifyCtx);
    if (ev.door && isGranted(ev, cfg)) latestAtDoor.set(ev.door, c.unreadable ? { door: ev.door, reason: c.reason, lastSeen: new Date(ev.time).toISOString() } : null);
    if (c.action === 'ignore') continue;
    const key = personKeyOf(ev, keyMode);
    if (!key) continue;
    const p = people.get(key) ?? { key, name: ev.cardholder ?? null, cardNumbers: new Set() };
    p.name = ev.cardholder ?? p.name;
    if (ev.cardNumber) p.cardNumbers.add(ev.cardNumber);
    p.zone = c.action === 'leave' ? null : c.zone;
    p.lastTime = ev.time;
    p.lastDoor = ev.door;
    p.lastAction = c.action;
    people.set(key, p);
  }

  const bucket = new Map();
  // People stay counted in a zone that's gone from ACS until they next badge, because nothing says they left.
  const notInAcs = (name) => Boolean(ctx.zones?.size) && !ctx.zones.has(name);
  const zoneBucket = (name) => bucket.get(name) ?? bucket.set(name, { name, onSite: countsOnSite(name), notInAcs: notInAcs(name), count: 0, staleCount: 0 }).get(name);
  for (const name of ctx.zones ?? []) zoneBucket(name);

  const list = [];
  for (const p of people.values()) {
    const inZone = p.zone != null;
    const onSite = inZone && countsOnSite(p.zone);
    const stale = inZone && nowMs - p.lastTime > staleMs; // someone who badged out isn't awaiting confirmation
    list.push({
      key: p.key, name: p.name, cardNumbers: [...p.cardNumbers], zoneName: inZone ? p.zone : 'Not in a zone',
      onSite, stale, lastSeen: new Date(p.lastTime).toISOString(), lastDoor: p.lastDoor, lastAction: p.lastAction,
    });
    if (inZone) { const b = zoneBucket(p.zone); if (stale) b.staleCount++; else b.count++; }
  }
  list.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

  const here = list.filter((p) => p.onSite && !p.stale);
  return {
    computedAt: new Date(nowMs).toISOString(),
    totals: {
      onSite: here.length,
      onSiteStale: list.filter((p) => p.onSite && p.stale).length,
      offSite: list.filter((p) => !p.onSite).length,
      knownPeople: list.length,
    },
    zones: [...bucket.values()].sort((a, b) => a.name.localeCompare(b.name)),
    people: list,
    onSiteList: here,
    unreadableDoors: [...latestAtDoor.values()].filter(Boolean),
  };
}
