# Zone Roster (example project)

A live dashboard of **which zone people are in**, built from **AXIS Camera Station Pro Secure Entry** card reads through the ACS Pro API. It shows a count per zone, who is where, who is unconfirmed, and recent badge activity.

Zone Roster is Node.js 20+ with **no dependencies**. It has been tested against ACS Pro 6.16.19560 (API 2.43). The API findings and open questions for the vendors are in **[docs/PLAN.md](docs/PLAN.md)**.

This is example code, not a certified life-safety system. Badge data can't see tailgating or people who leave without badging, so don't rely on it alone in an emergency.

```
ACS Pro :29204  --GetExternalData (poll 60 s, overlap + dedupe)-->  Zone Roster
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
* `npm test` runs 47 tests against an in-process mock of the ACS API.

## Run it as a Windows service

The dashboard then starts at boot and keeps running with nobody signed in. A tray icon, started at each sign-in, opens it with one click and turns grey if it isn't reachable.

**To build the installer,** with Node.js 20 or newer on the PATH:

```powershell
powershell -ExecutionPolicy Bypass -File .\windows\Build.ps1
```

That produces `windows\bin\ZoneRosterSetup.exe`, a single 30 MB file built with the C# compiler included in Windows. It contains the app and a copy of your Node.js, so the target server needs nothing else. If you share the file, include [Node's license](https://github.com/nodejs/node/blob/main/LICENSE).

**To install, upgrade or remove it,** run `ZoneRosterSetup.exe` and approve the Windows prompt. You can enter the ACS username and password there, or leave them blank and enter them in the dashboard's **Setup** view. Installing again upgrades the app and keeps your settings. It's also listed in Windows' **Installed apps**. Uninstalling keeps your settings and badge history unless you tick the option to delete them.

| Location | Contents |
|---|---|
| `%ProgramFiles%\ZoneRoster` | The app, its copy of `node.exe`, the service host, the tray icon and the setup program |
| `%ProgramData%\ZoneRoster` | `config.json`, `secrets.dat`, `data` and `logs\service.log` |

Which zones count as on site, the unconfirmed limit and the ACS sign-in are all set in the **Setup** view. For anything else, such as an ACS server on another machine, edit `%ProgramData%\ZoneRoster\config.json` as an administrator and restart the `ZoneRoster` service. If the service won't stay running, check the log, or stop the service and run `ZoneRosterService.exe --console` from an elevated prompt.

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

## When zones change in Secure Entry

The zone list and door membership are re-read on every poll, so changes appear within a minute.

| Change | What happens |
|---|---|
| New zone | Appears automatically and counts as on site until you turn that off in Setup |
| Door moved to another zone, or reversed | The next badge there uses the new zone. Each badge states its own zone |
| Zone renamed or deleted | Past exits still count. Anyone last seen in it stays counted under the old name, marked **Not in ACS** with a warning, until they next badge or become unconfirmed |
| Off-site zone renamed | ACS gives zones no ID, so the new name is treated as a new zone and counts as on site. Turn it off again in Setup |

## Reliability features

| Concern | Handling |
|---|---|
| Duplicate reads from overlapping windows | Each record gets a content fingerprint (SHA-256 of time, source and data). Re-reading a window never double counts. |
| Late delivery from edge controllers | Every poll re-reads `overlapSec` (300 s) before the last success. Every 15 min a deep re-sync re-reads 2 h. Occupancy is ordered by *occurrence* time, so an old record never overrides a newer one. |
| Connection loss | The watermark advances only on success, with exponential backoff (5 s up to 5 min). On recovery the whole gap is re-read, capped by `maxCatchupHours`. |
| Restart | The journal and watermark are persisted to `data/state.json`. |
| No exit reader / free egress | People whose last badge is older than the limit set in Setup (18 hours by default) are reported as *unconfirmed* instead of on site. |

## HTTP API

| Endpoint | Purpose |
|---|---|
| `GET /api/on-site` (add `?format=csv` for CSV) | Who is on site now |
| `GET /api/occupancy` | Per-zone counts and everyone's last known zone |
| `GET /api/status` | Poll health, last error, gap recovery |
| `GET /api/doors`, `GET` or `PUT /api/zones` | Doors and their zones; zones and which ones count as on site |
| `PUT /api/presence` | Set `staleAfterHours`, the unconfirmed limit |
| `POST /api/poll` | Poll now |

## Security notes

* **The dashboard has no login.** It binds to 127.0.0.1 and only answers to loopback host names, plus any in `server.allowedHosts`, which blocks DNS rebinding. Add authentication, such as a reverse proxy with sign-in and TLS, before exposing it. It warns at startup if bound elsewhere.
* **ACS credentials** come from `ACS_USERNAME` and `ACS_PASSWORD`, or from the Windows service's encrypted store. Use a dedicated, least-privilege ACS user, and don't put passwords in `config.json`.
* **Under the Windows service,** credentials are in `secrets.dat`, encrypted with DPAPI for the machine and readable only by administrators and the service. The service runs as the low-privilege account `NT SERVICE\ZoneRoster`, and only that account and administrators can read the badge history and logs. Any local user can still open the dashboard on the loopback address.
* **Changing the ACS sign-in in Setup** works only in a browser on the server itself, because the dashboard has no TLS, and requests marked as forwarded by a proxy are refused. A new sign-in is tested against the configured ACS before it replaces the old one, and the web UI can't change which ACS that is, so saved credentials can't be redirected. While the stored sign-in still works, replacing it requires its password. Once ACS rejects it, because its password was changed, any working account can replace it. Five wrong passwords lock the form for five minutes. Passwords are never returned, logged or passed on a command line.
* **The installer** runs system tools by full path, and refuses a settings folder or file that an administrator didn't create, since any user can create folders in `ProgramData` and a planted config could send the ACS password elsewhere. It also refuses a config file holding a password. It isn't code-signed, so Windows warns about it, and you should only run a copy you built or trust.
* **ACS's certificate is self-signed**, so verification is on by default and needs a choice. Pin it with `acs.tls.caFile` or `acs.tls.fingerprint256`. `config.example.json` sets `allowSelfSigned: true` for a server on the same machine; don't use that across a network.
* **`data/` contains real names and card numbers** in plain text. It is git-ignored, along with `config.json`. Don't include it when sharing the project, and restrict access to it on the server. Badge history is kept for `presence.journalRetentionDays`.
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
| `src/csv.js` | CSV export of the people on site |
| `src/server.js`, `public/` | Dashboard and JSON API |
| `src/credentials.js` | Testing and storing a new ACS sign-in from Setup |
| `windows/` | Service host, tray icon, setup program and build script |
