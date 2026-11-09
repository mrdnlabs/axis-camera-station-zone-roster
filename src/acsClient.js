// Minimal, dependency-free client for the AXIS Camera Station Pro API.
//
//   URI:   https://<server>:29204/Acs/Api/<Facade>/<Operation>
//   Body:  JSON (HTTP POST)
//   Auth:  HTTP Basic (NTLM/Kerberos are also accepted by ACS but not implemented here)
//   TLS:   ACS uses a self-signed certificate. Prefer pinning (tls.caFile or tls.fingerprint256)
//          over tls.allowSelfSigned.

import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import { formatAcsTime } from './time.js';

export class AcsError extends Error {
  constructor(message, { status, type, retryable } = {}) {
    super(message);
    this.name = 'AcsError';
    this.status = status;       // HTTP status, if any
    this.type = type;           // ACS exception type, e.g. "CommunicationException"
    this.retryable = retryable; // true for network errors / 5xx
  }
}

export class AcsClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl   e.g. "https://acs-server:29204"
   * @param {string} opts.username
   * @param {string} opts.password
   * @param {number} [opts.timeoutMs]
   * @param {{allowSelfSigned?: boolean, caFile?: string, fingerprint256?: string}} [opts.tls]
   */
  constructor({ baseUrl, username, password, timeoutMs = 20000, tls = {} }) {
    if (!baseUrl) throw new Error('acs.baseUrl is required');
    this.base = new URL(baseUrl);
    this.isHttps = this.base.protocol === 'https:';
    this.setCredentials(username, password);
    this.timeoutMs = timeoutMs;
    this.pin = tls.fingerprint256 ? tls.fingerprint256.replace(/[^0-9a-f]/gi, '').toUpperCase() : null;
    if (this.isHttps) {
      const agentOpts = { keepAlive: true, maxSockets: 4 };
      if (tls.caFile) agentOpts.ca = fs.readFileSync(tls.caFile);
      // With a pinned fingerprint we verify the cert ourselves (below) before any credentials are sent.
      else if (tls.allowSelfSigned || this.pin) agentOpts.rejectUnauthorized = false;
      this.agent = new https.Agent(agentOpts);
    } else {
      this.agent = new http.Agent({ keepAlive: true, maxSockets: 4 });
    }
  }

  setCredentials(username, password) {
    this.auth = username ? 'Basic ' + Buffer.from(`${username}:${password ?? ''}`).toString('base64') : null;
  }

  close() { this.agent.destroy(); }

  /** Rejects unless this sign-in can read the badge events the app depends on. */
  verifyAccess() { return this.call('ExternalDataFacade', 'GetExternalData', { Limit: 1 }); }

  /** POST a JSON body to /Acs/Api/<facade>/<operation>. Resolves to parsed JSON (or null for empty body). */
  call(facade, operation, body = {}) {
    const url = new URL(`/Acs/Api/${facade}/${operation}`, this.base);
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    const lib = this.isHttps ? https : http;
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': payload.length, Accept: 'application/json' };
    if (this.auth) headers.Authorization = this.auth;

    return new Promise((resolve, reject) => {
      const req = lib.request(url, { method: 'POST', agent: this.agent, headers, timeout: this.timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          if (text.trim()) {
            try { json = JSON.parse(text); } catch { /* non-JSON body */ }
          }
          if (res.statusCode === 200) return resolve(json);
          if (res.statusCode === 401) {
            return reject(new AcsError('ACS rejected the credentials (401 Unauthorized)', { status: 401, retryable: false }));
          }
          const type = json?.Type ?? res.statusMessage;
          const msg = json?.Message ?? text.slice(0, 300);
          reject(new AcsError(`${facade}/${operation} failed: HTTP ${res.statusCode} ${type}: ${msg}`,
            { status: res.statusCode, type, retryable: res.statusCode >= 500 }));
        });
        res.on('error', (e) => reject(new AcsError(`Response error: ${e.message}`, { retryable: true })));
      });
      req.on('timeout', () => req.destroy(new Error(`timed out after ${this.timeoutMs} ms`)));
      req.on('error', (e) => {
        if (e instanceof AcsError) return reject(e);
        // ECONNREFUSED on dual-stack hosts surfaces as an AggregateError with an empty message.
        const detail = e.message || e.code || e.errors?.map((x) => x.code || x.message).join(', ') || String(e);
        reject(new AcsError(`Cannot reach ACS at ${this.base.origin}: ${detail}`, { retryable: true }));
      });

      // Certificate pinning: only write the body (and credentials header is already queued but not flushed
      // until end()) after the peer certificate matches the configured SHA-256 fingerprint.
      const send = () => req.end(payload);
      if (this.isHttps && this.pin) {
        req.on('socket', (sock) => {
          const verify = () => {
            const fp = (sock.getPeerCertificate()?.fingerprint256 || '').replace(/:/g, '').toUpperCase();
            if (fp !== this.pin) return req.destroy(new AcsError(`ACS certificate fingerprint mismatch (got ${fp})`, { retryable: false }));
            send();
          };
          if (sock.connecting || !sock.getPeerCertificate?.()?.fingerprint256) sock.once('secureConnect', verify);
          else verify();
        });
      } else {
        send();
      }
    });
  }

  // ---- Documented operations -------------------------------------------------------------

  getApiVersion() { return this.call('VersionFacade', 'GetApiVersion'); }
  getSystem() { return this.call('SystemFacade', 'GetSystem'); }

  async getDeviceList() {
    const out = [];
    for (let start = 0; ; start += 100) {
      const r = await this.call('DeviceListFacade', 'GetDeviceList', { range: { StartIndex: start, NumberOfElements: 100 } });
      out.push(...(r?.Devices ?? []));
      if (r?.ContainsLastDevice !== false || !r?.Devices?.length) return out;
    }
  }

  /**
   * GetExternalData with automatic NextPageToken pagination.
   * Results from ACS are newest-first; this returns them in that order.
   * @param {{startMs?: number, endMs?: number, filter?: string, sources?: string[], pageSize?: number, maxPages?: number}} q
   */
  async getExternalData({ startMs, endMs, filter, sources, pageSize = 500, maxPages = 200 } = {}) {
    const first = { Limit: pageSize };
    if (Number.isFinite(startMs)) first.StartTime = formatAcsTime(startMs);
    if (Number.isFinite(endMs)) first.EndTime = formatAcsTime(endMs); // normally omitted -> server "now"
    if (filter) first.Filter = filter;
    if (sources?.length) first.Sources = sources; // NOTE: source *keys*, not names
    const results = [];
    let body = first, total = null, pages = 0;
    while (true) {
      const r = await this.call('ExternalDataFacade', 'GetExternalData', body);
      pages++;
      if (total === null && Number.isFinite(r?.TotalNumberOfRecords)) total = r.TotalNumberOfRecords;
      results.push(...(r?.Results ?? []));
      if (!r?.NextPageToken || !r?.Results?.length) break;
      if (pages >= maxPages) throw new AcsError(`GetExternalData exceeded maxPages=${maxPages} (${results.length} records); narrow the window`, { retryable: false });
      body = { NextPageToken: r.NextPageToken };
    }
    return { results, total, pages };
  }

  // ---- Undocumented (present on ACS Pro 6.16) -------------------------------------------

  /**
   * Lists external data sources (one per Secure Entry door, PluginId "axis_secureentry").
   * Not in the public API document; returns null if the server does not support it.
   */
  async getExternalDataSourceList() {
    const out = [];
    try {
      for (let start = 0; ; start += 100) {
        const r = await this.call('ExternalDataSourceFacade', 'GetExternalDataSourceList', { range: { StartIndex: start, NumberOfElements: 100 } });
        out.push(...(r?.ExternalDataSources ?? []));
        if (r?.ContainsLastExternalDataSource !== false || !r?.ExternalDataSources?.length) return out;
      }
    } catch (e) {
      if (e instanceof AcsError && e.status === 400) return null; // unknown method on this version
      throw e;
    }
  }
}
