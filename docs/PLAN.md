# Zone Roster: ACS Pro findings and design notes

Status: example project, tested against a live AXIS Camera Station Pro 6.16.19560 (API 2.43) server in November 2026.

## 1. Goal

Show which zone people are in, live, from AXIS Camera Station Pro (ACS Pro) Secure Entry badge reads:

1. Read Secure Entry door events and the door list from ACS Pro.
2. Work out each cardholder's current zone from what each badge event says.
3. Keep a count per zone, show recent activity, and mark people not seen for a while as unconfirmed.
4. Optionally, send the on-site list to FacilityOS EmergencyOS, as a CSV file or through its Partner API.

## 2. What the ACS Pro API offers (verified on the live server)

| Need | API | Status | Notes |
|---|---|---|---|
| Badge events | `ExternalDataFacade/GetExternalData` | Documented (API 2.32+) | Secure Entry writes every door event into Data search as external data. This endpoint reads it back. |
| List of doors | `ExternalDataSourceFacade/GetExternalDataSourceList` | **Undocumented**, but present on 6.16 | Returns every external data source with `Name`, `Key` and `PluginId`. Secure Entry doors have `PluginId: "axis_secureentry"`. Fallback: collect the distinct `Source` names seen in events. |
| Door controllers | `DeviceListFacade/GetDeviceList` | Documented | `ProductType: "Network Door Controller"`. Used only for display and diagnostics. |
| Zones | `GetExternalDataSourceList` and event text | **Undocumented**, but present on 6.16 | Each door lists its zones in `GroupNames`, and badge events state the movement in the `Location` text (section 4). There is no zone API. |
| Cardholder directory | none | Not available | Events carry the cardholder's display name and card number only, with no stable cardholder ID. |
| Server info | `VersionFacade/GetApiVersion`, `SystemFacade/GetSystem` | Documented | Health check, version and time zone. |

Base URL: `https://<server>:29204/Acs/Api/<Facade>/<Operation>`. Requests are HTTP POST with a JSON body. Authentication is HTTP Basic, NTLM or Kerberos. The certificate is self-signed.

### 2.1 What a Secure Entry event looks like

This is a real `AccessGranted` record with identifiers replaced. Fields marked HiddenContent are machine-readable values that the ACS client UI does not display.

```json
{
  "OccurrenceTime": "2026-11-04 03:13:37.0000000",
  "Source": "d1",
  "Data": {
    "Event":        { "DataType": "Text", "Value": "Access granted through d1" },
    "Cardholder":   { "DataType": "Text", "Value": "test test\nCard numbers: 1000000001 (Used)" },
    "Location":     { "DataType": "Text", "Value": "d1\nDirection: From side A\nUnit: AXIS A1610 [axis-controller.lan]" },
    "cardholder":   { "DataType": "HiddenContent", "Value": "test test" },
    "cardnumber":   { "DataType": "HiddenContent", "Value": "1000000001" },
    "event_type":   { "DataType": "HiddenContent", "Value": "AccessGranted" },
    "licenceplate": { "DataType": "HiddenContent", "Value": "" }
  }
}
```

`event_type` values seen on the test system: `AccessGranted`, `AccessDeniedAnonymous`, `locked`, `unlocked`, `doorPhysicalOpen`, `doorForced`, `doorHeld`, `tamper`, `tamperreset`, `ReaderConnection`, `DeviceConnected`, `DeviceDisconnected`.

### 2.2 GetExternalData behaviour, measured on the live server

* `Filter: "[event_type] = AccessGranted"` works server-side on HiddenContent fields, and `OR` works too. Using it cuts the volume to badge reads only. This test server holds 55,829 records, of which 19 are `AccessGranted`.
* `StartTime` and `EndTime` must use the format `YYYY-MM-DD hh:mm:ss[.fffffff]` in UTC. The format `hh-mm-ss` given in the PDF is **wrong**: the server rejects it with `Could not convert string to DateTime`.
* `Sources` takes the source **Key** (a GUID), not the name. An unknown key fails the whole request with `CommunicationException: One or more sources are not found`. For that reason Zone Roster filters doors on the client side.
* Results come back newest first. `NextPageToken` pages through them, and `TotalNumberOfRecords` is filled only on the first page.
* `OccurrenceTime` has one-second resolution on Secure Entry events, always ending `.0000000`.
* `Source` is the door **name** and is missing on events from doors that have since been deleted. The first line of `Location` still holds the door name.
* There is no record ID, so duplicates have to be detected from the record content.

## 3. Polling, gap recovery and de-duplication

```
every intervalSec (default 60 s):
  start = lastSuccessfulPollStart − overlapSec   (first run: now − bootstrapLookbackHours)
  start = max(start, now − maxCatchupHours)      (flags "gap truncated" if it clipped)
  GET external data where event_type ∈ eventTypes and time ≥ start  (follow NextPageToken)
  for each record: fingerprint = sha256(canonical JSON of OccurrenceTime + Source + Data)
                   if fingerprint is already in the journal → duplicate, skip
                   else add it to the journal
  on success: lastSuccessfulPollStart = the time this poll started
  on failure: back off exponentially (capped); the watermark stays put, so the next
              successful poll automatically re-reads the whole outage window
every deepResyncEveryMin (default 15 min): one poll re-reads deepResyncWindowMin (default 120 min)
```

