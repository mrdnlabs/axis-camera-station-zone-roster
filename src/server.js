// Local web dashboard + JSON API.
//
//   GET  /api/status             connection / poll health
//   GET  /api/occupancy          per-zone tallies + everyone's last known zone
//   GET  /api/muster-list        on-site people (JSON)   ?format=csv for the EmergencyOS CSV
//   GET  /api/events             recently ingested badge events with what they did
//   GET  /api/doors              discovered doors and their zones
//   GET  /api/zones              zones from ACS with their on-site setting and doors
//   PUT  /api/zones              save {offSiteZones: [names]} (recomputes occupancy from the journal)
//   POST /api/poll               poll ACS now
//   POST /api/facilityos/push    push the muster list now (e.g. when an evacuation starts)
//
// Binds to 127.0.0.1 by default. This example dashboard has no login: put it behind authentication
// before exposing it on a network. Requests must name a known host, which blocks DNS rebinding.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { validateOffSiteZones, saveOffSiteZones, LOOPBACK_HOSTS } from './config.js';
import { discoverDoors } from './discovery.js';
import { buildMusterCsv } from './facilityOsSink.js';

// Handlers return plain data (200) or reply(code, body) for other statuses.
class Reply { constructor(code, body) { this.code = code; this.body = body; } }
const reply = (code, body) => new Reply(code, body);

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // Inline styles are needed only for the zone meter widths.
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function createServer({ cfg, poller, sink, client, log = console }) {
  let doorCache = { at: 0, data: null };
  const allowedHosts = new Set([...LOOPBACK_HOSTS, cfg.server.host, ...(cfg.server.allowedHosts ?? [])].map((h) => h.toLowerCase()));
  const hostAllowed = (req) => {
    try { return allowedHosts.has(new URL(`http://${req.headers.host}`).hostname); } catch { return false; }
  };

  const json = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1_000_000) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
  // Mutations must be same-origin JSON requests (blocks drive-by cross-site form posts).
  const sameOriginJson = (req) => {
    if (!/^application\/json/i.test(req.headers['content-type'] ?? '')) return false;
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; } // e.g. "Origin: null"
  };

  const routes = {
    'GET /api/status': () => ({
      ...poller.status,
      consecutiveFailures: poller.consecutiveFailures,
      journalSize: poller.store.journal.size,
      watermark: poller.store.watermark ? new Date(poller.store.watermark).toISOString() : null,
      polling: cfg.polling,
      facilityOs: { enabled: cfg.facilityOs.enabled, last: sink.last },
    }),
    'GET /api/occupancy': () => poller.occupancy,
    'GET /api/events': () => poller.feed(),
    'GET /api/zones': () => ({ zones: poller.zoneList() }),
    'GET /api/doors': async (req, url) => {
      const refresh = url.searchParams.has('refresh');
      if (refresh) { await poller.refreshZones(); poller.recompute(); }
      if (refresh || !doorCache.data || Date.now() - doorCache.at > 5 * 60_000) {
        doorCache = { at: Date.now(), data: await discoverDoors(client, { journal: poller.store.journal.values() }) };
      }
      return doorCache.data;
    },
    'PUT /api/zones': async (req) => {
      if (!sameOriginJson(req)) return reply(403, { error: 'same-origin JSON required' });
      const offSiteZones = (await readBody(req))?.offSiteZones;
      const errors = validateOffSiteZones(offSiteZones);
      if (errors.length) return reply(400, { errors });
      saveOffSiteZones(cfg, [...new Set(offSiteZones)]);
      log.info?.(`[zones] saved ${cfg.offSiteZones.length} off-site zone(s)`);
      const occupancy = poller.recompute();
      return { ok: true, occupancy, zones: poller.zoneList() };
    },
    'POST /api/poll': async (req) => {
      if (!sameOriginJson(req)) return reply(403, { error: 'same-origin JSON required' });
      return { result: await poller.pollOnce(), status: poller.status };
    },
    'POST /api/facilityos/push': async (req) => {
      if (!sameOriginJson(req)) return reply(403, { error: 'same-origin JSON required' });
      await poller.pollOnce(); // freshest possible data before an evacuation push
      return sink.push(poller.occupancy, 'manual');
    },
  };

  return http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (!hostAllowed(req)) return json(res, 403, { error: 'host not allowed' });
    if (!URL.canParse(req.url, 'http://local')) return json(res, 400, { error: 'bad request' });
    try {
      const url = new URL(req.url, 'http://local');
      if (url.pathname === '/api/muster-list' && req.method === 'GET') {
        const people = sink.musterPeople(poller.occupancy);
        if (url.searchParams.get('format') === 'csv') {
          res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="mustering-list.csv"' });
          return res.end(buildMusterCsv(people, cfg.facilityOs.csvColumns));
        }
        return json(res, 200, { generatedAt: poller.occupancy.computedAt, count: people.length, people });
      }
      const handler = routes[`${req.method} ${url.pathname}`];
      if (handler) {
        const out = await handler(req, url);
        return out instanceof Reply ? json(res, out.code, out.body) : json(res, 200, out);
      }
      if (req.method === 'GET') {
        const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
        const file = path.join(PUBLIC, path.normalize(rel));
        if (file.startsWith(PUBLIC + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
          return pipeline(fs.createReadStream(file), res, (e) => { if (e) log.warn?.(`[http] ${file}: ${e.message}`); });
        }
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      if (e instanceof SyntaxError) return json(res, 400, { error: 'invalid JSON' });
      log.warn?.(`[http] ${req.method} ${req.url}: ${e.message}`);
      json(res, 500, { error: 'internal error, see the server log' });
    }
  });
}
