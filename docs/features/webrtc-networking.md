# WebRTC remote desktop: networking

How the WebRTC picture of a remote desktop session travels, what the network must allow, and what
ran for real. The design and the signalling are in `fleet-pro.md` ("WebRTC video"). This page is
about addresses, ports and firewalls.

## 1. The path

- **Signalling** (offer, answer, candidates) goes over the sockets that already exist: the operator's
  browser to the Nigafiy API, and the agent to the Nigafiy API. No new port on the server.
- **Media and input** go **directly between the operator's browser and the agent's computer**, over
  UDP: one peer connection carries the H.264 video (agent to browser) and the `input` data channel
  (browser to agent). Both are encrypted with DTLS-SRTP / DTLS-SCTP by WebRTC itself.
- **If no direct UDP path exists**, the console falls back to the JPEG picture over the API socket
  (the path from before WebRTC). Nothing breaks; the picture is just less smooth. The bar then shows
  "Compatibility mode (JPEG)" and the reason.

## 2. ICE candidates

| Side | Candidates it offers |
| --- | --- |
| Agent (pion, `internal/rdstream/webrtc.go`) | **host** candidates on UDP over IPv4 and IPv6 (`SetNetworkTypes(UDP4, UDP6)`), one per network interface. Loopback is excluded (pion's default). TCP candidates are not offered. A **server-reflexive** (srflx) candidate only when a STUN URL is configured. |
| Browser (Chromium / Edge) | **host** candidates, hidden behind an mDNS name (`<random>.local`) as browsers do by default; srflx only with STUN. |

- **No TURN.** There is no relay candidate on either side, and the product does not offer one.
- **STUN is optional and off by default.** An administrator may set `RD_WEBRTC_STUN_URLS` on the
  API (`stun:` or `stuns:` URLs only, at most 4, empty by default). The API hands the list to the
  browser and to the agent. On one LAN it is not needed. STUN only helps when the two sides are on
  different subnets behind simple (non-symmetric) NAT. It also sends each side's address to the STUN
  server, so leave it empty unless you need it.
- **Ports are not fixed.** pion picks a random UDP port per session on the agent, and the browser
  does the same. No port range is configured, so a firewall rule must allow the **program**, not a
  port range.
- **mDNS.** The browser's host candidate is a `.local` name. pion resolves it with multicast DNS
  (UDP 5353 to 224.0.0.251 / ff02::fb), so mDNS must work between the two computers. If it does
  not, the connection can still form when the browser's connectivity checks reach the agent (the
  agent then learns the browser's address as a peer-reflexive candidate). That needs the agent's
  firewall to accept the inbound UDP (see §4).

## 3. What is supported and what is not

| Situation | WebRTC video? |
| --- | --- |
| Browser and agent on the same LAN / subnet | Yes (host candidates). This is the target. |
| Different subnets routed inside one site, no NAT between them, UDP allowed | Yes (host candidates are routable). |
| Different sites behind simple NAT, with a STUN URL set and UDP allowed both ways | Maybe (srflx). Not tested. |
| **Across the internet, through symmetric NAT or carrier-grade NAT, or where UDP is blocked** | **No.** The session falls back to JPEG through the API. |
| The API reachable but the agent's UDP blocked | No; JPEG fallback after the 10 s video timer or when ICE fails. |
| `RD_WEBRTC=off` on the API | No. Every viewer uses JPEG (the agent is never asked for an offer). |

## 4. Firewall on a LAN

Nothing on the Nigafiy server changes: it keeps its web and API ports (3100 and 4100 by default, or
the HTTPS port with LAN TLS). Between the **operator's computer** and the **agent's computer**:

- **UDP both ways, any port (1024–65535)**, between the two addresses. In practice:
  - On the **agent's computer** (Windows Defender Firewall), an inbound rule that allows UDP for
    `nigafiy-agent.exe` (Private profile, local subnet only). Windows' stateful firewall lets the
    replies to the agent's own outgoing checks through, so this sometimes works without a rule. A
    rule makes it reliable, because the browser's checks can arrive first. When the agent runs as a
    service, Windows does not ask for this rule, so it must be added on purpose.
  - On the **operator's computer**, the browser's outgoing UDP is normally allowed. The replies come
    back through the same stateful firewall.
- **UDP 5353 multicast (mDNS)** on the LAN, so the agent can resolve the browser's `.local`
  candidate. This is optional if the inbound rule above exists.
- **Network devices.** Wi-Fi "client isolation" (common on guest networks) and VLAN ACLs that drop
  UDP between the two computers block the direct path. Then the session uses JPEG.

Nigafiy never changes firewall rules itself. These are owner or administrator steps.

## 5. Owner steps: two computers on a LAN

Computer **A** runs the Nigafiy server, and its browser is the operator's console (the browser can
also be on a third computer). Computer **B** is the Windows computer to support.

1. On A, start Nigafiy listening on the LAN (LAN TLS: `HTTPS_PORT` with `HTTPS_HOST=0.0.0.0`, see
   `lan-tls.md`). Note A's LAN address, for example `192.168.1.10`.
