// Durable state: the de-duplicated event journal + polling watermark.
// A JSON file is fine for an example; use SQLite or a database in production. It holds names and card numbers.

import fs from 'node:fs';
import path from 'node:path';

// Bump when the shape of a stored event changes: older state is dropped and rebuilt from ACS.
const STATE_VERSION = 2;

export class Store {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'state.json');
    fs.mkdirSync(dataDir, { recursive: true });
    this.journal = new Map(); // fp -> normalized event
    this.watermark = null;    // epoch ms: start time of the last *successful* poll
    this.lastDeepResync = null;
    this.load();
  }

  load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const s = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (s.version !== STATE_VERSION) { console.log(`[store] state is version ${s.version}; rebuilding from ACS`); return; }
      this.watermark = s.watermark ?? null;
      this.lastDeepResync = s.lastDeepResync ?? null;
      for (const ev of s.journal ?? []) this.journal.set(ev.fp, ev);
    } catch (e) {
      // Corrupt state: keep a copy and start fresh; the bootstrap lookback will rebuild it from ACS.
      fs.renameSync(this.file, this.file + `.corrupt-${Date.now()}`);
      console.error(`[store] state file unreadable (${e.message}); starting fresh`);
    }
  }

  /** Add events; returns the number that were new. Duplicates (same fingerprint) are ignored. */
  addAll(events) {
    let added = 0;
    for (const ev of events) {
      if (this.journal.has(ev.fp)) continue;
      this.journal.set(ev.fp, ev);
      added++;
    }
    return added;
  }

  prune(retentionDays, nowMs = Date.now()) {
    const cutoff = nowMs - retentionDays * 86400_000;
    let n = 0;
    for (const [fp, ev] of this.journal) if (!(ev.time >= cutoff)) { this.journal.delete(fp); n++; }
    return n;
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({
      version: STATE_VERSION, savedAt: new Date().toISOString(), watermark: this.watermark,
      lastDeepResync: this.lastDeepResync, journal: [...this.journal.values()],
    }));
    fs.renameSync(tmp, this.file);
  }

  reset() {
    this.journal.clear();
    this.watermark = null;
    this.lastDeepResync = null;
    this.save();
  }
}
