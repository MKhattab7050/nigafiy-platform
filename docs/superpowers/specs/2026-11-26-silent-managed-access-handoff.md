# Silent access on managed devices — handoff (design only, 2026-11-26)

Owner decision, recorded in the docs. **Not implemented yet** — this file is the start point. When the
owner says "continue" (كمل), begin from "Implementation steps" below.

## What the owner wants

IT administration of **company-managed devices** should work like a real internal IT tool: the operator
connects and does what they need **without asking the person every time** and, on computers, **without a
banner the person notices**. The everyday background admin (patches, installs, scripts, inventory, services)
is already silent and stays that way. The change is only about the *live* screen view / control experience
and the per-session consent.

The legitimacy basis is: these are **company-owned, enrolled** devices covered by a one-time monitoring
policy accepted at enrollment. That one-time consent replaces the per-session prompt. The **server-side
audit log stays on in every mode** (it is for the organization, not an interruption for the user). There is
**no stealth of the management itself**: the device still runs the agent and (on Android) the OS indicators.

## Already updated in the docs (the target model)

1. **Android — no per-session consent on managed phones.** [features/android.md](../../features/android.md)
   §2 "Access model for phones": a phone follows the Fleet group access policy like a computer. Unattended
   (no per-session prompt) is allowed **only on a Device Owner / managed phone**. Regular-app phones stay
   attended — Android itself forces the MediaProjection dialog and the accessibility switch; no app can
   remove them. The "Managed by Nigafiy" notification and Android's cast indicator always stay on.
2. **Computers — banner configurable per group.** [features/fleet-pro.md](../../features/fleet-pro.md)
   "Consent and the session banner": `fleet_groups.banner_mode` = `shown` (default) / `minimized` / `off`.
   `off` = no on-screen banner, operator connects/views/controls without interrupting the signed-in user;
   accepted **only** with `access_mode = unattended` on a managed endpoint; refused for attended, Quick
   Support and help-request sessions. Audit log written in every mode.

## Implementation steps (when continuing)

**Owner, later on 2026-11-26: "everything silent"** — silent became the default (migration 052:
new groups unattended + off, existing unattended groups off, no-group unattended computers off,
remote shells follow the group). Attended groups, help requests, Quick Support and phones still show
the full banner.

**Progress 2026-11-26:** the computer part (`banner_mode`) is built and tested (migration 051; see
fleet-pro.md "Consent and the session banner" for what was decided while building it: a refuse window
also forces the full banner, and `off` skips the start/end notices). Not yet seen on a real screen.
The phone part is not started: it needs a Device Owner phone to verify the MediaProjection path.

Computers (`banner_mode`):
- [x] Migration: add `fleet_groups.banner_mode text` (check in `shown|minimized|off`, default `shown`).
- [x] API validation: refuse `banner_mode = off` unless `access_mode = unattended`; always force `shown`
      for Quick Support and help-request sessions regardless of group.
- [x] Session start: snapshot `banner_mode` onto `fleet_sessions`; send it to the agent in the
      `rd_session_open` payload.
- [x] Agent (`agents/endpoint-agent`): the session helper honours `banner_mode` — draw the full bar for
      `shown`, a tray/status indicator for `minimized`, nothing for `off`. Keep the End-session path alive
      internally so Fleet can still end it.
- [x] Audit: record `banner_mode` on `fleet.session_opened` / `fleet.session_banner`.
- [x] UI: group editor control for `banner_mode`, disabled unless the group is unattended, with a one-line
      note on what `off` means and that it is for company-owned managed machines.
- [x] Tests: API refusal matrix (off+attended refused, off+unattended ok, Quick Support forced shown),
      and an agent test that `off` draws no bar but the session still ends from Fleet.

Phones (managed/unattended):
- [ ] Let a Device Owner endpoint's group run `unattended`: skip the per-session accept flow and open the
      stream directly. Regular-app phones keep the current attended flow unchanged.
- [ ] Pre-grant / suppress the per-session MediaProjection dialog on Device Owner only (verify the exact
      API path on a real managed device before relying on it; fall back to attended if the platform build
      cannot suppress it, and say so in the web). Accessibility service enabled via the Device Owner path.
- [ ] Keep the persistent "Managed by Nigafiy" notification and the OS cast indicator — never attempt to
      hide them. Audit every session and input as today.

## Hard rules (do not cross)

- `off` / unattended is for **company-owned managed** endpoints only. Never offer it for Quick Support,
  help requests, or any un-enrolled / BYOD device.
- The **audit log is never disabled** by any banner or consent setting.
- **No stealth of the agent itself** and **no hiding of Android's OS indicators**. The goal is "the user is
  not interrupted each time," not "the user can never know the device is managed."
- Do not add keylogging, message/window-content reading, or any capture beyond the existing screen frames.
