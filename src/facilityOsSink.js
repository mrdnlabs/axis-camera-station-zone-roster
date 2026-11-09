// FacilityOS / EmergencyOS hand-off.
//
// FacilityOS has no inbound webhook. Its v1 Partner API exposes
//   POST {apiBase}/emos/uploadmusteringlist   (multipart/form-data, field "file" = CSV)
//   headers: Authorization: Bearer <token>, cid: <CustomerId>
//   token:   OAuth2 client_credentials at {tokenUrl}
//   200 ->   { status: "Pending"|"Success"|"Error", total, errorMessage }
// The CSV column schema is NOT published; columns are configurable (facilityOs.csvColumns) and must be
// confirmed with FacilityOS before go-live. With facilityOs.enabled=false (default) this only writes the CSV.

import fs from 'node:fs';
import path from 'node:path';

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralize spreadsheet formula injection
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function buildMusterCsv(people, columns) {
  const cols = Object.entries(columns).filter(([, header]) => header);
  const rows = [cols.map(([, h]) => csvCell(h)).join(',')];
  for (const p of people) {
    const [first, ...rest] = (p.name ?? '').split(/\s+/);
    const fields = {
      name: p.name, firstName: first ?? '', lastName: rest.join(' '), cardNumber: p.cardNumbers?.join(';'),
      zone: p.zoneName, lastSeen: p.lastSeen, lastDoor: p.lastDoor, status: p.stale ? 'Unconfirmed' : 'OnSite',
    };
    rows.push(cols.map(([k]) => csvCell(fields[k])).join(','));
  }
  return rows.join('\r\n') + '\r\n';
}

export class FacilityOsSink {
  constructor(cfg, log = console) {
    this.cfg = cfg;
    this.log = log;
    this.token = null;
    this.tokenExp = 0;
    this.last = { at: null, mode: null, count: null, result: null, error: null, file: null };
    this.lastPushMs = 0;
  }

  get fos() { return this.cfg.facilityOs; }

  musterPeople(occ) {
    return this.fos.includeStale ? occ.people.filter((p) => p.onSite) : occ.musterList;
  }

  /** Called after each recompute. Pushes when the list changed or pushEveryMin elapsed. */
  async maybePush(occ, changed, nowMs = Date.now()) {
    const due = nowMs - this.lastPushMs >= this.fos.pushEveryMin * 60_000;
    if (!changed && !due) return null;
    return this.push(occ, changed ? 'change' : 'interval');
  }

  async push(occ, reason = 'manual') {
    const people = this.musterPeople(occ);
    const csv = buildMusterCsv(people, this.fos.csvColumns);
    fs.mkdirSync(this.cfg.outDir, { recursive: true });
    const file = path.join(this.cfg.outDir, 'mustering-list.csv');
    fs.writeFileSync(file + '.tmp', csv);
    fs.renameSync(file + '.tmp', file);
    this.lastPushMs = Date.now();
    this.last = { at: new Date().toISOString(), reason, mode: this.fos.enabled ? 'upload' : 'dry-run', count: people.length, result: null, error: null, file };
    if (!this.fos.enabled) return this.last;
    try {
      this.last.result = await this.upload(csv);
      this.log.info?.(`[facilityos] uploaded ${people.length} people: ${JSON.stringify(this.last.result)}`);
    } catch (e) {
      this.last.error = e.message;
      this.log.warn?.(`[facilityos] upload failed: ${e.message}`);
    }
    return this.last;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExp - 60_000) return this.token;
    const { tokenUrl, clientId, clientSecret } = this.fos;
    if (!clientId || !clientSecret) throw new Error('facilityOs.clientId/clientSecret (FOS_CLIENT_ID/FOS_CLIENT_SECRET) not set');
    const r = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`token request failed: HTTP ${r.status}`);
    const j = await r.json();
    this.token = j.access_token;
    this.tokenExp = Date.now() + (j.expires_in ?? 3600) * 1000;
    return this.token;
  }

  async upload(csv) {
    if (!this.fos.customerId) throw new Error('facilityOs.customerId (FOS_CUSTOMER_ID) not set');
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'mustering-list.csv');
    const r = await fetch(new URL('/emos/uploadmusteringlist', this.fos.apiBase), {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.getToken()}`, cid: this.fos.customerId, Accept: 'application/json' },
      body: form,
      signal: AbortSignal.timeout(60000),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`uploadmusteringlist HTTP ${r.status}: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return { raw: text.slice(0, 300) }; }
  }
}
