import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcsClient, AcsError } from '../src/acsClient.js';
import { Store } from '../src/store.js';
import { Poller } from '../src/poller.js';
import { DEFAULTS } from '../src/config.js';
import { discoverDoors } from '../src/discovery.js';
import { startMockAcs, makeRecord } from './mockAcs.js';

const quiet = { info() {}, warn() {} };
const T0 = Date.UTC(2026, 10, 6, 13, 0, 0);

async function setup({ sources } = {}) {
  const acs = await startMockAcs({ sources });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'muster-'));
  const cfg = structuredClone(DEFAULTS);
  cfg.polling.pageSize = 3; // force pagination
  let now = T0;
  const client = new AcsClient({ baseUrl: acs.url, username: 'u', password: 'p', timeoutMs: 2000 });
  const mk = () => new Poller({ client, store: new Store(dir), cfg, now: () => now, log: quiet });
  return { acs, cfg, dir, client, mk, setNow: (t) => (now = t), cleanup: async () => { await acs.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

test('client: auth failure is a non-retryable AcsError; bad time format is rejected by mock like the real server', async () => {
  const { acs, cleanup } = await setup();
  try {
    const bad = new AcsClient({ baseUrl: acs.url, username: 'u', password: 'wrong' });
    await assert.rejects(bad.getApiVersion(), (e) => e instanceof AcsError && e.status === 401 && e.retryable === false);
    const good = new AcsClient({ baseUrl: acs.url, username: 'u', password: 'p' });
    await assert.rejects(good.call('ExternalDataFacade', 'GetExternalData', { StartTime: '2026-11-04 03-10-00' }), /Could not convert/);
  } finally { await cleanup(); }
});

test('pagination collects every page', async () => {
  const { acs, client, cleanup } = await setup();
  try {
    for (let i = 0; i < 10; i++) acs.state.records.push(makeRecord({ t: T0 + i * 1000, door: 'Front door', side: 'A', name: `P${i}`, card: i }));
    const r = await client.getExternalData({ pageSize: 3 });
    assert.equal(r.results.length, 10);
    assert.equal(r.pages, 4);
    assert.equal(r.total, 10);
  } finally { await cleanup(); }
});

test('overlapping polls never double count; occupancy tracks in/out', async () => {
  const { acs, mk, setNow, cleanup } = await setup();
  try {
    const p = mk();
    acs.state.records.push(makeRecord({ t: T0 - 60_000, door: 'Front door', side: 'A', name: 'Ann', card: 1 }));
    acs.state.records.push(makeRecord({ t: T0 - 50_000, door: 'Front door', side: 'A', name: 'Bob', card: 2 }));
    acs.state.records.push(makeRecord({ t: T0 - 40_000, door: 'Front door', side: 'A', name: 'Cy', card: 3, type: 'AccessDeniedAnonymous' }));
    let r = await p.pollOnce();
    assert.equal(r.new, 2); // denied filtered server-side
    assert.equal(p.occupancy.totals.onSite, 2);

    setNow(T0 + 60_000);
    acs.state.records.push(makeRecord({ t: T0 + 30_000, door: 'Front door', side: 'B', name: 'Bob', card: 2 }));
    r = await p.pollOnce();
    assert.equal(r.new, 1);
    assert.ok(r.duplicates >= 2, 'overlap re-read earlier records');
    assert.equal(p.occupancy.totals.onSite, 1);
    assert.equal(p.store.journal.size, 3);
  } finally { await cleanup(); }
});

test('outage: watermark holds, backoff, and the gap is re-read on recovery', async () => {
  const { acs, mk, setNow, cleanup } = await setup();
  try {
    const p = mk();
    await p.pollOnce();
    const wm = p.store.watermark;

    acs.state.down = true;
    setNow(T0 + 60_000);
    assert.equal(await p.pollOnce(), null);
    setNow(T0 + 10 * 60_000);
    assert.equal(await p.pollOnce(), null);
    assert.equal(p.status.connected, false);
    assert.equal(p.consecutiveFailures, 2);
    assert.equal(p.store.watermark, wm, 'watermark must not advance while down');

    // Badges that happened during the outage (controllers buffer them at the edge)
    acs.state.records.push(makeRecord({ t: T0 + 2 * 60_000, door: 'Front door', side: 'A', name: 'Ann', card: 1 }));
    acs.state.records.push(makeRecord({ t: T0 + 8 * 60_000, door: 'Front door', side: 'A', name: 'Bob', card: 2 }));
    acs.state.down = false;
    setNow(T0 + 15 * 60_000);
    const r = await p.pollOnce();
    assert.equal(r.new, 2);
    assert.ok(r.window.reasons.some((x) => x.startsWith('gap-recovery')));
    assert.equal(p.status.recoveredGap.recordsRecovered, 2);
    assert.equal(p.occupancy.totals.onSite, 2);
  } finally { await cleanup(); }
});

test('a record that shows up late (older than the last poll) is still picked up by the overlap', async () => {
  const { acs, mk, setNow, cleanup } = await setup();
  try {
    const p = mk();
    await p.pollOnce();
    setNow(T0 + 60_000);
    await p.pollOnce();
    // Badge happened at T0+50s but only reached the server after the T0+60s poll.
    acs.state.records.push(makeRecord({ t: T0 + 50_000, door: 'Front door', side: 'A', name: 'Late', card: 9 }));
    setNow(T0 + 120_000);
    const r = await p.pollOnce();
    assert.equal(r.new, 1);
    assert.equal(p.occupancy.musterList[0].name, 'Late');
  } finally { await cleanup(); }
});

test('very late delivery beyond the overlap is caught by the deep re-sync', async () => {
  const { acs, mk, cfg, setNow, cleanup } = await setup();
  try {
    cfg.polling.overlapSec = 60;
    const p = mk();
    await p.pollOnce(); // bootstrap counts as deep re-sync at T0
    for (let m = 1; m <= 14; m++) { setNow(T0 + m * 60_000); await p.pollOnce(); }
    acs.state.records.push(makeRecord({ t: T0 + 5 * 60_000, door: 'Front door', side: 'A', name: 'Offline', card: 7 })); // 10 min late
    setNow(T0 + 15 * 60_000);
    let r = await p.pollOnce();
    assert.ok(r.window.reasons.includes('deep-resync'));
    assert.equal(r.new, 1);
  } finally { await cleanup(); }
});

test('state survives restart; maxCatchupHours caps the window after a long outage', async () => {
  const { acs, mk, cfg, setNow, cleanup } = await setup();
  try {
    acs.state.records.push(makeRecord({ t: T0 - 1000, door: 'Front door', side: 'A', name: 'Ann', card: 1 }));
    await mk().pollOnce();
    const p2 = mk(); // new process, same data dir
    assert.equal(p2.occupancy.totals.onSite, 1);
    setNow(T0 + 100 * 3600_000);
    const w = p2.window(T0 + 100 * 3600_000);
    assert.equal(w.truncated, true);
    assert.equal(w.start, T0 + 100 * 3600_000 - cfg.polling.maxCatchupHours * 3600_000);
  } finally { await cleanup(); }
});

test('door discovery merges the ACS source list with doors seen in events', async () => {
  const { acs, client, cleanup } = await setup({ sources: [
    { Name: 'Front door', Key: 'k1', PluginId: 'axis_secureentry' },
    { Name: 'Side door', Key: 'k2', PluginId: 'axis_secureentry' },
    { Name: 'POS', Key: 'k3', PluginId: 'something_else' },
  ] });
  try {
    acs.state.records.push(makeRecord({ t: Date.now() - 1000, door: 'Old door', side: 'B', name: 'Ann', card: 1 }));
    const d = await discoverDoors(client, { scanDays: 1 });
    assert.equal(d.sourceListSupported, true);
    assert.deepEqual(d.doors.map((x) => x.name), ['Front door', 'Old door', 'Side door']);
    assert.deepEqual(d.doors.find((x) => x.name === 'Old door').sidesSeen, ['B']);
    assert.equal(d.controllers.length, 1);
  } finally { await cleanup(); }
});

test('zones and door membership come from the ACS door list on every poll', async () => {
  const sources = [
    { Name: 'Front door', Key: 'k1', PluginId: 'axis_secureentry', GroupNames: ['Building'] },
    { Name: 'Lab door', Key: 'k2', PluginId: 'axis_secureentry', GroupNames: ['Building'] },
    { Name: 'Bare door', Key: 'k3', PluginId: 'axis_secureentry' },
  ];
  const { acs, mk, cleanup } = await setup({ sources });
  try {
    const p = mk();
    acs.state.records.push(makeRecord({ t: T0 - 1000, door: 'Front door', side: 'A', name: 'Ann', card: 1 }));
    await p.pollOnce();
    assert.deepEqual(p.zoneList(), [{ name: 'Building', onSite: true, doors: ['Front door', 'Lab door'] }]);
    assert.equal(p.feed()[0].outcome, 'Entered Building');
    assert.equal(p.feed()[0].counted, true);

    sources[2].GroupNames = ['Annex']; // added in Secure Entry later
    await p.pollOnce();
    assert.deepEqual(p.zoneList().map((z) => z.name), ['Annex', 'Building']);
  } finally { await cleanup(); }
});

test('a state file from an older version is dropped and rebuilt from ACS', async () => {
  const { acs, dir, mk, cleanup } = await setup();
  try {
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 1, watermark: T0 - 1000, journal: [{ fp: 'old', time: T0 - 5000, door: 'Front door', eventType: 'AccessGranted', cardholder: 'Ann' }] }));
    acs.state.records.push(makeRecord({ t: T0 - 1000, door: 'Front door', side: 'A', name: 'Ann', card: 1 }));
    const p = mk();
    assert.equal(p.store.journal.size, 0);
    assert.equal(p.store.watermark, null);
    await p.pollOnce();
    assert.equal(p.occupancy.totals.onSite, 1);
  } finally { await cleanup(); }
});
