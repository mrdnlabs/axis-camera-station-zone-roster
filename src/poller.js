// Poll loop: overlapping windows + content de-duplication + gap recovery.
//
//   start = (watermark ?? now - bootstrapLookback) - overlap        // normal poll
//   start = now - deepResyncWindow  (if that is earlier)             // periodic deep re-sync
//   start = max(start, now - maxCatchup)                             // cap after very long outages
//   -> GetExternalData(StartTime=start, Filter=event types)  (EndTime omitted: server's "now")
//   -> journal.addAll(normalized)   (fingerprint de-dup => re-reading never double counts)
//   -> on success: watermark = time this poll started
//   -> on failure: exponential backoff; watermark unchanged, so the next success re-reads the gap

import { normalizeRecord, eventTypeFilter } from './normalize.js';
import { computeOccupancy, classify, pastZones } from './occupancy.js';

export class Poller {
  constructor({ client, store, cfg, now = () => Date.now(), log = console }) {
    Object.assign(this, { client, store, cfg, now, log });
    this.timer = null;
    this.running = false;
    this.inFlight = null;
    this.consecutiveFailures = 0;
    this.status = {
      connected: null, lastAttempt: null, lastSuccess: null, lastError: null, nextPollAt: null,
      lastPoll: null, recoveredGap: null, server: null,
    };
    this.zoneCtx = { zones: new Set(), doorZones: new Map() }; // from the ACS door list, refreshed every poll
    this.occupancy = computeOccupancy(this.store.journal.values(), cfg, now(), this.zoneCtx);
    // UI feed: seed from the persisted journal so it survives restarts.
    this.recent = [...this.store.journal.values()].sort((a, b) => b.time - a.time).slice(0, 200);
  }

  /** Feed entry: the event plus what it did and how long it took to reach us (if known). */
  describe(ev, ctx = this.zoneCtx) {
    const c = classify(ev, this.cfg, ctx);
    const outcome = { enter: `Entered ${c.zone}`, leave: `Left ${c.zone}`, confirm: `Still in ${c.zone}`, ignore: `Not counted: ${c.reason}` }[c.action];
    return {
      ...ev,
      counted: c.action !== 'ignore',
      outcome,
      latencySec: Number.isFinite(ev.seenAt) ? Math.max(0, Math.round((ev.seenAt - ev.time) / 1000)) : null,
    };
  }

  feed() {
    const ctx = { ...this.zoneCtx, pastZones: pastZones(this.store.journal.values()) };
    return this.recent.map((ev) => this.describe(ev, ctx));
  }

  /** Reload zone names and door membership from the ACS door list. A failure keeps the last known list. */
  async refreshZones() {
    const sources = await this.client.getExternalDataSourceList().catch(() => null);
    if (!Array.isArray(sources)) return false;
    const doorZones = new Map();
    for (const s of sources) {
      if (!s.PluginId || s.PluginId === 'axis_secureentry') doorZones.set(s.Name, s.GroupNames ?? []);
    }
    this.zoneCtx = { zones: new Set([...doorZones.values()].flat()), doorZones };
    return true;
  }

  /** Every known zone with its on-site setting and member doors. */
  zoneList() {
    const doors = [...this.zoneCtx.doorZones];
    return this.occupancy.zones.map((z) => ({ name: z.name, onSite: z.onSite, notInAcs: z.notInAcs, doors: doors.filter(([, zs]) => zs.includes(z.name)).map(([d]) => d) }));
  }

  start() {
    this.running = true;
    this.schedule(0);
  }

  /** A new ACS sign-in was stored: forget the failures of the old one and poll straight away. */
  async signInChanged() {
    await this.inFlight;
    this.consecutiveFailures = 0;
    Object.assign(this.status, { connected: null, lastError: null, server: null });
    this.running = true;
    this.schedule(0);
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (!this.running) return;
    this.status.nextPollAt = new Date(this.now() + ms).toISOString();
    this.timer = setTimeout(() => this.pollOnce().finally(() => {
      const p = this.cfg.polling;
      const delay = this.consecutiveFailures === 0
        ? p.intervalSec * 1000
        : Math.min(p.backoffMaxSec, 5 * 2 ** (this.consecutiveFailures - 1)) * 1000;
      this.schedule(delay);
    }), ms);
  }

