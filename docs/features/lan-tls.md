# Built-in LAN TLS

Collectors and endpoint agents on other computers talk to the API over HTTPS. When you do not have a
certificate of your own, Nigafiy creates a small local certificate authority and a server
certificate for this computer, and shows the CA fingerprint that collectors and agents pin.

## How to turn it on

Set `HTTPS_PORT` (and `HTTPS_HOST=0.0.0.0` to listen on the LAN) in `.env`. With no
`TLS_CERT_FILE` / `TLS_KEY_FILE`, `LAN_TLS=auto` (the default) creates the certificates on first
start. `LAN_TLS=off` starts no HTTPS listener without certificate files. Giving only one of
`TLS_CERT_FILE` / `TLS_KEY_FILE` is reported as an error and HTTPS stays off (it is never silently
replaced by the built-in certificate).

The API process does the work (`apps/api/src/infrastructure/lan-tls.ts`, called from `main.ts`), so
the dev launcher (`scripts/local.mjs`) and the Nigafiy Engine (which runs `local.mjs`) get the same
behaviour. `local.mjs` sets `TLS_AUTO_DIR=<data dir>/tls`; without it the folder is
`<API working directory>/.data/tls`.

## What is created

| File | What | Lifetime |
|---|---|---|
| `ca.pem`, `ca-key.pem` | local CA, RSA 2048, `basicConstraints CA:true, pathlen 0`, keyCertSign | 10 years |
| `server.pem` (server certificate + CA chain), `server-key.pem` | server certificate, RSA 2048, serverAuth, SANs below | 397 days (never beyond the CA) |

SANs: this computer's hostname, `localhost`, `127.0.0.1`, `::1` and every interface address
(IPv6 link-local addresses are skipped: they need a zone id).

Certificates are built with `node-forge` (pure JavaScript; Node's crypto can create keys but not
X.509 certificates). Keys come from Node's `generateKeyPairSync`. Serial numbers are 127-bit random
positive integers in minimal DER form.

## Owner-only permissions

- POSIX: folder `0700`, every file `0600`.
- Windows: the folder and every file get a protected DACL (no inherited entries) granting full
  control to the user running Nigafiy, LocalSystem and the Administrators group only — the same set
  the engine uses for its control token — set with the built-in `icacls` tool. Files written later
  inherit the folder's restricted entries; files that already exist (or were copied in by hand) are
  tightened on every start.
- If permissions cannot be set, the function fails and HTTPS stays off rather than leave a private
  key readable by other users.

## Renewal

Checked at start and every 6 hours:

- server certificate missing, not issued by the CA, expiring within 30 days, or not covering every
  current hostname / address → a new server certificate is issued and loaded into the running
  listener (`setSecureContext`, no restart). **The pin does not change.**
- CA expiring within 365 days (about once in nine years) → a new CA and server certificate. **The
  pin changes**: a warning is logged and collectors / agents need the new pin.

## The pin

`GET /api/v1/system/tls` (any signed-in role; these are public facts — anyone on the network sees the
certificate) returns the mode, port, CA SHA-256 fingerprint, certificate dates and the names /
addresses covered. Shown in **Hub → Sensors** and **Settings** ("Encrypted connection (HTTPS)", EN +
AR) with ready-to-copy enrollment commands that include the pin:

```
NIGAFIY_SENSOR_SERVER_URL=https://<server>:<port> \
NIGAFIY_SENSOR_ENROLLMENT_TOKEN=<token> \
NIGAFIY_SENSOR_TLS_PIN_SHA256=<CA fingerprint> \
./lan-collector -config collector.yaml

endpoint-agent install -server https://<server>:<port> -token <token> -tls-pin <CA fingerprint>
```

The "Add collector" token dialog and the endpoint enrollment responses carry the same pin
(`tls_pin_sha256`) when the built-in TLS is serving.

Collector (`internal/cloud/client.go`) and endpoint agent (`internal/agent/agent.go`) accept a pin
that is either the SHA-256 of the leaf certificate (as before) or of a CA certificate in the
presented chain; in the second case the leaf must verify up to that CA (signature, validity,
serverAuth) with the pinned certificate as the only root. Host names are not checked: the pin alone
identifies the server.

## Verified

- `apps/api/tests/lan-tls.test.ts`: CA + leaf creation, SANs, chain, owner-only permissions (POSIX
  modes, or the Windows DACL read back with `icacls`), re-tightening a widened key file, restart
  keeps everything, re-issue on address change / near expiry with the same pin, CA replacement near
  its expiry, re-issue of a leaf from another CA, minimal-DER serials, a real HTTPS server accepted by
  a client trusting only the local CA (by name and by IP) and refused otherwise, and
  `GET /system/tls` roles.
- `collectors/lan-collector/internal/cloud/pin_chain_test.go`, `pin_node_chain_test.go` and the same
  pair in `agents/endpoint-agent/internal/agent/`: CA pin, leaf pin, wrong pin, expired leaf, wrong
  usage; the `pin_node_chain_test.go` fixture is a chain written by the API itself (public
  certificates only, no key).
- Smoke run on this Windows machine (2026-11-22, loopback only): the API started with
  `HTTPS_PORT` and no certificate files, created the CA, served HTTPS; the collector's pinned client
  completed a TLS handshake with the CA pin and refused a wrong pin; `icacls` showed only the user,
  SYSTEM and Administrators on `server-key.pem`.

## Not verified

- Not run with a collector or agent on another computer over a real LAN, and not on Linux / macOS
  hosts (the POSIX permission path is covered by the test only when the suite runs there).
- Browsers will warn about the local CA unless you import `ca.pem` into the browser / OS trust store;
  Nigafiy does not install it anywhere (no system changes).
