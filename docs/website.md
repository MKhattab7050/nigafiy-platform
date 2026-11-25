# The Nigafiy website (`apps/site`)

A static Next.js site in English and Arabic, in the visual language of the programs (spec
`docs/superpowers/specs/2026-11-21-nigafiy-platform-design.md` §7–8, approved mockup
`docs/design/mockups/Site.dc.html`). `next build` with `output: 'export'` writes plain files to
`apps/site/out/`: no server, no API routes, no accounts, licences, payments, analytics, trackers,
cookies or third-party scripts. Fonts (IBM Plex Sans and IBM Plex Sans Arabic, SIL OFL 1.1, licence
files next to them) are committed under `apps/site/public/fonts`.

**Nothing is deployed.** The domain, the hosting and the download host are owner decisions that have
not been made; no workflow publishes the site.

## Pages

Every page exists as `/en/...` and `/ar/...` (`dir="rtl"`); `/` offers both languages; the switch in
the header opens the same page in the other language. Light and dark follow the system; the header's
System / Light / Dark switch overrides it (kept in this browser's `localStorage` only).

| Page | Source |
| --- | --- |
| Home | `app/[lang]/page.tsx`, following Site.dc.html: hero with a real Hub screenshot, the three promises (plus "what has run on real hardware"), the program family, the Agent and Sensor, the bundle picker teaser, no AI |
| One page per program (Hub, Radar, Watch, Guard, Fleet, Mind, Toolbox) plus Agent and Sensor | `lib/content/programs.ts`: what it does (from `docs/features/capabilities.md` and the status tables), what it needs, **"Not verified on real hardware"** notes copied from `docs/roadmap/status.md`, real screenshots, links to the docs |
| Downloads | `app/[lang]/downloads/page.tsx`, from the release file only (below). The full bundle (NSIS and MSI), each program (= the Hub installer with its `PROGRAMS` option), the Agent (Windows installer, Linux, macOS, Android APK), the Sensor (`nigafiy-engine`, run as `nigafiy-engine sensor`), the Microsoft Store as "coming", how to check a SHA-256 |
| Build your bundle | `components/bundle-picker.tsx` + `lib/bundle.ts`: tick programs → the installer page choice, the silent NSIS command (`/PROGRAMS=`) and the MSI command (`PROGRAMS=`). The installers (`apps/desktop/installer/nigafiy.nsh`, `apps/desktop/scripts/msi-programs.cjs`) support exactly this; they do not build a separate file per choice, and the page says so. No download button before a release |
| Docs | `lib/docs.ts`: `docs/getting-started.md`, `docs/features/*`, `docs/operations/*`, `docs/security/*`, rendered at build time; the in-app user guide (`apps/web/features/guide/content/{en,ar}.ts`) in both languages; sidebar; search in the browser over `/<lang>/docs/search-index.json`, written at build time. On the Arabic site the guide is Arabic and every other doc is marked "English only" |
| Changelog | `content/changelog.json`, written from `git log --no-merges` (commit subjects, no author names) by `pnpm --filter @nigafiy/site changelog`; the page names the branch and commit it came from |
| Security and privacy | A short privacy summary (EN/AR) and `docs/security/model.md` |
| Release manifest | How Hub verifies an update (Ed25519 manifest, HTTPS, SHA-256, publisher, admin confirmation), the payload format, and a link to the manifest **only when the release file names one** (`manifest_url`) |
| 404, sitemap, robots, icons | `app/global-not-found.tsx` (English and Arabic on one page, served as `404.html`), `app/sitemap.ts`, `app/robots.ts`, `public/icon.svg` and `public/favicon.ico` (copied from `packages/brand` by `scripts/copy-brand-icons.ts` before every build and unit test run, not committed), `public/og.png` (`pnpm --filter @nigafiy/site og`, drawn from the brand paths) |

Docs rendering is safe: markdown-it with `html: false` escapes any raw HTML, its link validator refuses
`javascript:`/`data:`/`vbscript:`, links to another published doc go to its page (anchors use GitHub's
rules), `http(s)`/`mailto` stay, and links to source files or unpublished docs (plans, specs, roadmap,
architecture) become plain text, so no link goes nowhere. Internal links are plain `<a>` elements
(full page loads), which every static host serves without rewrite rules.

## Build, preview, test

```
pnpm install
pnpm build:site                                  # → apps/site/out
pnpm --filter @nigafiy/site serve                # http://127.0.0.1:3290/ (scripts/serve.ts, loopback)
pnpm test:site                                   # build, unit tests, fixture build, browser tests
pnpm --filter @nigafiy/site dev                  # next dev on port 3291
```

| Variable | Meaning |
| --- | --- |
| `NIGAFIY_SITE_URL` | The site's own address, for `sitemap.xml`, `robots.txt` and Open Graph. **Set it when building for the real host.** Unset: `http://127.0.0.1:3290` (the local preview), so nothing points at a domain that does not exist |
| `NIGAFIY_SITE_RELEASE` | Another release file instead of `apps/site/release/release.json` (the tests use `tests/fixtures/release.json`) |
| `SITE_DIST_DIR` | Another output folder (the fixture build uses `out-fixture`) |

`pnpm test:site` runs:

- **Unit tests** (`tests/unit`, `node --test`, 58): the release schema and every refusal,
  `release:from-dist` on real temporary files (size and SHA-256 recomputed, CLI exit codes), the bundle
  picker against the installer sources, the docs pipeline (what is published, escaping, link
  rewriting, every link and anchor of every doc), search in both languages, EN/AR completeness of every
  string, brand files and fonts, contrast of every colour pair in both themes and of white text on
  every filled button.
- **Browser tests** (`e2e/site.spec.ts`, Playwright with the installed Microsoft Edge, 16): the export
  served by `scripts/serve.ts` on port 3290 (and the fixture build on 3294); a crawl of every internal
  link, anchor and image of both builds; every page in English (light) and Arabic (dark, RTL) with
  `lang`/`dir`/theme, one `<h1>` and no console error, failed request or 4xx; the Downloads page with
  no release ("Not released yet" everywhere, no links, sizes or hashes) and with the fixture release;
  the bundle picker by mouse and keyboard; the skip link and a visible focus ring on every control
  reached with Tab; the theme and language switches; screenshots load; docs search; the 404 page with
  status 404; sitemap and robots; no third-party request and no cookie; no sideways scrolling at 375 px.

## The release file

`apps/site/release/release.json` (not committed today: nothing has been released). Its shape is the
update manifest's payload (`docs/operations/updates.md`, "Manifest"), with more component ids and an
optional `manifest_url`; `lib/release.ts` validates it with Zod and an invalid file fails the build.

```jsonc
{
  "schema": 1,
  "product": "nigafiy",
  "version": "1.2.3",
  "released_at": "2026-12-01T10:00:00.000Z",
  "notes_url": "https://…",            // optional
  "manifest_url": "https://…/manifest.json",  // optional: the signed update manifest of this release
  "components": [
    { "id": "desktop-windows-x64", "version": "1.2.3", "url": "https://<download host>/1.2.3/Nigafiy%20Setup%201.2.3.exe", "size": 123456789, "sha256": "<64 lower-case hex>" }
  ]
}
```

| Component id | File name `release:from-dist` recognises |
| --- | --- |
| `desktop-windows-x64` | `Nigafiy Setup <v>.exe` |
| `desktop-msi-windows-x64` | `Nigafiy <v>.msi` |
| `endpoint-agent-windows-x64` | `Nigafiy-Endpoint-Agent-Setup-<v>.exe` |
| `endpoint-agent-linux-x64` / `-linux-arm64` | `nigafiy-agent-linux-amd64` (or `-x64`) / `nigafiy-agent-linux-arm64` |
| `endpoint-agent-macos-x64` / `-macos-arm64` | `nigafiy-agent-darwin-amd64` / `nigafiy-agent-darwin-arm64` (`macos` also accepted) |
| `android-agent-apk` | `nigafiy-agent*.apk` or `app-release.apk` |
| `sensor-windows-x64` / `sensor-linux-x64` | `nigafiy-engine.exe` (or `nigafiy-engine-windows-amd64.exe`) / `nigafiy-engine-linux-amd64` |

Every URL must be `https://`, every id may appear once, unknown fields are refused. A component that
is missing reads "Not released yet"; a missing file means nothing is released.

Write it from the files of a built release (size and SHA-256 are computed from the files):

```
pnpm --filter @nigafiy/site release:from-dist ..\..\dist\release\1.2.3 --base-url https://<download host>/1.2.3/ --manifest-url https://<download host>/manifest.json
```

Other options: `--version`, `--out`, `--released-at`, `--notes-url`. `SHA256SUMS`, `manifest.json`,
`.msix` and other files are listed as skipped. Then build the site again.

## Screenshots

Only screenshots of the real running program: `pnpm --filter @nigafiy/site screenshots`
(`screenshots/playwright.config.ts`, `screenshots/capture.spec.ts`). It reuses the web app's
browser-test harness unchanged (`apps/web/e2e/global-setup.ts`: a throw-away PostgreSQL on port 5445
and the real API on 3292; `apps/web/e2e/seed.ts`: records created through the real API and the real
Sensor and Agent protocols), builds the web app into `apps/web/.next-site-shots`, starts it on 3293 with
every program installed, signs up, and captures 17 screens in English (light) and Arabic (dark, RTL),
1440×900, into `public/screenshots/{en,ar}/`. The data is the seeded test data (an `e2e-sensor`, an
outage incident, `E2E-PC-01`, `E2E-Phone-01`, …): nothing is drawn by hand and no network is scanned.
The file names are listed in `lib/content/programs.ts`; a unit test checks that the capture script and
the pages agree, and a page leaves out a screenshot that is missing.

## Run for real versus tests only (2026-11-25)

- **Ran for real here:** the static build; the export served on 127.0.0.1:3290 and walked in the
  browser (Edge) by the browser tests and by hand in English/light, Arabic/dark and at phone width; the
  screenshot capture against the real API, web app and a throw-away PostgreSQL (34 PNGs);
  `release:from-dist` and the release schema on temporary files.
- **Not done:** no deployment, no real domain (the sitemap and robots point at the local preview
  address until `NIGAFIY_SITE_URL` is set), no real release file (no release exists), no screen
  reader pass (landmarks, labels, focus and contrast are covered by the tests above, not by a person
  with assistive technology), no browser other than Edge.

## Owner decisions still needed

- The domain (then build with `NIGAFIY_SITE_URL`).
- Where the site is hosted (any static host works: it is plain files, with `404.html`).
- The download host for release files (and the manifest URL the installs use).
- Publishing a first signed release, then `release:from-dist` and a rebuild.
- The Microsoft Store listing (`docs/operations/microsoft-store.md`): the page says "coming" until then.