  /** Compute the query window for the next poll. Exported for tests. */
  window(nowMs) {
    const p = this.cfg.polling;
    const reasons = [];
    let start;
    if (this.store.watermark == null) {
      start = nowMs - p.bootstrapLookbackHours * 3600_000;
      reasons.push('bootstrap');
    } else {
      start = this.store.watermark - p.overlapSec * 1000;
      const gapSec = (nowMs - this.store.watermark) / 1000;
      if (gapSec > p.intervalSec * 2 + 30) reasons.push(`gap-recovery(${Math.round(gapSec)}s since last success)`);
    }
    const deepDue = this.store.lastDeepResync == null || nowMs - this.store.lastDeepResync >= p.deepResyncEveryMin * 60_000;
    let deep = false;
    if (deepDue) {
      const deepStart = nowMs - p.deepResyncWindowMin * 60_000;
      if (deepStart < start) { start = deepStart; reasons.push('deep-resync'); }
      deep = true; // a bootstrap read also counts as a deep re-sync
    }
    const floor = nowMs - p.maxCatchupHours * 3600_000;
    let truncated = false;
    if (start < floor) { start = floor; truncated = true; reasons.push('truncated-to-maxCatchup'); }
    return { start, deep, truncated, reasons };
  }

  /** One poll cycle. Concurrent callers share the same in-flight poll. */
  pollOnce() {
    if (!this.inFlight) this.inFlight = this._poll().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async _poll() {
    const startedAt = this.now();
    this.status.lastAttempt = new Date(startedAt).toISOString();
    const win = this.window(startedAt);
    try {
      if (!this.status.server) {
        const [ver, sys] = await Promise.all([this.client.getApiVersion(), this.client.getSystem().catch(() => null)]);
        this.status.server = { api: `${ver?.Major}.${ver?.Minor}`, product: sys?.ServerDisplayVersion ?? `${ver?.ProductMajor}.${ver?.ProductMinor}`, name: sys?.Name, timeZone: sys?.TimeZone };
      }
      const { results, total, pages } = await this.client.getExternalData({
        startMs: win.start,
        filter: eventTypeFilter(this.cfg.polling.eventTypes),
        pageSize: this.cfg.polling.pageSize,
      });
      await this.refreshZones();
      // A first read can't say how long a record took to arrive, so it gets no arrival time.
      const seenAt = win.reasons.includes('bootstrap') ? undefined : startedAt;
      const events = results.map((r) => ({ ...normalizeRecord(r), seenAt }));
      const newOnes = events.filter((e) => !this.store.journal.has(e.fp));
      const added = this.store.addAll(events);

      const wasDown = this.status.connected === false;
      if (wasDown || win.reasons.some((r) => r.startsWith('gap-recovery'))) {
        this.status.recoveredGap = { at: new Date(startedAt).toISOString(), from: new Date(win.start).toISOString(), recordsRecovered: added, truncated: win.truncated };
      }

      this.store.watermark = startedAt;
      if (win.deep) this.store.lastDeepResync = startedAt;
      this.store.prune(this.cfg.presence.journalRetentionDays, startedAt);
      this.store.save();

      this.consecutiveFailures = 0;
      Object.assign(this.status, { connected: true, lastSuccess: new Date(startedAt).toISOString(), lastError: null });
      this.status.lastPoll = {
        window: { from: new Date(win.start).toISOString(), reasons: win.reasons },
        fetched: results.length, totalReported: total, pages, new: added, duplicates: results.length - added,
        durationMs: this.now() - startedAt,
      };

      for (const ev of newOnes.sort((a, b) => a.time - b.time)) this.recent.unshift(ev);
      this.recent.length = Math.min(this.recent.length, 200);

      this.recompute();
      if (added) this.log.info?.(`[poll] +${added} new event(s) (${results.length} fetched, window ${win.reasons.join(',') || 'normal'})`);
      return this.status.lastPoll;
    } catch (e) {
      this.consecutiveFailures++;
      Object.assign(this.status, { connected: false, lastError: { at: new Date(startedAt).toISOString(), message: e.message, retryable: e.retryable !== false, status: e.status } });
      this.log.warn?.(`[poll] failed (${this.consecutiveFailures}x): ${e.message}`);
      return null;
    }
  }

  /** Re-derive occupancy from the journal (after polls and after zone setting changes). */
  recompute() {
    this.occupancy = computeOccupancy(this.store.journal.values(), this.cfg, this.now(), this.zoneCtx);
    return this.occupancy;
  }
}
