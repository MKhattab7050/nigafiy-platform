import { Router } from 'express';
import { z } from 'zod';
import type { SearchHit, SearchResponse } from '@lan-detective/shared-types';
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

searchRouter.get('/search', async (req, res) => {
  const ctx = auth(req);
  const { q, site_id } = parse(querySchema, req.query);
  const site = site_id ?? null;
  const pattern = `%${escapeLike(q)}%`;
  const macHex = /^[0-9a-f:.-]+$/i.test(q) ? q.toLowerCase().replace(/[^0-9a-f]/g, '') : '';
  const macPattern = macHex.length >= 2 ? `%${macHex}%` : null;
  const incNumMatch = /^#?(\d{1,9})$/.exec(q);
  const incNum = incNumMatch ? Number(incNumMatch[1]) : null;

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
            d.display_name ILIKE $2 ESCAPE '\\'
            OR d.hostname ILIKE $2 ESCAPE '\\'
            OR d.vendor ILIKE $2 ESCAPE '\\'
            OR d.owner ILIKE $2 ESCAPE '\\'
            OR host(d.current_ip) ILIKE $2 ESCAPE '\\'
            OR d.primary_mac::text ILIKE $2 ESCAPE '\\'
            OR ($3::text IS NOT NULL AND replace(d.primary_mac::text, ':', '') ILIKE $3 ESCAPE '\\')
            OR EXISTS (
              SELECT 1 FROM device_tags dt
               WHERE dt.organization_id = d.organization_id
                 AND dt.device_id = d.id
                 AND dt.tag ILIKE $2 ESCAPE '\\'
            )
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
    }>(
      `SELECT e.id, e.site_id, s.name AS site_name, e.name, e.hostname,
              host(e.primary_ip) AS primary_ip, e.os, e.connection_state
         FROM endpoints e
         JOIN sites s ON s.organization_id = e.organization_id AND s.id = e.site_id
        WHERE ($1::uuid IS NULL OR e.site_id = $1)
          AND (
            e.name ILIKE $2 ESCAPE '\\'
            OR e.hostname ILIKE $2 ESCAPE '\\'
            OR e.serial_number ILIKE $2 ESCAPE '\\'
            OR host(e.primary_ip) ILIKE $2 ESCAPE '\\'
            OR e.primary_mac::text ILIKE $2 ESCAPE '\\'
            OR ($3::text IS NOT NULL AND replace(e.primary_mac::text, ':', '') ILIKE $3 ESCAPE '\\')
          )
        ORDER BY (e.connection_state = 'online') DESC, e.last_heartbeat_at DESC NULLS LAST
        LIMIT 6`,
      [site, pattern, macPattern],
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
            i.title ILIKE $2 ESCAPE '\\'
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
          AND (
            t.name ILIKE $2 ESCAPE '\\'
            OR t.sys_name ILIKE $2 ESCAPE '\\'
            OR host(t.host) ILIKE $2 ESCAPE '\\'
          )
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
    }>(
      `SELECT sc.id, sc.site_id, s.name AS site_name, sc.cidr::text AS cidr, sc.label, sc.enabled
         FROM network_scopes sc
         JOIN sites s ON s.organization_id = sc.organization_id AND s.id = sc.site_id
        WHERE ($1::uuid IS NULL OR sc.site_id = $1)
          AND (
            sc.cidr::text ILIKE $2 ESCAPE '\\'
            OR sc.label ILIKE $2 ESCAPE '\\'
          )
        ORDER BY sc.cidr
        LIMIT 4`,
      [site, pattern],
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
          AND (
            r.name ILIKE $2 ESCAPE '\\'
            OR r.vendor ILIKE $2 ESCAPE '\\'
            OR host(r.address) ILIKE $2 ESCAPE '\\'
          )
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
          AND (k.title ILIKE $2 ESCAPE '\\' OR k.symptoms ILIKE $2 ESCAPE '\\' OR array_to_string(k.tags, ' ') ILIKE $2 ESCAPE '\\'
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
          href: `/devices/${d.id}`,
          site_id: d.site_id,
          site_name: d.site_name,
        }),
      ),
      ...endpoints.rows.map(
        (e): SearchHit => ({
          kind: 'endpoint',
          id: e.id,
          title: e.name,
          subtitle: [e.hostname, e.primary_ip, e.os].filter(Boolean).join(' · ') || null,
          status: e.connection_state,
          href: `/endpoints/${e.id}`,
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
          href: `/incidents/${i.id}`,
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
          href: `/ports?switch=${t.id}`,
          site_id: t.site_id,
          site_name: t.site_name,
        }),
      ),
      ...scopes.rows.map(
        (sc): SearchHit => ({
          kind: 'subnet',
          id: sc.id,
          title: sc.label ? `${sc.label} (${sc.cidr})` : sc.cidr,
          subtitle: sc.cidr,
          status: sc.enabled ? 'enabled' : 'disabled',
          href: `/ipam?subnet=${sc.id}`,
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
          href: `/routers/${r.id}`,
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
          href: `/knowledge/${k.id}`,
          site_id: k.site_id,
          site_name: k.site_name,
        }),
      ),
    ].slice(0, 30);

    return { query: q, items };
  });

  res.json(response);
});
