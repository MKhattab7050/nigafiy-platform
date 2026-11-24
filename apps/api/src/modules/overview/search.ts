import { Router } from 'express';
import { z } from 'zod';
import type { SearchHit, SearchResponse } from '@nigafiy/shared-types';
import { auth, parse } from '../../common/http.ts';
import { withTenant } from '../../infrastructure/db.ts';

export const searchRouter: Router = Router();

const querySchema = z.object({
  q: z.string().trim().min(1).max(120),
  site_id: z.uuid().optional(),
});

function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/*
 * Each table is matched with ONE expression that is exactly the expression of its trigram index
 * (migration 040_sso_and_search.sql), so PostgreSQL can answer `expr ILIKE '%q%'` from the index.
 * Keep these strings identical to the index definitions. Backslash is LIKE's default escape
 * character, which escapeLike() relies on (no ESCAPE clause, so the index expression matches).
 */
export const DEVICE_SEARCH_EXPR = `(coalesce(d.display_name, '') || ' ' || coalesce(d.hostname, '') || ' ' || coalesce(d.vendor, '') || ' ' || coalesce(d.owner, '')
      || ' ' || coalesce(host(d.current_ip), '') || ' ' || coalesce(d.primary_mac::text, '') || ' ' || coalesce(replace(d.primary_mac::text, ':', ''), ''))`;
export const ENDPOINT_SEARCH_EXPR = `(coalesce(e.name, '') || ' ' || coalesce(e.hostname, '') || ' ' || coalesce(e.serial_number, '')
      || ' ' || coalesce(host(e.primary_ip), '') || ' ' || coalesce(e.primary_mac::text, '') || ' ' || coalesce(replace(e.primary_mac::text, ':', ''), ''))`;
export const SWITCH_SEARCH_EXPR = `(coalesce(t.name, '') || ' ' || coalesce(t.sys_name, '') || ' ' || host(t.host))`;
export const ROUTER_SEARCH_EXPR = `(r.name || ' ' || r.vendor || ' ' || host(r.address))`;
export const SCOPE_SEARCH_EXPR = `(coalesce(sc.label, '') || ' ' || text(sc.cidr))`;
export const SUBNET_SEARCH_EXPR = `(coalesce(i.notes, '') || ' ' || coalesce(host(i.gateway), ''))`;

