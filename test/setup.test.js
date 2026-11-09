import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcsClient } from '../src/acsClient.js';
import { Store } from '../src/store.js';
import { Poller } from '../src/poller.js';
import { createServer } from '../src/server.js';
import { DEFAULTS, loadConfig, securityWarnings } from '../src/config.js';
import { secretStore, validateSignIn } from '../src/credentials.js';
import { computeOccupancy } from '../src/occupancy.js';
import { normalizeRecord } from '../src/normalize.js';
import { startMockAcs, makeRecord } from './mockAcs.js';

const quiet = { info() {}, warn() {} };
const SECRET = 'correct horse';
const JSON_HEADERS = { 'Content-Type': 'application/json' };

// The dashboard against a mock ACS, with a recording stand-in for the encrypted store.
async function dashboard({ signedIn = false, store = true, t } = {}) {
  const acs = await startMockAcs({ username: 'acs', password: SECRET });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-setup-'));
  const cfg = structuredClone(DEFAULTS);
  cfg.acs.baseUrl = acs.url;
  cfg.dataDir = dir; cfg._file = path.join(dir, 'config.json');
  if (signedIn) { cfg.acs.username = 'acs'; cfg.acs.password = SECRET; }
  const saved = [];
  const secrets = store ? { save: async (u, p) => { saved.push([u, p]); } } : null;
  const client = new AcsClient(cfg.acs);
  const poller = new Poller({ client, store: new Store(dir), cfg, log: quiet });
  const server = createServer({ cfg, poller, client, log: quiet, secrets });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    poller.stop();
    client.close();
    server.closeAllConnections?.(); server.close();
    await acs.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const put = (route, body, headers = {}) => fetch(base + route, { method: 'PUT', headers: { ...JSON_HEADERS, ...headers }, body: JSON.stringify(body) });
  return { acs, cfg, saved, client, poller, base, put };
}

test('the unconfirmed limit can be changed, is saved, and recounts people', async (t) => {
  const d = await dashboard({ signedIn: true, t });
  d.acs.state.records.push(makeRecord({ t: Date.now() - 2 * 3600_000, door: 'd1', side: 'A', name: 'Ann', card: 1 }));
  await d.poller.pollOnce();
  assert.equal(d.poller.occupancy.totals.onSite, 1);

  const r = await d.put('/api/presence', { staleAfterHours: 1 });
  assert.equal(r.status, 200);
  const { occupancy } = await r.json();
  assert.deepEqual([occupancy.totals.onSite, occupancy.totals.onSiteStale], [0, 1]);
  assert.equal(JSON.parse(fs.readFileSync(d.cfg._file, 'utf8')).presence.staleAfterHours, 1);
  assert.equal((await (await fetch(`${d.base}/api/status`)).json()).presence.staleAfterHours, 1);

  for (const bad of [0, 0.25, -1, '4', null, 100000]) assert.equal((await d.put('/api/presence', { staleAfterHours: bad })).status, 400, `refused ${bad}`);
  assert.equal(d.cfg.presence.staleAfterHours, 1);
  assert.equal((await d.put('/api/presence', { staleAfterHours: 2 }, { Origin: 'http://evil.example' })).status, 403);
});

test('with no sign-in the dashboard says so and does not contact ACS', async (t) => {
  const d = await dashboard({ t });
  assert.equal(d.client.auth, null);
  assert.equal((await (await fetch(`${d.base}/api/status`)).json()).signInNeeded, true);
  assert.equal((await fetch(`${d.base}/api/poll`, { method: 'POST', headers: JSON_HEADERS, body: '{}' })).status, 409);
  assert.equal((await fetch(`${d.base}/api/doors`)).status, 409);
  assert.equal(d.acs.state.calls.length, 0);
});

