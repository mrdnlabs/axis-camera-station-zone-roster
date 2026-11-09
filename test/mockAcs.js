// In-process fake of the ACS Pro API (HTTP, not HTTPS) reproducing the behaviour measured on ACS Pro 6.16:
// newest-first results, NextPageToken paging, [event_type] = X OR ... filters, UTC "YYYY-MM-DD hh:mm:ss" times,
// Basic auth, and the undocumented GetExternalDataSourceList.

import http from 'node:http';
import { parseAcsTime, formatAcsTime } from '../src/time.js';

// Without an explicit zone: side A enters Building and side B leaves it. Pass zone: null for a door with no zone.
export function makeRecord({ t, door, side, name, card, type = 'AccessGranted', unit = 'AXIS A1610 [test]', zone }) {
  const zoneText = zone !== undefined ? zone : side === 'A' ? 'To Building' : side === 'B' ? 'From Building' : null;
  const loc = [door, side ? `Direction: From side ${side}` : null, zoneText ? `Zone: ${zoneText}` : null, `Unit: ${unit}`].filter(Boolean).join('\n');
  const data = {
    Event: { DataType: 'Text', Value: `${type === 'AccessGranted' ? 'Access granted' : type} through ${door}` },
    Location: { DataType: 'Text', Value: loc },
    event_type: { DataType: 'HiddenContent', Value: type },
  };
  if (name) {
    data.Cardholder = { DataType: 'Text', Value: `${name}\nCard numbers: ${card} (Used)` };
    data.cardholder = { DataType: 'HiddenContent', Value: name };
    data.cardnumber = { DataType: 'HiddenContent', Value: String(card) };
  }
  return { OccurrenceTime: formatAcsTime(t).replace(/\.\d+$/, '.0000000'), Source: door, Data: data };
}

export function startMockAcs({ username = 'u', password = 'p', sources = [] } = {}) {
  const state = { records: [], down: false, calls: [], pages: new Map() };
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (state.down) { req.socket.destroy(); return; }
      if (req.headers.authorization !== auth) return send(401);
      const op = req.url.replace('/Acs/Api/', '');
      const q = body ? JSON.parse(body) : {};
      state.calls.push({ op, q });
      if (op === 'VersionFacade/GetApiVersion') return send(200, { Major: 2, Minor: 43, ProductMajor: 6, ProductMinor: 16 });
      if (op === 'SystemFacade/GetSystem') return send(200, { Name: 'MOCK', ServerDisplayVersion: '6.16.0', TimeZone: 'UTC' });
      if (op === 'DeviceListFacade/GetDeviceList') return send(200, { Devices: [{ Name: 'A1610', Model: 'AXIS A1610', ProductType: 'Network Door Controller', Status: 1 }], ContainsLastDevice: true });
      if (op === 'ExternalDataSourceFacade/GetExternalDataSourceList') return send(200, { ExternalDataSources: sources, ContainsLastExternalDataSource: true });
      if (op === 'ExternalDataFacade/GetExternalData') {
        if (q.NextPageToken) {
          const rest = state.pages.get(q.NextPageToken);
          if (!rest) return send(400, { Type: 'CommunicationException', Message: 'bad token' });
          return page(rest, q.__limit ?? rest.limit, send);
        }
        if (q.StartTime && /\d{2}-\d{2}-\d{2}$/.test(q.StartTime.split(' ')[1] ?? '')) return send(400, { Type: 'ApiException', Message: 'Could not convert string to DateTime' });
        const start = q.StartTime ? parseAcsTime(q.StartTime) : -Infinity;
        const end = q.EndTime ? parseAcsTime(q.EndTime) : Infinity;
        const types = q.Filter ? [...q.Filter.matchAll(/\[event_type\] = (\w+)/g)].map((m) => m[1]) : null;
        const matched = state.records
          .filter((r) => { const t = parseAcsTime(r.OccurrenceTime); return t >= start && t <= end; })
          .filter((r) => !types || types.includes(r.Data.event_type.Value))
          .sort((a, b) => parseAcsTime(b.OccurrenceTime) - parseAcsTime(a.OccurrenceTime));
        return page({ items: matched, limit: q.Limit ?? 100, total: matched.length, first: true }, q.Limit ?? 100, send);
      }
      send(400, { Type: 'CommunicationException', Message: `Unknown method: ${op}` });
    });
  });

  function page(p, limit, send) {
    const items = p.items.slice(0, limit);
    const rest = p.items.slice(limit);
    const out = { Results: items };
    if (p.first) out.TotalNumberOfRecords = p.total;
    if (rest.length) {
      const token = Math.random().toString(36).slice(2);
      state.pages.set(token, { items: rest, limit });
      out.NextPageToken = token;
    }
    send(200, out);
  }

  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) });
  }));
}
