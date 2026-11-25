# Real-hardware test checklist (for the owner)

Everything below is built and passes its automated tests, but has **never run on real hardware**
(see "Real hardware versus tests only" in [`docs/roadmap/status.md`](../roadmap/status.md)).
Only you can run these, on your own network and devices. Do them in any order; each block says what
you need.

How to use it:

- Tick the box when the result matches **Expect**. If it does not, write down what you saw (a
  screenshot of the page and the time is enough) and send it to me; I fix it and add a test.
- Use your own network only. Router and switch tests change real settings: do them when a short
  interruption is fine, and keep each change's **Undo** at hand (the app shows it after every change).
- Health: **Hub → System self-check** shows which parts are running.

---

## A. One PC, no extra hardware (start here)

- [ ] **A1. Engine as a Windows service.** Administrator PowerShell, in the installed app's
  `resources\engine` folder: `.\nigafiy-engine.exe install`, then `.\nigafiy-engine.exe start`,
  then `.\nigafiy-engine.exe status`. Restart the PC.
  **Expect:** `sc qc NigafiyEngine` shows the service; after the restart Hub opens with the engine
  "running" without starting the app first. Details: [`docs/desktop/engine.md`](../desktop/engine.md).
- [ ] **A2. Agent as a LocalSystem service with the session helper.** Install the Windows agent
  elevated (see [`docs/features/fleet-pro.md`](../features/fleet-pro.md), agent install), enroll it.
  **Expect:** the endpoint shows online in Fleet; remote desktop of your own signed-in session works
  and the session bar is visible on your screen.
- [ ] **A3. Windows user-session switching.** With two Windows users signed in (fast user switching),
  open remote desktop and switch between the sessions from the session list.
  **Expect:** each switch shows the right user's desktop (this was fixed blind; never seen working).
- [ ] **A4. MSI upgrade.** Install `Nigafiy 0.1.0.msi`, then install a newer build over it.
  **Expect:** one entry in Programs, your data and settings kept.
- [ ] **A5. Upgrade over an old LAN Detective install** (only if you still have one).
  **Expect:** devices, history and settings are still there after the upgrade.
- [ ] **A6. Backup and restore with real PostgreSQL tools.** Install the PostgreSQL 17 client tools,
  then follow [`backup-restore-and-key-rotation.md`](backup-restore-and-key-rotation.md):
  `db:backup`, then `db:restore` of that file.
  **Expect:** after restore everything is as at backup time.
- [ ] **A7. Notifications.** Add one real channel (Telegram, Slack, Discord or ntfy) in
  **Watch → Notifications** and press **Send test**.
  **Expect:** the message arrives on your phone/app.
- [ ] **A8. Updates.** Only after you decide where releases are hosted (see "Your decisions" below).
- [ ] **A9. Clicking through Fleet actions on a live agent** (your own PC as the endpoint): files,
  processes, shell, script job, chat, recording, end hotkey.
  **Expect:** every action works and appears in the audit log; nothing typed appears there.
- [ ] **A10. A real Windows Update install and restart from Fleet**, inside a maintenance window.
  **Expect:** the update installs, the restart prompt appears to the user, the job shows done.

## B. Two computers on the same network

- [ ] **B1. Remote desktop from another PC.** Agent on PC 2, open the console on PC 1.
  **Expect:** consent dialog on PC 2; video, mouse, keyboard, clipboard work; with two monitors on
  PC 2 you can pick each one.
- [ ] **B2. WebRTC video.** Same as B1 with WebRTC on (default).
  **Expect:** the session info says WebRTC and video is smooth; with `RD_WEBRTC=off` it falls back to
  images and still works.
- [ ] **B3. LAN HTTPS with fingerprint pinning.** Follow [`lan-tls.md`](../features/lan-tls.md): open
  the console from PC 2 through the LAN address, install the agent on PC 2 with `-tls-pin`.
  **Expect:** the browser shows the pinned certificate; the agent connects; a wrong pin is refused.