2. In Fleet → Managed computers → Enroll endpoint, create a Windows enrollment token.
3. On B, install the agent pointing at A:
   `nigafiy-agent.exe install -server https://192.168.1.10:<HTTPS_PORT> -token <token>`
   (as in `fleet-pro.md`). Wait until B shows online in Fleet.
4. On B, allow UDP for the agent: Windows Security → Firewall & network protection → Allow an app
   through firewall → add `nigafiy-agent.exe`, Private network only. Make sure B's network is set to
   **Private**, not Public.
5. On A, open the endpoint B → Remote desktop → Start session, give a reason, and (for an attended
   profile) accept on B.
6. Check the bar: it must say **"WebRTC video"**, with fps and kb/s. If it says
   **"Compatibility mode (JPEG)"**, the reason next to it says why (for example "no direct network
   path to the viewer"). Then check step 4, Wi-Fi client isolation, and that both are on the same
   subnet.
7. Move the mouse over the picture and type in a text box on B. Both must act on B. Clicks and keys
   are audited as `endpoint.rd_input` with `via: webrtc`.
8. To compare, set `RD_WEBRTC=off` on A's API and restart it. The same session must work as
   "Compatibility mode (JPEG)".
9. Optional: in chrome://webrtc-internals (Edge: edge://webrtc-internals), the selected candidate
   pair should be `host`/`host` (or `prflx`) over UDP with B's LAN address.

## 6. What TURN would need (owner decision, not built)

Sessions across the internet or through symmetric NAT need a relay. Building one means:

- **A TURN server** reachable by both sides, for example pion/turn inside the engine or a separate
  coturn. It listens on UDP/TCP 3478, and ideally on TLS 443 for networks that only allow HTTPS.
  That means a public address, its hosting and its bandwidth (every relayed session's full video
  goes through it).
- **Short-lived credentials** that the API mints per session (the TURN REST API pattern: an
  HMAC-SHA1 of a user name with an expiry, from a shared secret). They must never be configured
  statically in browsers or agents.
- **Code changes:** accept `turn:`/`turns:` in the ICE server list (today the API's schema allows
  `stun:`/`stuns:` only), hand each side its credentials, and show "relay" as the route on the bar.
  It also needs audit rows for relayed sessions, an option to force relay or forbid it, and tests.
- **Privacy:** the relay cannot see the picture (DTLS-SRTP is end to end), but it sees who talks to
  whom, when, and how much. That conflicts with the "LAN first, no third machine" rule, which is
  why it is the owner's decision. Until then, the JPEG path through the API is how a session works
  where WebRTC cannot.

## 7. What ran for real (2026-11-25, builder EMU)

All on one Windows 11 PC, no elevation, no firewall or registry change:

- **The real Windows agent**, built from this repository, ran in the foreground against a local
  API on 127.0.0.1 (throwaway PostgreSQL). A **real Chromium** (Playwright's build, Chromium 159,
  headless) drove the Fleet web console through `scripts/android-emu/webrtc-browser.mjs`.
- **WebRTC:** the console showed "WebRTC video". `getStats()` reported inbound H.264 at 1440x810,
  `framesDecoded` 75, then 110 three seconds later, 2 key frames decoded, 0 packets lost. The `input`
  data channel was open. The agent's banner was shown on the PC.
- **Input:** two pointer moves over the picture moved Windows' cursor to (461,346) and (922,475), where
  (461,345) and (922,474) were asked: within 1 px. This run found a bug. The 50 ms move throttle
  dropped the last move, so the remote pointer could stop short of where the operator's pointer
  rested. It is fixed in `pointer-throttle.ts` (trailing send) and covered by unit tests. The live
  re-run after the fix was inconclusive, because the PC's own mouse was in use at the same time.
- **Candidate pair:** `host` UDP on both sides. The agent's candidate was this PC's **own LAN
  interface address** (192.168.1.147), not 127.0.0.1, because pion leaves out loopback. The
  browser's was an mDNS name. Both ends were this one computer, so the packets never left it.
  However, the media went to a LAN-interface address, not loopback.
- **Fallback:** with `RD_WEBRTC=off` on the API, the page created no `RTCPeerConnection`, and the
  picture came over the JPEG socket (canvas drawn, 14.8 fps, 429 kb/s, RTT 2 ms).
- **Not run:** Microsoft Edge. It was skipped to avoid more media over the LAN interface, and
  Chromium is the same engine. Also not run: any session between two computers, STUN, a firewall
  rule, mDNS between machines, and symmetric NAT. §4 and §5 describe what is expected there; none of
  it has been measured.

Re-run: start the stack (`node scripts/android-emu/stack.mjs --web`) and enroll the agent
(`node scripts/android-emu/fleet.mjs setup --platform windows`, then run the agent with the printed
token). Put the endpoint in an unattended group, then run
`node scripts/android-emu/webrtc-browser.mjs --endpoint <id>` (`--expect jpeg` against an API with
`RD_WEBRTC=off`). The input check moves this PC's real mouse; `--no-input` skips it.