* **Late edge delivery.** Door controllers buffer events while offline and upload them on reconnect, so `OccurrenceTime` can be well in the past when a record first appears. The overlap (default 300 s) covers small delays, and the periodic deep re-sync catches anything later. Occupancy is computed by **occurrence time**, not arrival time, so a late record that is older than a person's latest event never overrides it.
* **Connection loss.** The watermark only advances after a successful poll. After an outage the next poll starts at `lastSuccessfulPollStart − overlap`, so the gap is filled automatically.
* **No double counting.** The journal is keyed by content fingerprint. Re-reading the same window any number of times changes nothing.
* **Server clock vs. connector clock.** `EndTime` is never sent, so the server uses its own "now". The overlap absorbs small clock skew between the connector and the ACS server.

## 4. Zones and movement

Secure Entry zones are made of perimeter doors and inside doors. Readers belong to door sides. There is no public zone API, but zones reach external data in two places:

* `GetExternalDataSourceList` gives each door's zones in `GroupNames`. Zone Roster reads this on every poll.
* Each access event's `Location` text has a `Zone:` line. The wording seen on badges:

| Zone line | Event text | Meaning |
|---|---|---|
| `Zone: To Zone01` | Access granted to Zone01 | Entered Zone01 |
| `Zone: From Zone01` | Access granted through door01 | Left Zone01 |
| `Zone: Inside Zone01` | Access granted to Zone01 | Inside door: still in Zone01 |

`Direction: From side A` doesn't say whether that side is inside the zone, and it stays the same when a door is reversed in Secure Entry, so Zone Roster relies on the `Zone:` line alone.

Not yet observed: a door with a different zone on each side, a granted PIN, and non-English systems (Secure Entry translates this text). A badge that can't be read isn't counted and is flagged on the Live view.

Each zone has one local setting, `offSiteZones`, which decides whether people in it count toward the on-site total and the muster list. Door controllers also expose zones through an undocumented `/nbix/accesscontrol` REST API, but Zone Roster doesn't need it.

### 4.1 Presence rules and known limitations

| Situation | Behaviour |
|---|---|
| Free egress (REX button, no exit reader) | No exit event is recorded, so the person stays "on site". `staleAfterHours` (default 18 h) marks people whose last badge is older than that as *unconfirmed*. A badge at an inside door resets the timer. EmergencyOS can treat them as "unconfirmed" rather than missing. |
| Tailgating, or a door held open for a group | Only the person who badged is moved. This is inherent to badge-based mustering. |
| Access granted but door not opened | Counted as a transition. A stricter mode could require a `doorPhysicalOpen` on the same door within N seconds. This mode is not implemented. |
| Access denied | Ignored; the person does not move. |
| Two cardholders with the same name | They merge, because events carry no cardholder ID. `presence.personKey` can be set to `cardnumber` instead, but then a person with several cards is split. **Ask Axis to add a cardholder ID (token) to the external data record.** |
| Anti-passback zones | Compatible. Anti-passback makes entries and exits more reliable. |

## 5. Optional extension: FacilityOS / EmergencyOS

FacilityOS has no inbound webhook. Its v1 Partner API does have `POST /emos/uploadmusteringlist`: a multipart CSV upload with an OAuth 2.0 client-credentials bearer token and a `cid` (CustomerId) header. The response is `{status, total, errorMessage}`. The **CSV column schema is not published**, so Zone Roster:

* writes `out/mustering-list.csv` on every change (dry-run mode, the default), with configurable column names;
* uploads that CSV when `facilityOs.enabled = true`, on change and at least every `pushEveryMin`, and on demand from `POST /api/facilityos/push` (for example, wired to the "start muster" trigger);
* serves `GET /api/muster-list` as JSON for any other consumer.

FacilityOS's own pull connectors (Kantech, ISONAS, AxiomXA) sync every 15 minutes and again when an evacuation starts. A 60-second ACS poll with an on-demand push is fresher than those connectors.

## 6. Questions to take to the vendors

**FacilityOS**
1. The exact CSV schema for `/emos/uploadmusteringlist`: required columns, the person identifier (email, employee ID or badge number) and zone or site columns. Does an upload replace or merge with the current list?
2. Is v1 `uploadmusteringlist` the right endpoint for a live occupancy feed, or is there a presence API like the one behind the Genetec connector?
3. Rate limits and token lifetime.
4. How is a stale or unconfirmed presence represented?

**Axis**
1. Can `GetExternalDataSourceList` be documented and supported? It is the only way to list doors.
2. Can a stable cardholder ID (or external ID / employee number) be included in Secure Entry external-data records?
3. Is a zone or roll-call API planned? Can the `Zone:` line in event text be documented, or provided as a structured field?
4. Does `TotalNumberOfRecords` and pagination stay stable while new records arrive?

## 7. Production hardening (beyond this example)

* Replace the JSON state file with SQLite or a database, and run Zone Roster as a Windows service (for example with NSSM).
* Pin the ACS certificate with `acs.tls.caFile` or `acs.tls.fingerprint256` instead of `allowSelfSigned`.
* Use a dedicated least-privilege ACS user (operator role with Data search access).
* Store secrets in Windows Credential Manager or DPAPI instead of environment variables.
* Run on the ACS server or on the same LAN. Only outbound HTTPS to FacilityOS is needed.
* Map people to the FacilityOS address book by email or employee ID once the cardholder-ID question is resolved.