test('a working sign-in is stored and used straight away, and the password is never returned', async (t) => {
  const d = await dashboard({ t });
  const r = await d.put('/api/acs-sign-in', { username: ' acs ', password: SECRET });
  const text = await r.text();
  assert.equal(r.status, 200);
  assert.ok(!text.includes(SECRET));
  assert.deepEqual(d.saved, [['acs', SECRET]]);
  assert.ok(d.client.auth);

  const about = await fetch(`${d.base}/api/acs-sign-in`);
  const aboutText = await about.text();
  assert.deepEqual(JSON.parse(aboutText), { configured: true, username: 'acs', canChange: true, currentRequired: true });
  assert.ok(!aboutText.includes(SECRET));

  await new Promise((resolve) => setTimeout(resolve, 50)); // the poll it triggers
  await d.poller.inFlight;
  assert.equal(d.poller.status.connected, true);
  assert.equal((await (await fetch(`${d.base}/api/status`)).json()).signInNeeded, false);
});

test('a sign-in ACS refuses is not stored, and repeated guesses lock the form', async (t) => {
  const d = await dashboard({ signedIn: true, t });
  const before = d.client.auth;
  const guess = () => d.put('/api/acs-sign-in', { username: 'acs', password: 'wrong', currentPassword: SECRET });
  for (let i = 0; i < 5; i++) assert.equal((await guess()).status, 400);
  const locked = await guess();
  assert.equal(locked.status, 429);
  assert.match((await locked.json()).error, /Try again/);
  assert.equal((await d.put('/api/acs-sign-in', { username: 'acs', password: SECRET, currentPassword: SECRET })).status, 429, 'even the right password waits');
  assert.deepEqual(d.saved, []);
  assert.equal(d.client.auth, before);
});

test('replacing a working sign-in requires its password', async (t) => {
  const d = await dashboard({ signedIn: true, t });
  const before = d.client.auth;
  const wrong = await d.put('/api/acs-sign-in', { username: 'acs', password: SECRET, currentPassword: 'nope' });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /current password/);
  assert.equal((await d.put('/api/acs-sign-in', { username: 'acs', password: SECRET })).status, 400, 'missing');
  assert.equal(d.acs.state.calls.length, 0, 'ACS is not contacted');
  assert.deepEqual(d.saved, []);
  assert.equal(d.client.auth, before);

  for (let i = 0; i < 3; i++) await d.put('/api/acs-sign-in', { username: 'acs', password: SECRET, currentPassword: 'nope' });
  assert.equal((await d.put('/api/acs-sign-in', { username: 'acs', password: SECRET, currentPassword: 'nope' })).status, 429, 'guessing it locks the form too');
});

test('once ACS rejects the stored sign-in, a working account replaces it without the old password', async (t) => {
  const d = await dashboard({ signedIn: true, t });
  d.client.setCredentials('acs', 'password that was changed in ACS');
  await d.poller.pollOnce();
  assert.equal(d.poller.status.lastError.status, 401);
  assert.equal((await (await fetch(`${d.base}/api/acs-sign-in`)).json()).currentRequired, false);
  assert.equal((await d.put('/api/acs-sign-in', { username: 'acs', password: SECRET })).status, 200);
  assert.deepEqual(d.saved, [['acs', SECRET]]);
});