searchRouter.get('/search', async (req, res) => {
  const ctx = auth(req);
  const { q, site_id } = parse(querySchema, req.query);
  const site = site_id ?? null;
  const pattern = `%${escapeLike(q)}%`;
  const macHex = /^[0-9a-f:.-]+$/i.test(q) ? q.toLowerCase().replace(/[^0-9a-f]/g, '') : '';
  const macPattern = macHex.length >= 2 ? `%${macHex}%` : null;
  const nigafiyDigits = q.replace(/[ -]/g, '');
  const nigafiyId = /^[1-9][0-9]{8}$/.test(nigafiyDigits) ? nigafiyDigits : null;
  const incNumMatch = /^#?(\d{1,9})$/.exec(q);
  const incNum = incNumMatch ? Number(incNumMatch[1]) : null;
  const vlanMatch = /^(?:vlan\s*)?(\d{1,4})$/i.exec(q);
  const vlan = vlanMatch && Number(vlanMatch[1]) >= 1 && Number(vlanMatch[1]) <= 4094 ? Number(vlanMatch[1]) : null;

  const response = await withTenant(ctx.organizationId, async (db): Promise<SearchResponse> => {
    const devices = await db.query<{
      id: string;
      site_id: string;
      site_name: string;
      title: string;
      current_ip: string | null;
      primary_mac: string | null;
      vendor: string | null;
      status: string;
    }>(
      `SELECT d.id, d.site_id, s.name AS site_name,
              coalesce(d.display_name, d.hostname, host(d.current_ip), d.primary_mac::text) AS title,
              host(d.current_ip) AS current_ip, d.primary_mac::text AS primary_mac, d.vendor, d.status
         FROM devices d
         JOIN sites s ON s.organization_id = d.organization_id AND s.id = d.site_id
        WHERE ($1::uuid IS NULL OR d.site_id = $1)
          AND (
            ${DEVICE_SEARCH_EXPR} ILIKE $2
            OR ($3::text IS NOT NULL AND ${DEVICE_SEARCH_EXPR} ILIKE $3)
            OR d.id IN (SELECT dt.device_id FROM device_tags dt WHERE dt.tag ILIKE $2)
            -- every observed address, IPv6 included (trigram index device_addresses_ip_trgm, migration 038)
            OR d.id IN (SELECT da.device_id FROM device_addresses da WHERE host(da.ip) ILIKE $2)
          )
        ORDER BY (d.status = 'online') DESC, d.last_seen_at DESC NULLS LAST
        LIMIT 8`,
      [site, pattern, macPattern],
    );
    const endpoints = await db.query<{
      id: string;
      site_id: string;
      site_name: string;
      name: string;
      hostname: string | null;
      primary_ip: string | null;
      os: string | null;
      connection_state: string;
      nigafiy_id: string;
    }>(
      `SELECT e.id, e.site_id, s.name AS site_name, e.name, e.hostname,
              host(e.primary_ip) AS primary_ip, e.os, e.connection_state, e.nigafiy_id
         FROM endpoints e
         JOIN sites s ON s.organization_id = e.organization_id AND s.id = e.site_id
        WHERE ($1::uuid IS NULL OR e.site_id = $1)
          AND e.kind = 'agent'
          AND (
            ${ENDPOINT_SEARCH_EXPR} ILIKE $2
            OR ($3::text IS NOT NULL AND ${ENDPOINT_SEARCH_EXPR} ILIKE $3)
            -- Connect by Nigafiy ID (9 digits, spaces allowed as it is read out).
            OR ($4::text IS NOT NULL AND e.nigafiy_id = $4)
          )
        ORDER BY (e.connection_state = 'online') DESC, e.last_heartbeat_at DESC NULLS LAST
        LIMIT 6`,
      [site, pattern, macPattern, nigafiyId],
    );
    const incidents = await db.query<{
      id: string;
      number: number;
      title: string;
      severity: string;
      status: string;
      site_id: string | null;
      site_name: string | null;
    }>(
      `SELECT i.id, i.number, i.title, i.severity, i.status, i.site_id, s.name AS site_name
         FROM incidents i
         LEFT JOIN sites s ON s.organization_id = i.organization_id AND s.id = i.site_id
        WHERE ($1::uuid IS NULL OR i.site_id = $1)
          AND (
            i.title ILIKE $2
            OR ($3::int IS NOT NULL AND i.number = $3::int)
          )
        ORDER BY (i.status <> 'resolved') DESC, i.opened_at DESC
        LIMIT 6`,
      [site, pattern, incNum],
    );
    const switches = await db.query<{
      id: string;
      site_id: string;
      site_name: string;
      name: string;
      host: string;
      last_status: string | null;
    }>(
      `SELECT t.id, t.site_id, s.name AS site_name,
              coalesce(t.name, t.sys_name, host(t.host)) AS name,
              host(t.host) AS host, t.last_status
         FROM snmp_targets t
         JOIN sites s ON s.organization_id = t.organization_id AND s.id = t.site_id
        WHERE ($1::uuid IS NULL OR t.site_id = $1)
          AND ${SWITCH_SEARCH_EXPR} ILIKE $2
        ORDER BY t.host
        LIMIT 4`,
      [site, pattern],
    );
    const scopes = await db.query<{
      id: string;
      site_id: string;
      site_name: string;
      cidr: string;
      label: string | null;
      enabled: boolean;
      vlan_id: number | null;
      gateway: string | null;
    }>(
      // IPAM subnets: the scope's own label and range, plus what IPAM documents for it (notes,
      // gateway, VLAN number).
      `SELECT sc.id, sc.site_id, s.name AS site_name, sc.cidr::text AS cidr, sc.label, sc.enabled,
              ip.vlan_id, host(ip.gateway) AS gateway
         FROM network_scopes sc
         JOIN sites s ON s.organization_id = sc.organization_id AND s.id = sc.site_id
         LEFT JOIN ipam_subnets ip ON ip.organization_id = sc.organization_id AND ip.scope_id = sc.id
        WHERE ($1::uuid IS NULL OR sc.site_id = $1)
          AND (
            ${SCOPE_SEARCH_EXPR} ILIKE $2
            OR sc.id IN (
              SELECT i.scope_id FROM ipam_subnets i
               WHERE ${SUBNET_SEARCH_EXPR} ILIKE $2
                  OR ($3::int IS NOT NULL AND i.vlan_id = $3::int)
            )
          )
        ORDER BY sc.cidr
        LIMIT 6`,
      [site, pattern, vlan],
    );
    const routers = await db.query<{
      id: string;
      site_id: string;
      site_name: string;
      name: string;
      vendor: string;
      address: string;
      status: string;
    }>(
      `SELECT r.id, r.site_id, s.name AS site_name, r.name, r.vendor,
              host(r.address) AS address, r.status
         FROM site_routers r
         JOIN sites s ON s.organization_id = r.organization_id AND s.id = r.site_id
        WHERE ($1::uuid IS NULL OR r.site_id = $1)
          AND ${ROUTER_SEARCH_EXPR} ILIKE $2
        ORDER BY r.name
        LIMIT 4`,
      [site, pattern],
    );
    // Knowledge memory: published articles for everyone; candidates and drafts for technicians and up.
    const knowledgeStatuses = ctx.role === 'viewer' ? ['published'] : ['published', 'draft', 'candidate'];
    const knowledge = await db.query<{ id: string; title: string; status: string; kind: string; tags: string[]; site_id: string | null; site_name: string | null }>(
      `SELECT k.id, k.title, k.status, k.kind, k.tags, k.site_id, s.name AS site_name
         FROM knowledge_entries k
         LEFT JOIN sites s ON s.organization_id = k.organization_id AND s.id = k.site_id
        WHERE k.status = ANY($3::text[])
          AND ($1::uuid IS NULL OR k.site_id IS NULL OR k.site_id = $1)
          AND (k.title ILIKE $2 OR k.symptoms ILIKE $2 OR array_to_string(k.tags, ' ') ILIKE $2
               OR k.search @@ plainto_tsquery('simple', $4))
        ORDER BY (k.status = 'published') DESC, k.updated_at DESC
        LIMIT 4`,
      [site, pattern, knowledgeStatuses, q],
    );

    const items: SearchHit[] = [
      ...devices.rows.map(
        (d): SearchHit => ({
          kind: 'device',
          id: d.id,
          title: d.title,
          subtitle: [d.current_ip, d.primary_mac, d.vendor].filter(Boolean).join(' · ') || null,
          status: d.status,
          href: `/radar/devices/${d.id}`,
          site_id: d.site_id,
          site_name: d.site_name,
        }),
      ),
      ...endpoints.rows.map(
        (e): SearchHit => ({
          kind: 'endpoint',
          id: e.id,
          title: e.name,
          subtitle: [`ID ${e.nigafiy_id}`, e.hostname, e.primary_ip, e.os].filter(Boolean).join(' · ') || null,
          status: e.connection_state,
          // Found by its Nigafiy ID: open the endpoint with the connect dialog ("connect by ID").
          href: e.nigafiy_id === nigafiyId ? `/fleet/endpoints/${e.id}?connect=1` : `/fleet/endpoints/${e.id}`,
          site_id: e.site_id,
          site_name: e.site_name,
        }),
      ),
      ...incidents.rows.map(
        (i): SearchHit => ({
          kind: 'incident',
          id: i.id,
          title: `#${i.number} ${i.title}`,
          subtitle: `${i.severity} · ${i.status}`,
          status: i.status,
          href: `/watch/incidents/${i.id}`,
          site_id: i.site_id,
          site_name: i.site_name,
        }),
      ),
      ...switches.rows.map(
        (t): SearchHit => ({
          kind: 'switch',
          id: t.id,
          title: t.name,
          subtitle: t.host,
          status: t.last_status,
          href: `/radar/ports?switch=${t.id}`,
          site_id: t.site_id,
          site_name: t.site_name,
        }),
      ),
      ...scopes.rows.map(
        (sc): SearchHit => ({
          kind: 'subnet',
          id: sc.id,
          title: sc.label ? `${sc.label} (${sc.cidr})` : sc.cidr,
          subtitle: [sc.cidr, sc.vlan_id !== null ? `VLAN ${sc.vlan_id}` : null, sc.gateway ? `gw ${sc.gateway}` : null].filter(Boolean).join(' · '),
          status: sc.enabled ? 'enabled' : 'disabled',
          href: `/radar/ipam?subnet=${sc.id}`,
          site_id: sc.site_id,
          site_name: sc.site_name,
        }),
      ),
      ...routers.rows.map(
        (r): SearchHit => ({
          kind: 'router',
          id: r.id,
          title: r.name,
          subtitle: [r.address, r.vendor].filter(Boolean).join(' · ') || null,
          status: r.status,
          href: `/guard/routers/${r.id}`,
          site_id: r.site_id,
          site_name: r.site_name,
        }),
      ),
      ...knowledge.rows.map(
        (k): SearchHit => ({
          kind: 'knowledge',
          id: k.id,
          title: k.title,
          subtitle: [k.kind, ...k.tags.slice(0, 3)].join(' · '),
          status: k.status,
          href: `/mind/knowledge/${k.id}`,
          site_id: k.site_id,
          site_name: k.site_name,
        }),
      ),
    ].slice(0, 30);

    return { query: q, items };
  });

  res.json(response);
});
