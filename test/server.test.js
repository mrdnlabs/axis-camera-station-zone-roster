import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { AcsClient } from '../src/acsClient.js';
import { Store } from '../src/store.js';
import { Poller } from '../src/poller.js';
import { createServer } from '../src/server.js';
import { DEFAULTS } from '../src/config.js';
import { startMockAcs, makeRecord } from './mockAcs.js';

const quiet = { info() {}, warn() {} };

test('HTTP API: array responses (badge event feed) are served as JSON, not mistaken for a status tuple', async () => {
  const acs = await startMockAcs();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-srv-'));
  const cfg = structuredClone(DEFAULTS);
  cfg.dataDir = dir; cfg._file = path.join(dir, 'config.json');
  const client = new AcsClient({ baseUrl: acs.url, username: 'u', password: 'p' });
  const poller = new Poller({ client, store: new Store(dir), cfg, log: quiet });
  const server = createServer({ cfg, poller, client, log: quiet });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    acs.state.records.push(makeRecord({ t: Date.now() - 5000, door: 'd1', side: 'A', name: 'Ann', card: 1 }));
    const poll = await fetch(`${base}/api/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(poll.status, 200);

    const ev = await fetch(`${base}/api/events`);
    assert.equal(ev.status, 200);
    const list = await ev.json();
    assert.ok(Array.isArray(list) && list.length === 1);
    assert.equal(list[0].outcome, 'Entered Building');

    const onSite = await (await fetch(`${base}/api/on-site`)).json();
    assert.deepEqual(onSite.people.map((p) => p.name), ['Ann']);

    const forbidden = await fetch(`${base}/api/poll`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://evil.example' }, body: '{}' });
    assert.equal(forbidden.status, 403);
    const put = (body) => fetch(`${base}/api/zones`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const bad = await put({ offSiteZones: 'Building' });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).errors[0], /list of zone names/);

    const saved = await put({ offSiteZones: ['Building'] });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).occupancy.totals.onSite, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(cfg._file, 'utf8')).offSiteZones, ['Building']);
    assert.equal((await (await fetch(`${base}/api/on-site`)).json()).count, 0);

    const raw = (opts) => new Promise((resolve, reject) => {
      const q = http.request({ host: '127.0.0.1', port: server.address().port, ...opts }, (r) => { r.resume(); r.on('end', () => resolve(r)); });
      q.on('error', reject); q.end(opts.body);
    });
    const json = { 'Content-Type': 'application/json' };
    assert.equal((await raw({ path: '/api/occupancy', headers: { Host: 'attacker.example' } })).statusCode, 403, 'DNS rebinding blocked');
    assert.equal((await raw({ path: '//' })).statusCode, 400, 'malformed URL must not crash the server');
    assert.equal((await raw({ path: '/api/poll', method: 'POST', headers: { ...json, Origin: 'null' } })).statusCode, 403, 'opaque origin refused');
    assert.equal((await raw({ path: '/api/zones', method: 'PUT', headers: json, body: '{not json' })).statusCode, 400);
    assert.equal((await raw({ path: '/api/zones', method: 'PUT', headers: json, body: 'null' })).statusCode, 400);
    assert.equal((await raw({ path: '/../config.json' })).statusCode, 404);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  } finally {
    server.closeAllConnections?.(); server.close();
    await acs.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
