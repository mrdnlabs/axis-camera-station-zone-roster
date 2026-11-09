#!/usr/bin/env node
// Entry point.
//   node src/index.js run        [--config config.json]   poll + dashboard (default)
//   node src/index.js discover   [--config config.json]   list doors, their zones and controllers
//   node src/index.js poll-once  [--config config.json]   one poll, print occupancy, exit
//   node src/index.js reset      [--config config.json]   clear the local journal/watermark

import { loadConfig, securityWarnings } from './config.js';
import { AcsClient } from './acsClient.js';
import { Store } from './store.js';
import { Poller } from './poller.js';
import { FacilityOsSink } from './facilityOsSink.js';
import { createServer } from './server.js';
import { discoverDoors } from './discovery.js';

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) ?? 'run';
const cfgPath = args.includes('--config') ? args[args.indexOf('--config') + 1] : 'config.json';

const ts = () => new Date().toISOString();
const log = {
  info: (m) => console.log(`${ts()} ${m}`),
  warn: (m) => console.warn(`${ts()} WARN ${m}`),
};

const cfg = loadConfig(cfgPath);
if (!cfg.acs.username) {
  console.error('ACS credentials missing: set ACS_USERNAME and ACS_PASSWORD (or acs.username/password in the config).');
  process.exit(2);
}
for (const w of securityWarnings(cfg)) log.warn(w);
const client = new AcsClient(cfg.acs);

if (cmd === 'discover') {
  const v = await client.getApiVersion();
  console.log(`ACS Pro ${v.ProductMajor}.${v.ProductMinor}, API ${v.Major}.${v.Minor}`);
  const d = await discoverDoors(client, { scanDays: 30 });
  console.log(`\nDoor list via GetExternalDataSourceList: ${d.sourceListSupported ? 'supported' : 'NOT supported (using event scan only)'}`);
  console.table(d.doors.map((x) => ({ door: x.name, key: x.key, inSourceList: x.viaSourceList, zones: x.zones.join(', '), role: x.role ?? '', sidesSeen: x.sidesSeen.join('/'), lastBadge: x.lastSeen })));
  console.log('Door controllers:');
  console.table(d.controllers);
  process.exit(0);
}

const store = new Store(cfg.dataDir);
if (cmd === 'reset') { store.reset(); log.info('state cleared'); process.exit(0); }

const poller = new Poller({ client, store, cfg, log });
const sink = new FacilityOsSink(cfg, log);

if (cmd === 'poll-once') {
  const r = await poller.pollOnce();
  if (!r) { console.error(poller.status.lastError); process.exit(1); }
  console.log(JSON.stringify({ poll: r, totals: poller.occupancy.totals, zones: poller.occupancy.zones, people: poller.occupancy.people }, null, 2));
  process.exit(0);
}

poller.on('occupancy', (occ, changed) => {
  sink.maybePush(occ, changed).catch((e) => log.warn(`[facilityos] ${e.message}`));
});
poller.start();

const server = createServer({ cfg, poller, sink, client, log });
server.listen(cfg.server.port, cfg.server.host, () => {
  log.info(`Zone Roster: dashboard http://${cfg.server.host}:${cfg.server.port}  (ACS ${cfg.acs.baseUrl}, poll every ${cfg.polling.intervalSec}s, FacilityOS ${cfg.facilityOs.enabled ? 'upload' : 'dry-run'})`);
});

const shutdown = () => { poller.stop(); server.close(); store.save(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