test('a password left in the config file is warned about at startup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-cfg-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(file, JSON.stringify({ acs: { username: 'acs', password: 'x' } }));
    assert.ok(securityWarnings(loadConfig(file)).some((w) => w.includes('in plain text')));
    fs.writeFileSync(file, '{}');
    assert.ok(!securityWarnings(loadConfig(file)).some((w) => w.includes('in plain text')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the sign-in can only be changed by a browser on this computer', async (t) => {
  const d = await dashboard({ t });
  const body = { username: 'acs', password: SECRET };
  assert.equal((await d.put('/api/acs-sign-in', body, { 'X-Forwarded-For': '10.0.0.9' })).status, 403, 'through a reverse proxy');
  assert.equal((await d.put('/api/acs-sign-in', body, { Via: '1.1 proxy' })).status, 403);
  assert.equal((await d.put('/api/acs-sign-in', body, { Origin: 'http://evil.example' })).status, 403, 'from another site');
  assert.equal((await fetch(`${d.base}/api/acs-sign-in`, { headers: { Forwarded: 'for=10.0.0.9' } })).status, 403);
  assert.deepEqual(d.saved, []);
});

test('without the service the sign-in cannot be changed from the page', async (t) => {
  const d = await dashboard({ signedIn: true, store: false, t });
  assert.equal((await (await fetch(`${d.base}/api/acs-sign-in`)).json()).canChange, false);
  assert.equal((await d.put('/api/acs-sign-in', { username: 'acs', password: SECRET })).status, 409);
});

test('sign-in values that could corrupt the stored file or the login header are refused', () => {
  assert.deepEqual(validateSignIn({ username: 'a', password: 'b' }), []);
  for (const bad of [null, {}, { username: 'a' }, { username: '', password: 'b' }, { username: 'a:b', password: 'c' }, { username: 'a', password: 'b\nACS_USERNAME=x' }, { username: 'a\r', password: 'b' }, { username: 1, password: 2 }]) {
    assert.equal(validateSignIn(bad).length, 1, JSON.stringify(bad));
  }
});

test('the encrypted store is only offered under the service', () => {
  assert.equal(secretStore({}), null);
  assert.equal(secretStore({ ZONE_ROSTER_SECRET_TOOL: 'x' }), null);
  assert.ok(secretStore({ ZONE_ROSTER_SECRET_TOOL: 'x', ZONE_ROSTER_DATA_DIR: 'y' }));
});

const T0 = Date.UTC(2026, 0, 5, 8);
const badge = (t, zone, name = 'Ann') => normalizeRecord(makeRecord({ t, door: 'D', side: 'A', name, card: 1, zone }));
const inAcs = (...names) => ({ zones: new Set(names), doorZones: new Map([['D', names]]) });

test('renaming or deleting a zone does not undo exits people already made', () => {
  const journal = [badge(T0, 'To Old'), badge(T0 + 1000, 'From Old')];
  const o = computeOccupancy(journal, DEFAULTS, T0 + 2000, inAcs('New'));
  assert.equal(o.totals.onSite, 0);
  assert.deepEqual(o.unreadableDoors, []);
  assert.equal(o.people[0].zoneName, 'Not in a zone');
});

test('people in a zone that left ACS stay counted, flagged, until they next badge', () => {
  const journal = [badge(T0, 'To Old')];
  const before = computeOccupancy(journal, DEFAULTS, T0 + 1000, inAcs('New'));
  assert.equal(before.totals.onSite, 1);
  assert.deepEqual(before.zones.map((z) => [z.name, z.notInAcs, z.count]), [['New', false, 0], ['Old', true, 1]]);

  const after = computeOccupancy([...journal, badge(T0 + 2000, 'To New')], DEFAULTS, T0 + 3000, inAcs('New'));
  assert.deepEqual(after.zones.map((z) => [z.name, z.count]), [['New', 1]], 'the old name goes once nobody is left in it');
});

test('a door that leaves one zone for another counts the next badge in the new zone', () => {
  const o = computeOccupancy([badge(T0, 'To A'), badge(T0 + 1000, 'To B')], DEFAULTS, T0 + 2000, inAcs('A', 'B'));
  assert.equal(o.onSiteList[0].zoneName, 'B');
  assert.equal(o.totals.onSite, 1);
});

test('wording never seen before is still not read as someone leaving', () => {
  const o = computeOccupancy([badge(T0, 'To A'), badge(T0 + 1000, 'From A to B')], DEFAULTS, T0 + 2000, inAcs('A', 'B'));
  assert.equal(o.totals.onSite, 1);
  assert.equal(o.unreadableDoors.length, 1);
});
