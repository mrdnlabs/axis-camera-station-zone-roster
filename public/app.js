// Dashboard client. Everything from ACS (names, door names) is untrusted: always rendered through esc().
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '–');
const ago = (iso) => {
  if (!iso) return '–';
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`; if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`; return `${Math.round(s / 86400)} d ago`;
};
const clock = (ms) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const initials = (name) => String(name ?? '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('') || '?';
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const api = async (path, opts = {}) => {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.errors?.join('; ') || j.error || `HTTP ${r.status}`);
  return j;
};

let occ = null, status = null, zones = null, savedZones = null, doors = null, dirty = false;

// ---------------- views (#live / #setup) ----------------
function route() {
  const view = location.hash === '#setup' ? 'setup' : 'live';
  document.querySelectorAll('.seg a').forEach((a) => {
    if (a.dataset.view === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  $('view-live').hidden = view !== 'live';
  $('view-setup').hidden = view !== 'setup';
  if (view === 'setup' && !doors) loadDoors();
  if (view === 'live') renderEvents();
}
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => { if (dirty) e.preventDefault(); });

// ---------------- header + connection ----------------
function renderStatus() {
  const c = $('conn');
  c.className = `pill ${status.connected === true ? 'ok' : status.connected === false ? 'bad' : ''}`;
  $('connText').textContent = status.connected === false
    ? `ACS unreachable · retrying (${status.consecutiveFailures}x) · last good ${ago(status.lastSuccess)}`
    : status.connected ? `Live · ACS ${status.server?.name ?? ''} · polled ${ago(status.lastSuccess)}` : 'Connecting to ACS…';

  const fos = status.facilityOs.last;
  const mode = status.facilityOs.enabled ? 'uploads to FacilityOS' : 'dry run (CSV only)';
  $('pushInfo').textContent = fos?.at
    ? `Last sent ${ago(fos.at)} · ${plural(fos.count, 'person', 'people')} · ${fos.error ? 'FAILED: ' + fos.error : mode}`
    : `Not sent yet · ${mode}`;

  const lp = status.lastPoll, p = status.polling, gap = status.recoveredGap;
  const items = [
    ['ACS server', status.server ? `${status.server.name} · ACS Pro ${status.server.product} · API ${status.server.api}` : '–'],
    ['Last poll', lp ? `${ago(status.lastSuccess)} · ${lp.new} new, ${lp.duplicates} duplicates · ${lp.durationMs} ms` : '–'],
    ['Next poll', status.nextPollAt ? new Date(status.nextPollAt).toLocaleTimeString() : '–'],
    ['Polling', `Every ${p.intervalSec} s, re-reads the last ${Math.round(p.overlapSec / 60)} min`],
    ['Deep re-sync', `Last ${p.deepResyncWindowMin >= 60 ? Math.round(p.deepResyncWindowMin / 60) + ' h' : p.deepResyncWindowMin + ' min'}, every ${p.deepResyncEveryMin} min`],
    ['Gap recovery', gap ? `${ago(gap.at)} · re-read from ${fmt(gap.from)} · ${plural(gap.recordsRecovered, 'event')} recovered${gap.truncated ? ' (cut to max catch-up)' : ''}` : 'None needed'],
    ['Badge history', `${plural(status.journalSize, 'event')} kept · event types ${p.eventTypes.join(', ')}`],
    ['FacilityOS', status.facilityOs.enabled ? 'Uploads enabled' : 'Dry run · writes CSV only'],
    ['Last error', status.lastError ? `${fmt(status.lastError.at)}: ${status.lastError.message}` : 'None', !!status.lastError],
  ];
  $('health').innerHTML = items.map(([k, v, err]) => `<div><div class="k">${esc(k)}</div><div class="v${err ? ' err' : ''}">${esc(v)}</div></div>`).join('');
}

// ---------------- live ----------------
function renderOccupancy() {
  $('kOnSite').textContent = occ.totals.onSite;
  $('kStale').textContent = `${occ.totals.onSiteStale} unconfirmed`;
  $('kStale').title = 'Counted as on site, but their last badge is older than the stale-presence limit';
  $('kStale').hidden = occ.totals.onSiteStale === 0;
  $('kOffSite').textContent = `${occ.totals.offSite} off site`;

  const max = Math.max(1, ...occ.zones.map((z) => z.count));
  $('zones').innerHTML = occ.zones.map((z) => `
    <div class="zone ${z.onSite ? 'on' : ''}">
      <div class="zone-top"><span class="zone-name">${esc(z.name)}</span><span class="chip xs ${z.onSite ? 'on' : ''}">${z.onSite ? 'On site' : 'Off site'}</span></div>
      <div class="zone-count">${z.count}${z.staleCount ? `<small>${z.staleCount} unconfirmed</small>` : ''}</div>
      <div class="meter"><div style="width:${Math.round((z.count / max) * 100)}%"></div></div>
    </div>`).join('');

  const unreadable = occ.unreadableDoors ?? [];
  const notice = $('liveNotice');
  if (status?.connected && !occ.zones.length) {
    notice.textContent = 'No zones found in ACS, so nobody can be counted. Create zones in Secure Entry and add doors to them.';
    notice.hidden = false;
  } else if (unreadable.length) {
    notice.textContent = `The latest badge could not be read at ${unreadable.map((d) => `${d.door} (${d.reason})`).join(', ')}, so it was not counted.`;
    notice.hidden = false;
  } else notice.hidden = true;
  renderPeople();
}

function renderPeople() {
  const q = $('peopleFilter').value.trim().toLowerCase();
  const all = $('showAll').checked;
  const list = occ.people
    .filter((p) => (all || p.onSite) && (!q || [p.name, p.zoneName, p.lastDoor, ...p.cardNumbers].some((s) => String(s ?? '').toLowerCase().includes(q))))
    .sort((a, b) => (b.onSite - a.onSite) || String(a.name).localeCompare(String(b.name)));
  $('peopleCount').textContent = `${occ.totals.onSite} on site`;
  $('people').innerHTML = list.map((p) => {
    const cls = p.stale ? 'stale' : p.onSite ? '' : 'off';
    const tag = p.stale ? '<span class="chip xs warn">Unconfirmed</span> ' : '';
    return `<div class="person ${cls}">
      <div class="avatar" aria-hidden="true">${esc(initials(p.name))}</div>
      <div class="grow"><div class="name">${esc(p.name ?? '(unknown)')}</div><div class="muted small">Card ${esc(p.cardNumbers.join(', ') || '–')}</div></div>
      <div class="right"><div>${tag}${esc(p.zoneName)}</div><div class="muted small" title="${esc(fmt(p.lastSeen))}">${esc({ enter: 'Entered at', leave: 'Left at', confirm: 'Confirmed at' }[p.lastAction] ?? 'At')} ${esc(p.lastDoor)} · ${esc(ago(p.lastSeen))}</div></div>
    </div>`;
  }).join('') || `<div class="empty">${occ.people.length ? (q ? 'Nobody matches that search' : 'Nobody is on site') : 'No badges at zoned doors yet'}</div>`;
}

async function renderEvents() {
  if ($('view-live').hidden) return;
  let ev;
  try { ev = await api('/api/events'); } catch { return; }
  $('events').innerHTML = ev.slice(0, 12).map((e) => {
    const lag = e.latencySec != null && e.latencySec > 120 ? ` · arrived ${ago(new Date(Date.now() - e.latencySec * 1000).toISOString()).replace(' ago', '')} late` : '';
    const who = e.cardholder ?? (e.cardNumber ? 'Card ' + e.cardNumber : 'Unknown');
    return `<div class="event">
      <div class="when" title="${esc(fmt(new Date(e.time).toISOString()))}">${esc(clock(e.time))}</div>
      <div class="grow"><div><b>${esc(who)}</b> <span class="muted">at ${esc(e.door)}${e.fromSide ? ', side ' + esc(e.fromSide) : ''}</span></div>
      <div class="fx ${e.counted ? 'moved' : ''}">${esc((e.outcome ?? '') + lag)}</div></div>
    </div>`;
  }).join('') || '<div class="empty">No badge events yet</div>';
}

// ---------------- setup: zones + doors ----------------
// Zones and door membership come from Secure Entry; the only setting here is whether a zone counts as on site.
const zoneKey = (list) => JSON.stringify((list ?? []).map((z) => [z.name, z.onSite]));
function markDirty() {
  dirty = zoneKey(zones) !== zoneKey(savedZones);
  $('saveBar').hidden = !dirty;
  $('saveState').textContent = 'Unsaved changes';
  $('saveMsg').className = 'muted small'; $('saveMsg').textContent = 'Saving recounts everyone from the stored badge history.';
}

function renderZones() {
  $('zoneRows').innerHTML = (zones ?? []).map((z, i) => `
    <div class="zrow" data-i="${i}">
      <div class="grow"><b>${esc(z.name)}</b><div class="muted small">${esc(z.doors.length ? z.doors.join(', ') : 'No doors listed by ACS')}</div></div>
      <label class="switch">On site<input type="checkbox" data-f="onSite" ${z.onSite ? 'checked' : ''}><span class="track"><span class="knob"></span></span></label>
    </div>`).join('') || '<div class="empty">No zones found. Create zones in Secure Entry and they appear here.</div>';
}

function renderDoors() {
  const list = [...(doors?.doors ?? [])].sort((x, y) => (y.zones.length > 0) - (x.zones.length > 0) || x.name.localeCompare(y.name));
  $('doorRows').innerHTML = list.map((d) => {
    const role = d.role === 'inside' ? 'Inside door' : d.role === 'perimeter' ? 'Perimeter door' : null;
    const unit = d.units?.[0]?.replace(/\s*\[.*\]$/, '');
    const detail = [role, d.lastSeen ? `Last badge ${ago(d.lastSeen)}` : 'No badges yet', unit].filter(Boolean).join(' · ');
    return `<div class="drow">
      <div class="info"><div class="title"><b>${esc(d.name)}</b><span class="chip xs ${d.zones.length ? 'on' : ''}">${esc(d.zones.join(', ') || 'Not in a zone')}</span></div>
        <div class="muted small">${esc(detail)}</div></div>
    </div>`;
  }).join('') || `<div class="empty">${doors ? 'No doors found in ACS' : 'Loading doors from ACS…'}</div>`;
  const ctl = doors?.controllers ?? [];
  $('doorSourceInfo').textContent = !doors ? ''
    : `${plural(doors.doors.length, 'door')} ${doors.sourceListSupported ? 'listed by ACS' : 'found in badge history (this ACS version does not list doors)'}.`
      + (ctl.length ? ` Controllers: ${ctl.map((c) => `${c.name}${c.status === 1 ? ' (online)' : ''}`).join(', ')}.` : '');
}

$('zoneRows').addEventListener('change', (e) => {
  const row = e.target.closest('.zrow'); if (!row || e.target.dataset.f !== 'onSite') return;
  zones[Number(row.dataset.i)].onSite = e.target.checked;
  markDirty();
});
$('refreshDoors').addEventListener('click', () => withBusy($('refreshDoors'), () => loadDoors(true)));
$('discardZones').addEventListener('click', () => { zones = structuredClone(savedZones); renderZones(); markDirty(); });
$('saveZones').addEventListener('click', () => withBusy($('saveZones'), async () => {
  $('saveMsg').className = 'muted small'; $('saveMsg').textContent = 'Saving…';
  try {
    const r = await api('/api/zones', { method: 'PUT', body: JSON.stringify({ offSiteZones: zones.filter((z) => !z.onSite).map((z) => z.name) }) });
    occ = r.occupancy;
    zones = r.zones; savedZones = structuredClone(zones);
    renderOccupancy(); renderZones(); markDirty();
  } catch (e) {
    $('saveState').textContent = 'Not saved';
    $('saveMsg').className = 'small err'; $('saveMsg').textContent = e.message;
  }
}));

// Pick up zones added in Secure Entry, without disturbing a change in progress.
async function loadZones() {
  if (dirty) return;
  const fresh = (await api('/api/zones')).zones;
  if (JSON.stringify(fresh) === JSON.stringify(savedZones)) return;
  zones = fresh; savedZones = structuredClone(fresh);
  renderZones();
}

async function loadDoors(refresh = false) {
  try { doors = await api('/api/doors' + (refresh ? '?refresh=1' : '')); }
  catch (e) { $('doorSourceInfo').textContent = 'Could not list doors from ACS: ' + e.message; return; }
  await loadZones();
  renderDoors();
}

// ---------------- actions ----------------
async function withBusy(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { alert(e.message); } finally { btn.disabled = false; }
}
$('btnPoll').addEventListener('click', () => withBusy($('btnPoll'), async () => { await api('/api/poll', { method: 'POST', body: '{}' }); await refresh(); }));
$('btnPush').addEventListener('click', () => withBusy($('btnPush'), async () => { await api('/api/facilityos/push', { method: 'POST', body: '{}' }); await refresh(); }));
$('peopleFilter').addEventListener('input', renderPeople);
$('showAll').addEventListener('change', renderPeople);

async function refresh() {
  try {
    [status, occ] = await Promise.all([api('/api/status'), api('/api/occupancy')]);
    await loadZones();
    renderStatus(); renderOccupancy();
    await renderEvents();
  } catch (e) {
    $('conn').className = 'pill bad'; $('connText').textContent = 'Dashboard server not reachable: ' + e.message;
  }
}
route();
refresh();
setInterval(refresh, 5000);
