# Android remote controls: handoff (stopped 2026-11-25)

Paused at the owner's request ("save its progress and stop; when I say continue, continue from the same point"). The work is
committed as work in progress. **The Android app does not build at this commit** (see "State").

## Owner decision 2026-11-26: no per-session consent on managed phones

The owner rejected the per-session consent message for devices under IT management. A phone must follow the
**Fleet group access policy**, the same as a computer: *unattended* (admin connects with **no per-session
prompt**) is allowed on a **Device Owner (managed/enrolled)** phone, where the management relationship is the
one-time consent. **Regular-app** phones stay attended — Android itself forces the MediaProjection dialog and
the accessibility switch each session, and no app can remove them. The "Managed by Nigafiy" notification and
Android's cast indicator always stay on (no stealth). Target model is in [android.md](../../features/android.md)
§2 "Access model for phones". The original per-session scope below is kept for the record.

## What the owner asked for

After enrolling their real Samsung A36 (Android 16, regular app mode, not Device Owner) into the
installed Nigafiy app, the owner said many controls are missing: seeing the screen, the folders,
and more controls. Agreed scope, all for **regular app mode** and all visible on the phone:

1. **Screen view** with MediaProjection. Android's own consent dialog every session, and its cast indicator.
   Flow: operator clicks "View screen" in Fleet → command → the phone asks the person
   (notification / ShareRequestActivity) → system consent → foreground service (type
   mediaProjection) captures JPEG frames → server. Either side can stop it. A refusal is shown in the web.
2. **Remote touch control** (optional) through an AccessibilityService that the person turns on in
   Settings → Accessibility. Gestures and Back/Home/Recents are allowed only during a screen session the
   person accepted, with a visible "being controlled" indicator. It never reads window content and never logs keystrokes.
3. **File manager** for shared storage (roots, list, download, upload, mkdir, rename, delete). It needs
   "All files access" (MANAGE_EXTERNAL_STORAGE), which the person grants in Settings. Paths are confined to shared storage.
4. **Ring the phone** (~30 s, can be stopped) and **show a message** (high-priority notification, plain text, length-limited).

Rules: transparent only (no stealth, no keylogging, no reading messages or window text). The web shows an
action only when the phone reported that capability, and the API checks it again. Every action gets a role check,
an audit log entry and tests. EN + AR with RTL. Update the app's `what_is_sent` disclosure truthfully.
Lock, wipe, camera and silent install still need Device Owner (factory reset), and they are not part of this work.

## State at the stop

Done (the JVM `core` module, **41 tests passing**):
- `core/.../PhoneControls.kt`: `PhoneFeatures` (screen, control, files, ring, message; files on API 30+),
  the screen-session request, input events → gestures, and frame metadata for the Remote Desktop HTTP frame path.
- `core/.../SharedStorage.kt`: confined shared-storage paths for the file manager.
- `core/.../Commands.kt`, `Protocol.kt`, `Gateway.kt`: the new command kinds and transport additions.
- `core/src/test/.../PhoneControlsTest.kt`.

Partly written (the `app` module, **does not compile yet**):
- `ScreenShare.kt` (session coordinator), `ScreenCaptureService.kt`, `ShareRequestActivity.kt`,
  `ControlService.kt` (accessibility), `Notices.kt` (ring and message notifications), plus `Executor.kt` wiring.
- Missing: string resources (EN + AR) for `channel_requests/sharing/messages/ring`, `message_from_it`,
  `ring_text/title/stop`, `sharing_text`, `sharing_text_control`, `sharing_title`,
  `controlling_title`, `controlling_bar`, `sharing_stop` and the rest. Also missing: manifest entries (services, the activity, the
  accessibility service XML config, FOREGROUND_SERVICE_MEDIA_PROJECTION, MANAGE_EXTERNAL_STORAGE) and the
  status-screen buttons (All files access, Accessibility settings). Check with `node scripts/android/build.mjs`.

Not started:
- API: accept these commands for Android endpoints in regular mode, consent pending/refused
  states, frames into the existing remote-desktop session/frame machinery
  (`apps/api/src/modules/endpoints/remote-desktop/*`), the file manager through the existing guards
  (`file-manager/*`), ring and message actions (`fleet-android/actions.ts`), audit, tests.
- Web: show View screen / Files / Ring / Message on Android endpoints by the reported capability, and reuse the
  Windows remote-desktop viewer and file manager. EN + AR.
- `docs/features/android.md`: the §2 table, a new section, and an honest "what ran" in §10.
- An emulator run (`scripts/android-emu/*`), then install on the owner's phone (`adb -s RZCY70HMAYY install -r`)
  and walk the owner through granting All files access and Accessibility.

## How to resume

Re-read this file, read the files listed above as they are now, then finish in this order: app module
strings + manifest → build passes → API → web → docs → emulator → owner's phone. Do not touch the
installed app or its data while building. Do not run `scripts/local.mjs` together with the installed app.
