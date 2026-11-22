# Watch checks: HTTP/HTTPS, TLS certificate expiry, SNMP OID (Live monitoring → Add check)

Four more check kinds next to ping, TCP and DNS. The site collector runs them on the check's interval.
Results go through the usual pipeline: samples, hourly roll-up, state machine, events, incidents,
Network Doctor and Insights.

## Prerequisites

- An enrolled collector on the site, and an authorized scope covering the target. For a public host,
  the check needs **allow public host**.
- For `snmp_oid`: an SNMP device already added in Port Detective (`snmp_targets`) on the same site.
  The check reuses that device's address and encrypted credentials. Deleting the device deletes its
  checks (FK `ON DELETE CASCADE`).
- Roles: owner, admin and technician can create, edit and delete checks. A viewer can only read them.
  Every change writes an audit row (`check.create` / `check.update` / `check.delete`), with the
  settings in the metadata. Settings never include a secret.

## Kinds and settings (migration `039_watch_checks_and_neighbors.sql`, `apps/api/src/modules/monitoring/kinds.ts`)

- **http / https**: the URL is split into host, port and path.
  - Method: GET or HEAD.
  - Expected status: a single code or a range (default 200–299).
  - Optional body assertion: substring or regex, optionally negated. The collector reads only the first
    256 KiB. Regexes are Go RE2, which runs in linear time; the API refuses lookaround and
    back-references. A body assertion is not allowed with HEAD.
  - Redirects: follow or don't, with a limit of 0–10. Every hop is checked again by the guard.
  - https only: TLS verification is on by default, and an optional SHA-256 pin of the leaf
    certificate can be set. The pin is checked even when verification is off.
  - What the collector reports: status code, final URL (query string removed), number of redirects,
    whether the body matched, TLS version, certificate subject/issuer/validity/SHA-256/DNS names, and
    the verification result. The response body is never uploaded.
- **tls_expiry**: TLS handshake to host:port, with an optional SNI.
  - The value is the number of days left. Defaults: warning at 30 days or fewer, critical at 7 or
    fewer. Critical must be lower than warning.
  - Issuer, subject, notBefore, notAfter and the verification result are stored as evidence.
- **snmp_oid**: a read-only SNMP GET of one OID, plus an optional divisor OID for ratios. The value is
  `(ratio ? 100 × raw / divisor : raw) × multiplier`.
  - The value is compared to a warning and/or critical threshold with `>`, `<`, `=` or `≠`.
  - Presets: CPU (hrProcessorLoad), memory (hrStorageUsed / hrStorageSize), temperature
    (entPhySensorValue) and link status (ifOperStatus ≠ 1).
  - Each preset carries a vendor note. Cisco CPU needs CISCO-PROCESS-MIB. MikroTik temperature is
    reported in tenths of a degree. Memory and sensor indexes differ per device. Many small switches
    expose neither memory nor temperature.

`GET /checks/snmp-presets` lists the presets. POST and PATCH validate the settings with Zod, per kind.
PATCH re-validates the whole settings object against the unchanged kind and target.

## Safety rule (SSRF)

This follows the same rule as email delivery and the toolbox.

- **At the API**: an IPv4 literal must be inside an authorized scope. A public IPv4 needs
  `allow_public`. Loopback, link-local, CGNAT, multicast and reserved addresses are refused.
- **At the collector** (`collectors/lan-collector/internal/watch/guard.go`): every address a name
  resolves to must pass the rule, and the connection goes to the address that was checked. No
  environment proxy is used. Redirects are re-checked when they are dialled.
- A refused target produces the error `refused: …` without any packet being sent. Doctor
  (`watch-target-refused`) and Insights (`watch_refused`) explain it.
- SNMP OID checks only read devices whose address is inside an authorized scope.

## Results, Doctor, Insights

- `check_results.value`, `monitoring_checks.last_value` and `last_details` store the measured value
  and its evidence.
- The roll-up stores `value_avg`, `value_min` and `value_max`. The series API returns them, and the
  check chart draws a value chart for SNMP and certificate checks.
- **Where thresholds are evaluated**:
  - Value thresholds (certificate days, SNMP value) are evaluated by the API, so editing a threshold
    applies from the next sample.
  - The HTTP status and the body assertion are evaluated by the collector, because the body never
    leaves the site.
  - The worse of the value classification and the latency classification wins.
- **Event titles** say what happened: "certificate expires in N days", "certificate expired",
  "critical/warning threshold crossed", "not responding", "recovered".
- **Doctor rules** (`apps/api/src/modules/doctor/watch-rules.ts`): `watch-target-refused`,
  `watch-certificate-expired`, `watch-certificate-expiring`, `watch-certificate-pin-mismatch`,
  `watch-certificate-untrusted`, `watch-http-status`, `watch-http-content`, `watch-snmp-threshold`,
  `watch-snmp-oid-missing` and `watch-snmp-unreadable`. Each one shows the observed evidence
  (certificate, HTTP response, OID value).
- **Insights**: `certificate_expiring` comes from tls_expiry values and the certificate of https
  checks. It is a warning at 30 days or fewer and critical at 7 or fewer.
- Web: an add/edit form for each kind, with the measured value and the evidence shown on the
  monitoring screen. All of it is in EN and AR, with technical values wrapped in bidi isolates.

## Verified

- **Go, collector**:
  - `internal/watch/watch_test.go`: the guard rule (scopes, public, loopback/link-local/metadata,
    every resolved address); HTTP status ranges, body substring/regex/negation, the 256 KiB bound;
    redirect limits; a redirect to a forbidden address refused at dial time; HTTPS verification on
    and off; pin match and mismatch; TLS expiry days, expired certificates, and a port that is not TLS.
  - `internal/watch/snmpoid_test.go`: raw values, ratio and multiplier, and a missing OID, all against
    the in-process SNMP simulator.
  - `internal/agent/watch_test.go`: dispatch of the four kinds, the guard, and SNMP credentials taken
    from the heartbeat.
  - All of these servers are local `httptest` / loopback servers.
- **API**, `apps/api/tests/watch-checks.test.ts` (embedded Postgres):
  - validation per kind, SNMP device lookup and cascade, roles and audit;
  - ingestion of values and details, threshold transitions and their event titles, series and
    roll-up;
  - `classifySample`, the Doctor rules, and the Insights.

## Not verified

- Never run against a real web server, a real certificate authority chain or a real SNMP device.
  Vendor OID notes come from the MIBs and vendor documentation, not from hardware tested here.
- Hostname targets are only enforced at the collector. The API cannot know where a name resolves
  from the site.
