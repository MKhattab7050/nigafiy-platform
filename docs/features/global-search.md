# Global search (Hub)

`GET /api/v1/search?q=…[&site_id=…]` — any signed-in role. One box in the Hub header searches
devices, endpoints, incidents, switches (`snmp_targets`), IPAM subnets, routers (`site_routers`)
and knowledge articles of the active organization (Row Level Security; viewers see published
knowledge only).

## What matches

| Kind | Matched on |
|---|---|
| Device | display name, hostname, vendor, owner, current IP, MAC (with or without separators), tags |
| Endpoint | name, hostname, serial number, primary IP, MAC (with or without separators) |
| Incident | title, or `#<number>` |
| Switch | name, sysName, management address |
| Subnet | scope label and CIDR, and from IPAM: notes, gateway, VLAN (`317` or `vlan 317`) |
| Router | name, vendor, address |
| Knowledge | title, symptoms, tags, full text |

`%` and `_` typed by the user are literal (escaped; backslash is LIKE's default escape).

## Indexes (migration 040)

Each table is matched with one expression, and migration `040_sso_and_search.sql` creates a GIN
trigram index on exactly that expression (`devices_search_all_trgm`, `endpoints_search_all_trgm`,
`snmp_targets_search_trgm`, `site_routers_search_trgm`, `network_scopes_search_trgm`,
`ipam_subnets_search_trgm`, `device_tags_tag_trgm`). The expressions live in
`apps/api/src/modules/overview/search.ts` (`*_SEARCH_EXPR`) and must stay identical to the index
definitions. The two narrower indexes of migration 020 for devices and endpoints are replaced.

Prerequisite: the `pg_trgm` extension (PostgreSQL contrib; present in the embedded server). Without
it the migration skips the trigram indexes and search still works with scans.

## Verified

- `apps/api/tests/search.test.ts`: results for every kind (MAC without separators, VLAN, IPAM notes,
  wildcard escaping), tenant isolation, and `EXPLAIN` (as the owner role, sequential scans
  disabled) shows each `*_SEARCH_EXPR` is answered by its trigram index.

## Honest limits

- Under Row Level Security (the application role `lan_app`), PostgreSQL does not use the trigram
  index for `ILIKE`, because `ILIKE` is not a leakproof operator and may not run before the tenant
  policy. Observed plan: the `(organization_id, …)` index narrows the scan to the organization's
  rows, then the expression filters them. Search cost therefore grows with the size of one
  organization, not of the whole database. The trigram indexes serve system-role queries and any
  future leakproof path; they cost little to keep.
- Short queries (one or two characters) cannot use trigram indexes at all.

## User guide hits (2026-11-25)

The search window also lists up to five sections of the in-app user guide under "User guide". They
are found in the browser, not by the API: the guide is static content in the web app
(`apps/web/features/guide/content/`), so a server round trip would add nothing. The guide's index is
loaded the first time the search window opens (a dynamic import, so the guide is not part of every
page), searches English and Arabic together, and opens `/guide/<section>#<anchor>`. See
[user-guide.md](user-guide.md).