- [ ] **B4. Quick Support from a real Fleet link.** Send the Quick Support link to PC 2, run the
  downloaded exe. **Expect:** the session code works and the session ends cleanly.
- [ ] **B5. Wake-on-LAN.** Turn PC 2 off (WoL enabled in its BIOS), press **Wake** in Fleet.
  **Expect:** PC 2 powers on.

## C. Phone (Android)

- [ ] **C1. Standard enrollment.** Install the signed APK (`app-release.apk`), scan the enrollment QR
  from Fleet. **Expect:** the phone appears in Fleet with battery, network and patch level.
- [ ] **C2. Device Owner** on a phone with **no accounts** (spare or factory-reset): follow
  [`android.md`](../features/android.md) (adb `dpm set-device-owner` or the provisioning QR).
  **Expect:** lock, camera off, screen-lock requirement, app install/remove all work and are audited.
  Do **not** test "Erase" on a phone you care about.
- [ ] **C3. mDNS/SSDP names.** With the phone on Wi-Fi, run a scan.
  **Expect:** the phone shows a name instead of only a MAC (no phone answered so far).

## D. Your router (Zyxel VMG3625-T50B)

- [ ] **D1. Reboot from Nigafiy.** **Guard → Routers → Reboot.** **Expect:** the router restarts and
  Nigafiy reconnects by itself. (Everything else on this router already ran for real.)
- [ ] **D2. DNS access control on real devices.** Point the router's DHCP DNS to the Nigafiy PC as in
  the in-app guide (**Guard → Access**, help button), block one site for one
  device. **Expect:** that device cannot open the site; others can. Undo by restoring the DHCP DNS.

## E. Other hardware (only if you have it or can borrow it)

- [ ] **E1. Another router brand** (Huawei, ZTE, TP-Link, Tenda, D-Link, ASUS, MikroTik, UniFi,
  Omada, OpenWrt, OPNsense, pfSense, FortiGate, Cisco IOS XE). Add it in **Guard → Routers**, then
  read settings, block/unblock one device, reserve an address. **Expect:** each works and Undo
  restores it. Note the exact model and firmware.
- [ ] **E2. Managed switch with SNMP.** Add it in **Port Detective**. **Expect:** ports, MACs per port,
  VLANs and CDP/LLDP/MNDP neighbours appear; a port disable/enable works and reads back.
  Also add one **SNMP-OID check** in Watch on it.
- [ ] **E3. Config backup** on a Juniper, Cisco IOS XE, VyOS/EdgeOS or OpenWrt device.
  **Expect:** backup saved with secrets redacted; restore puts it back.
- [ ] **E4. SSO** with your real identity provider (Entra ID, Google, Okta, Keycloak…): follow
  [`sso.md`](../features/sso.md). **Expect:** sign-in works; the owner account cannot be locked out.
- [ ] **E5. Linux and macOS agents.** Install on one machine each.
  **Expect:** inventory, compliance, shell and remote desktop work; updates list (apt/dnf/softwareupdate).
- [ ] **E6. IPv6 network.** On a network with IPv6, scan. **Expect:** IPv6 addresses appear on devices.
- [ ] **E7. Sensor on a second site** (`nigafiy-sensor` on another PC or a Linux box).
  **Expect:** that site's devices appear under its own site in Hub.

## F. A real fault

- [ ] **F1. Unplug the internet** (router WAN cable) for two minutes, then plug it back.
  **Expect:** an incident opens, Doctor gives a diagnosis that names the internet link, Time Machine
  shows the moment, the incident closes by itself after it recovers.

---

## Your decisions still open

- Where the website and downloads are hosted (domain, host, GitHub Releases or other). Needed for A8
  and for publishing a first release.
- The update signing key: create it on your release PC as in [`updates.md`](updates.md).
- Microsoft Store upload: **last step**, from your Partner Center account
  ([`microsoft-store.md`](microsoft-store.md)).

When you finish a block, tell me which boxes passed and send what failed; I update `status.md`.
