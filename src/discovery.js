// Door discovery. ACS Pro has no public "list doors" API; we combine:
//   1. ExternalDataSourceFacade/GetExternalDataSourceList (undocumented, ACS Pro 6.16) -> Secure Entry doors
//   2. distinct door names seen in event data (fallback, and catches deleted/renamed doors)
//   3. DeviceListFacade/GetDeviceList -> door controllers (context only)

import { normalizeRecord } from './normalize.js';

export async function discoverDoors(client, { journal = [], scanDays = 7 } = {}) {
  const doors = new Map();
  const add = (name, patch) => {
    if (!name) return;
    const d = doors.get(name) ?? { name, key: null, pluginId: null, viaSourceList: false, seenInEvents: false, lastSeen: null, sidesSeen: [], units: [], zones: [], role: null, roleAt: null };
    Object.assign(d, patch(d));
    doors.set(name, d);
  };

  let sourceListSupported = false;
  const sources = await client.getExternalDataSourceList().catch(() => null);
  if (Array.isArray(sources)) {
    sourceListSupported = true;
    for (const s of sources) {
      if (s.PluginId && s.PluginId !== 'axis_secureentry') continue; // only Secure Entry doors
      add(s.Name, () => ({ key: s.Key, pluginId: s.PluginId ?? null, viaSourceList: true, zones: s.GroupNames ?? [] }));
    }
  }

  // Scan recent badge events for door names, directions and controller units.
  const events = [...journal];
  if (scanDays > 0) {
    const { results } = await client.getExternalData({
      startMs: Date.now() - scanDays * 86400_000,
      filter: '[event_type] = AccessGranted OR [event_type] = AccessDeniedAnonymous OR [event_type] = AccessDenied',
      pageSize: 1000, maxPages: 20,
    }).catch(() => ({ results: [] }));
    events.push(...results.map(normalizeRecord));
  }
  for (const ev of events) {
    add(ev.door, (d) => ({
      seenInEvents: true,
      lastSeen: !d.lastSeen || ev.time > Date.parse(d.lastSeen) ? new Date(ev.time).toISOString() : d.lastSeen,
      sidesSeen: ev.fromSide && !d.sidesSeen.includes(ev.fromSide) ? [...d.sidesSeen, ev.fromSide].sort() : d.sidesSeen,
      units: ev.unit && !d.units.includes(ev.unit) ? [...d.units, ev.unit] : d.units,
      // "Inside X" marks an inside door; "To X" / "From X" a perimeter door. The newest badge wins.
      ...(['to', 'from', 'inside'].includes(ev.zoneAction) && !(d.roleAt > ev.time)
        ? { role: ev.zoneAction === 'inside' ? 'inside' : 'perimeter', roleAt: ev.time } : {}),
    }));
  }

  const controllers = (await client.getDeviceList().catch(() => []))
    .filter((d) => /door controller/i.test(d.ProductType ?? ''))
    .map((d) => ({ name: d.Name, model: d.Model, address: d.Address, firmware: d.FirmwareVersion, status: d.Status }));

  return {
    sourceListSupported,
    doors: [...doors.values()].sort((a, b) => a.name.localeCompare(b.name)),
    controllers,
  };
}
