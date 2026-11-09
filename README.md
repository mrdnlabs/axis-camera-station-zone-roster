# Zone Roster (example project)

A live dashboard of **which zone people are in**, built from **AXIS Camera Station Pro Secure Entry** card reads through the ACS Pro API. It shows a count per zone, who is where, who is unconfirmed, and recent badge activity. An optional extension sends the on-site list to **FacilityOS EmergencyOS** mustering.

Zone Roster is Node.js 20+ with **no dependencies**. It has been tested against ACS Pro 6.16.19560 (API 2.43). The API findings and open questions for the vendors are in **[docs/PLAN.md](docs/PLAN.md)**.

This is example code, not a certified life-safety system. Badge data can't see tailgating or people who leave without badging, so don't rely on it alone in an emergency.

```
ACS Pro :29204  --GetExternalData (poll 60 s, overlap + dedupe)-->  Zone Roster  --optional CSV / Partner API-->  EmergencyOS
                --GetExternalDataSourceList (doors and zones)-->    │
                                                                    └─ dashboard http://127.0.0.1:8787
```

## Quick start

```powershell
cd zone-roster
copy config.example.json config.json
$env:ACS_USERNAME = 'acs'
$env:ACS_PASSWORD = '<password>'
node src/index.js discover                # lists doors, their zones and the controllers
node src/index.js run                     # polls + serves the dashboard on http://127.0.0.1:8787
```

Other commands:

* `node src/index.js poll-once` runs a single poll and prints the occupancy as JSON.
* `node src/index.js reset` clears the local journal, so the next start re-bootstraps from ACS.
* `npm test` runs 31 tests against an in-process mock of the ACS API.

## How it decides "in" vs "out"

Secure Entry states the movement on every badge at a zoned door, in the event's Location text, and Zone Roster reads it from there:

| Location text | Meaning |
|---|---|
| `Zone: To Zone01` | The person entered Zone01 |
| `Zone: From Zone01` | The person left Zone01 and is now in no zone |
| `Zone: Inside Zone01` | An inside door: the person is still in Zone01, which resets their unconfirmed timer |

Because the zone comes from each event, door sides don't matter and a door reversed in Secure Entry keeps working. Zone names and which doors belong to them come from the ACS door list on every poll, so there is nothing to map. The dashboard's **Setup** view has one setting per zone: whether it counts as on site.

A badge it can't read (a door with a different zone on each side has not been tested, and Secure Entry translates this text on non-English systems) is not counted. It appears as "Not counted" in recent activity, with a warning on the Live view.

People are identified by cardholder name, because ACS events carry no cardholder ID. One person using several cards or a PIN counts once; two people with the same name are merged, so keep names unique in Secure Entry.

## Reliability features

| Concern | Handling |
|---|---|
| Duplicate reads from overlapping windows | Each record gets a content fingerprint (SHA-256 of time, source and data). Re-reading a window never double counts. |
| Late delivery from edge controllers | Every poll re-reads `overlapSec` (300 s) before the last success. Every 15 min a deep re-sync re-reads 2 h. Occupancy is ordered by *occurrence* time, so an old record never overrides a newer one. |
| Connection loss | The watermark advances only on success, with exponential backoff (5 s up to 5 min). On recovery the whole gap is re-read, capped by `maxCatchupHours`. |
| Restart | The journal and watermark are persisted to `data/state.json`. |
| No exit reader / free egress | People whose last badge is older than `staleAfterHours` are reported as *unconfirmed* instead of on site. |

## HTTP API (for FacilityOS or other consumers)

| Endpoint | Purpose |
|---|---|
| `GET /api/muster-list` (add `?format=csv` for CSV) | Who is on site now |
| `GET /api/occupancy` | Per-zone counts and everyone's last known zone |
| `GET /api/status` | Poll health, last error, gap recovery |
| `GET /api/doors`, `GET` or `PUT /api/zones` | Doors and their zones; zones and which ones count as on site |
| `POST /api/poll`, `POST /api/facilityos/push` | Poll now, or push the muster list now (for example when an evacuation starts) |

## FacilityOS hand-off

With `facilityOs.enabled: false` (the default), Zone Roster writes `out/mustering-list.csv` whenever the list changes. Setting it to `true` and providing `FOS_CLIENT_ID`, `FOS_CLIENT_SECRET` and `FOS_CUSTOMER_ID` makes it upload that file. The upload goes to `POST https://partnerapi.goilobby.com/emos/uploadmusteringlist` with an OAuth2 client-credentials token and the `cid` header. **FacilityOS has not published the CSV columns for that endpoint**, so they are configurable in `facilityOs.csvColumns` and must be confirmed with FacilityOS.

## Security notes

* **The dashboard has no login.** It binds to 127.0.0.1 and only answers to loopback host names, plus any in `server.allowedHosts`, which blocks DNS rebinding. Add authentication, such as a reverse proxy with sign-in and TLS, before exposing it. It warns at startup if bound elsewhere.
* **ACS credentials** come from `ACS_USERNAME` and `ACS_PASSWORD`. Use a dedicated, least-privilege ACS user, and don't put passwords in `config.json`.
* **ACS's certificate is self-signed**, so verification is on by default and needs a choice. Pin it with `acs.tls.caFile` or `acs.tls.fingerprint256`. `config.example.json` sets `allowSelfSigned: true` for a server on the same machine; don't use that across a network.
* **`data/` and `out/` contain real names and card numbers** in plain text. They are git-ignored, along with `config.json`. Don't include them when sharing the project, and restrict access to them on the server. Badge history is kept for `presence.journalRetentionDays`.
* The dashboard shows card numbers. Remove them from `public/app.js` if your site treats them as sensitive.
* Text from ACS is HTML-escaped in the UI, a Content-Security-Policy limits the page to its own files, and CSV cells are protected against formula injection. Changes require a same-origin JSON request.

## Code map

| File | Role |
|---|---|
| `src/acsClient.js` | ACS Pro API client: Basic auth, TLS pinning, pagination, error mapping |
| `src/normalize.js` | Raw Secure Entry record → normalized event, plus fingerprinting |
| `src/occupancy.js` | Turns badge events into who is in which zone |
| `src/poller.js` | Poll windows, overlap, deep re-sync, gap recovery, backoff |
| `src/discovery.js` | Doors and their zones (source list + event scan + device list) |
| `src/store.js` | Persisted journal and watermark |
| `src/facilityOsSink.js` | Muster CSV and FacilityOS upload |
| `src/server.js`, `public/` | Dashboard and JSON API |
