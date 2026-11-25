# In-app user guide (EN + AR)

Owner decision (2026-11-25): Nigafiy gets an in-app user guide in English and Arabic, before the
website. Nigafiy is free for now, so the guide has no licensing or billing text (a unit test checks).

## What the user sees

- **`/guide`** (Hub): a search box and every section, grouped as Start here, Common tasks, The
  programs, When something is wrong.
- **`/guide/<section>`**: one section, with "On this page" anchors, "Open in Nigafiy" links to the pages
  it talks about, and previous / next.
- **User guide** in the sidebar's account block, in every program.
- **Help button** (question mark) in the top bar of every signed-in page: a link to the section that
  explains the current page, `/guide/<section>#<anchor>`. Being a link, it is reachable with Tab,
  opens with Enter, and is announced as "Help for this page" / «مساعدة لهذه الصفحة».
- **Global search**: up to five guide sections under "User guide" (see global-search.md).
- Sections about a program that this installation does not offer (`GET /platform/programs`, the same
  answer the shell uses) carry the "Not installed" badge and, on the section page, the install note
  that leads to `/programs#<id>`. They stay readable.

Sections: getting started (first sign-in, layout, sites, roles), the seven programs (and how programs
are added, how Nigafiy is installed and updated: Microsoft Store, MSI by Group Policy, setup program),
first network scan, devices (discovered vs set by hand, approvals, tags as groups), adding a computer
to Fleet (agent, GPO silent install, Quick Support including the Store link), reaching the router
(wizard, families, control matrix from status.md, read vs change, safety rules), one section per
program (Hub, Radar, Watch, Guard, Fleet, Fleet Pro inside Fleet, Mind, Toolbox) and troubleshooting.

## How the content is stored

`apps/web/features/guide/`:

| File | What it holds |
| --- | --- |
| `types.ts` | `GUIDE_SECTION_IDS` (the sections in reading order) and the content shape: a section has `id`, `group`, `program` (or `null`), `title`, `summary`, `blocks`, optional `links`. Blocks are `h` (sub-heading with an anchor `id`), `p`, `steps`, `list`, `note` (`info` / `warn`) and `table`. |
| `content/en.ts`, `content/ar.ts` | One source per language: all sections as typed data. Text is plain; `backticks` mark a technical value (address, command, file name), shown in a `<bdi dir="ltr">` so it reads correctly inside Arabic. |
| `route-map.ts` | `GUIDE_ROUTES`: URL prefix → section (and optional anchor); the longest whole-segment prefix wins; `GUIDE_FALLBACK` (Getting started) when nothing matches. |
| `search.ts` | The client-side search (below). |
| `strings.ts` | The guide's own UI words (title, search, badges), merged into the i18n dictionary like every feature. |

Why typed data rather than MDX: no new dependency, the type checker and the parity test see every
block, and both languages are forced into the same structure. The content files have no runtime
imports, so `node --test` reads them directly.

Writing rules: describe what the code does today, check the code (or `docs/features/*`) before writing
a claim, never present a feature as working on real hardware when it has only met test doubles (say
so in a `warn` note), use the real page and button names (the Arabic guide uses the Arabic UI labels
in «»), keep "Nigafiy" and the program names in Latin letters in Arabic too. No AI is used anywhere.

## Search

`buildGuideIndex(display, others)` tokenizes every section (title, sub-headings, summary, body) in
the reader's language and in the other language. A section matches when one of its languages holds
every query word (prefix match, or substring for words of 3+ characters); the title weighs most. Hits
are shown in the reader's language, with a matching sentence as the snippet and the anchor of a
matching sub-heading. Arabic is normalized: diacritics and tatweel removed, أ إ آ ٱ → ا, ى → ي,
ة → ه, Arabic-Indic digits → 0–9, and a query word also matches after an attached ال / و / ب / ل / ف /
ك (so «راوتر» finds «الراوتر»). An English word finds the section on the Arabic page too.

## How to add a section

1. Add its id to `GUIDE_SECTION_IDS` in `types.ts`, where it belongs in reading order.
2. Add the section to `content/en.ts` **and** `content/ar.ts`, at the same position, with the same
   `group`, `program`, sub-heading ids, block kinds and counts (items, table rows and columns) and link
   targets.
3. If a page should open it, add or change an entry in `route-map.ts`.
4. Run `pnpm --filter @nigafiy/web test:unit`.

A new page under `app/(app)` needs an entry in `GUIDE_ROUTES` (or a deliberate entry in
`EXPLICIT_FALLBACK` in the test); the test fails until it has one.

## Tests

- **Unit** (`features/guide/guide.test.ts`, part of `test:unit`):
  - every `page.tsx` under `app/(app)` (read from disk, `[id]` segments filled with a sample) maps
    to a section, not the fallback, unless listed in `EXPLICIT_FALLBACK` (empty);
  - every route entry points at an existing section and an anchor that exists in both languages;
    longest-prefix, whole-segment and fallback behaviour;
  - parity: both languages hold exactly `GUIDE_SECTION_IDS` in order, and per section the same
    group, program, block shapes (kind, sub-heading id, list length, table size, note tone) and link
    targets; the Arabic titles are Arabic; backticks are balanced; anchors are unique; no licence or
    billing text;
  - search: Arabic normalization, English and Arabic queries, cross-language hits shown in the
    reader's language, the matching anchor.
- **Browser** (`e2e/smoke.spec.ts`): `/guide`, `/guide/routers` and `/guide/fleet-enroll` are in the
  walk of every page (EN light, AR RTL dark). A separate test reaches the help button with the
  keyboard on Devices (EN, light) and checks it opens the Devices section, checks the Discovery
  page's anchor, searches the guide, finds a guide hit in the global search, sees Mind marked "Not
  installed" (the e2e install leaves Mind out), then opens help on Routers in Arabic (RTL, dark) and
  searches with an English word on the Arabic page.

## Not done

- The content is not versioned per release; it describes this branch's code.
- Screenshots are not embedded in the guide (they would need refreshing on every UI change and would
  show one language or theme).
