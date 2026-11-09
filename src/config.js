// Config loading/saving. The web UI can change which zones count as on site and the unconfirmed limit.
// Secrets come from environment variables so they never need to be written to this file.

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULTS = {
  acs: {
    baseUrl: 'https://localhost:29204',
    username: '',              // or env ACS_USERNAME
    password: '',              // or env ACS_PASSWORD (preferred)
    timeoutMs: 20000,
    tls: { allowSelfSigned: false, caFile: '', fingerprint256: '' }, // ACS certificates are self-signed: pin one, or opt in for a lab
  },
  polling: {
    intervalSec: 60,             // normal poll cadence
    overlapSec: 300,             // re-read this much before the last successful poll (late edge delivery, clock skew)
    bootstrapLookbackHours: 24,  // first start with empty state
    maxCatchupHours: 72,         // after a long outage, never read further back than this
    deepResyncEveryMin: 15,      // periodically re-read a longer window...
    deepResyncWindowMin: 120,    // ...this long, to catch very late uploads from offline controllers
    pageSize: 500,
    backoffMaxSec: 300,
    eventTypes: ['AccessGranted'], // which event_type values move a person through a door
  },
  presence: {
    personKey: 'cardholder',     // 'cardholder' (name) or 'cardnumber'
    staleAfterHours: 18,         // on-site people with no badge for this long are reported as stale
    journalRetentionDays: 7,
  },
  offSiteZones: [],              // Secure Entry zone names that don't count as on site (e.g. a parking garage)
  server: { host: '127.0.0.1', port: 8787, allowedHosts: [] }, // allowedHosts: extra host names the dashboard answers to
  dataDir: './data',
};

function deepMerge(base, over) {
  if (Array.isArray(over) || typeof over !== 'object' || over === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = (base && typeof base[k] === 'object' && !Array.isArray(base[k]) && base[k] !== null && typeof v === 'object' && !Array.isArray(v))
      ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(file) {
  const abs = path.resolve(file);
  const raw = fs.existsSync(abs) ? JSON.parse(fs.readFileSync(abs, 'utf8')) : {};
  const cfg = deepMerge(DEFAULTS, raw);
  const env = process.env;
  if (env.ACS_BASE_URL) cfg.acs.baseUrl = env.ACS_BASE_URL;
  if (env.ACS_USERNAME) cfg.acs.username = env.ACS_USERNAME;
  if (env.ACS_PASSWORD) cfg.acs.password = env.ACS_PASSWORD;
  const baseDir = path.dirname(abs);
  cfg.dataDir = path.resolve(baseDir, cfg.dataDir);
  cfg._file = abs;
  cfg._passwordInFile = Boolean(raw.acs?.password);
  return cfg;
}

export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const isLoopback = (host) => LOOPBACK_HOSTS.includes(host) || host === '::1';

/** Risky combinations worth a line in the log at startup. */
export function securityWarnings(cfg) {
  const out = [];
  if (!isLoopback(cfg.server.host)) out.push(`The dashboard listens on ${cfg.server.host} and has no login: anyone who can reach it can see names and card numbers.`);
  if (cfg._passwordInFile) out.push(`${cfg._file} contains the ACS password in plain text. Remove it and use ACS_PASSWORD or the Windows service's encrypted store.`);
  const acs = new URL(cfg.acs.baseUrl);
  if (!isLoopback(acs.hostname)) {
    if (acs.protocol === 'http:') out.push('ACS is reached over plain HTTP: its username and password are sent unencrypted.');
    else if (cfg.acs.tls.allowSelfSigned && !cfg.acs.tls.caFile && !cfg.acs.tls.fingerprint256) out.push('The ACS certificate is not being verified. Set acs.tls.caFile or acs.tls.fingerprint256.');
  }
  return out;
}

export function validateOffSiteZones(list) {
  if (!Array.isArray(list)) return ['offSiteZones must be a list of zone names'];
  if (list.length > 500) return ['too many zones'];
  return list.filter((z) => typeof z !== 'string' || !z.trim() || z.length > 200).map((z) => `invalid zone name: ${JSON.stringify(z)}`);
}

export const MIN_STALE_HOURS = 0.5;

/** The longest limit that works: badge history older than the retention period is deleted. */
export const maxStaleHours = (cfg) => cfg.presence.journalRetentionDays * 24;

export function validateStaleAfterHours(hours, cfg) {
  const max = maxStaleHours(cfg);
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < MIN_STALE_HOURS || hours > max) {
    return [`The unconfirmed limit must be between ${MIN_STALE_HOURS} and ${max} hours`];
  }
  return [];
}

// Changes one part of the config file, keeping every other key the user wrote.
function updateConfigFile(cfg, change) {
  const raw = fs.existsSync(cfg._file) ? JSON.parse(fs.readFileSync(cfg._file, 'utf8')) : {};
  change(raw);
  const tmp = cfg._file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, cfg._file);
}

export function saveOffSiteZones(cfg, offSiteZones) {
  updateConfigFile(cfg, (raw) => { raw.offSiteZones = offSiteZones; });
  cfg.offSiteZones = offSiteZones;
}

export function saveStaleAfterHours(cfg, staleAfterHours) {
  updateConfigFile(cfg, (raw) => { raw.presence = { ...raw.presence, staleAfterHours }; });
  cfg.presence.staleAfterHours = staleAfterHours;
}
