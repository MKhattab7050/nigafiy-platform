import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { systemPool, withTenant } from '../src/infrastructure/db.ts';
import { captureCandidates } from '../src/modules/knowledge/capture.ts';
import { type RankCandidate, type RankContext, rankEntries, scoreEntry, textQuery } from '../src/modules/knowledge/ranking.ts';
import { markdownToText, parseMarkdown, safeHref } from '@nigafiy/shared-types/markdown';
import { app, CSRF, newAccount, setRole, type TestAccount } from './helpers.ts';

// ── fixtures (real rows in the throw-away database; nothing is mocked) ──

async function addDevice(a: TestAccount, opts: { ip: string; vendor?: string; type?: string; name?: string }): Promise<string> {
  const r = await systemPool.query<{ id: string }>(
    `INSERT INTO devices (organization_id, site_id, identity_basis, current_ip, hostname, vendor, device_type, type_source, first_seen_at, last_seen_at)
     VALUES ($1,$2,'ip',$3,$4,$5,$6,'manual',now(),now()) RETURNING id`,
    [a.organizationId, a.siteId, opts.ip, opts.name ?? `host-${opts.ip}`, opts.vendor ?? null, opts.type ?? 'unknown'],
  );
  return r.rows[0]!.id;
}

function diagnosis(rule: string, domain: string, title: string) {
  return {
    engine: 'rules-v1',
    rule,
    fault_domain: domain,
    title,
    summary: `${title}. The gateway did not answer for 4 minutes.`,
    probable_cause: 'The router at the site is powered off or hung.',
    confidence: 'high',
    confidence_reason: 'All probes failed.',
    evidence: [{ label: 'Gateway ping', value: '0 of 12 replies', basis: 'observed', source: 'collector', observed_at: new Date().toISOString() }],
    ruled_out: [],
    alternatives: [],
    investigation_steps: [],
    recommendations: [],
    affected: { devices_offline: 3, devices_total: 10, checks: [{ id: randomUUID(), name: 'Gateway', role: 'gateway', state: 'down' }] },
    related_incidents: [],
    generated_at: new Date().toISOString(),
  };
}

async function addIncident(
  a: TestAccount,
  opts: { title?: string; kind?: string; deviceId?: string | null; rule?: string; domain?: string; status?: 'open' | 'resolved'; note?: string | null; resolutionKind?: 'auto' | 'manual' } = {},
): Promise<string> {
  const status = opts.status ?? 'open';
  const r = await systemPool.query<{ id: string }>(
    `INSERT INTO incidents (organization_id, site_id, number, kind, correlation_key, status, severity, title, device_id, opened_at, resolved_at,
                            resolution_kind, resolution_note, diagnosis, diagnosed_at)
     VALUES ($1,$2,(SELECT coalesce(max(number),0)+1 FROM incidents WHERE organization_id = $1),$3,$4,$5,'critical',$6,$7,
             now() - interval '65 minutes', CASE WHEN $5 = 'resolved' THEN now() END, CASE WHEN $5 = 'resolved' THEN $8 END, $9, $10, now())
     RETURNING id`,
    [
      a.organizationId, a.siteId, opts.kind ?? 'network', `test:${randomUUID()}`, status, opts.title ?? 'Gateway unreachable at HQ', opts.deviceId ?? null,
      opts.resolutionKind ?? 'auto', opts.note ?? null,
      JSON.stringify(diagnosis(opts.rule ?? 'gateway-down', opts.domain ?? 'gateway', 'Gateway is not responding')),
    ],
  );
  return r.rows[0]!.id;
}

async function auditActions(a: TestAccount): Promise<{ action: string; actor: string; target_id: string | null; metadata: Record<string, unknown> }[]> {
  return (await systemPool.query(`SELECT action, actor, target_id, metadata FROM audit_logs WHERE organization_id = $1 ORDER BY created_at`, [a.organizationId])).rows;
}

/** A second person in the same organization (for per-user votes). */
async function addMember(owner: TestAccount, role: string): Promise<TestAccount> {
  const other = await newAccount('member');
  const user = await systemPool.query<{ id: string }>(`SELECT id FROM users WHERE lower(email) = $1`, [other.email]);
  await systemPool.query(`INSERT INTO memberships (user_id, organization_id, role) VALUES ($1,$2,$3)`, [user.rows[0]!.id, owner.organizationId, role]);
  const sw = await other.agent.post('/api/v1/auth/switch-organization').set(CSRF).send({ organization_id: owner.organizationId });
  expect(sw.status).toBe(200);
  return { ...other, organizationId: owner.organizationId, siteId: owner.siteId };
}

async function publishedEntry(a: TestAccount, body: Record<string, unknown>): Promise<string> {
  const res = await a.agent.post('/api/v1/knowledge').set(CSRF).send({ fix_steps: 'Power-cycle it.', publish: true, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  expect(res.body.status).toBe('published');
  return res.body.id;
}

// ── automatic capture ──

describe('knowledge capture from incidents', () => {
  it('turns a manual resolve with a note into a pre-filled candidate and follows later comments', async () => {
    const a = await newAccount('kb-capture');
    const device = await addDevice(a, { ip: '10.0.0.1', vendor: 'MikroTik', type: 'router', name: 'core-router' });
    const incident = await addIncident(a, { deviceId: device });
    // Before it is resolved there is nothing to capture, even with comments.
    expect((await a.agent.post(`/api/v1/incidents/${incident}/comments`).set(CSRF).send({ body: 'Checking the router power supply' })).status).toBe(201);
    expect((await a.agent.get('/api/v1/knowledge/counts')).body.candidate).toBe(0);

    const resolved = await a.agent.post(`/api/v1/incidents/${incident}/resolve`).set(CSRF).send({ note: 'Replaced the router power adapter; it had failed.' });
    expect(resolved.status).toBe(200);

    const list = await a.agent.get('/api/v1/knowledge?status=candidate');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.counts.candidate).toBe(1);
    const c = list.body.items[0];
    expect(c).toMatchObject({
      status: 'candidate',
      source: 'incident',
      incident_id: incident,
      title: 'Gateway is not responding',
      rule_ids: ['gateway-down'],
      incident_kinds: ['network'],
      fault_domain: 'gateway',
      diagnosis_confidence: 'high',
      cause: 'The router at the site is powered off or hung.',
      cause_source: 'doctor',
      device_id: device,
      device_types: ['router'],
      vendors: ['MikroTik'],
      site_id: a.siteId,
      edited: false,
      revision: 1,
    });
    expect(c.tags).toEqual(expect.arrayContaining(['network', 'gateway', 'router']));
    expect(c.fix_steps).toContain('Replaced the router power adapter');
    expect(c.fix_steps).toContain('Checking the router power supply');
    expect(c.symptoms).toContain('Gateway unreachable at HQ');
    expect(c.symptoms).toContain('Gateway ping: 0 of 12 replies');
    expect(c.incident_duration_seconds).toBeGreaterThanOrEqual(64 * 60);
    expect(c.diagnosis_summary).toContain('did not answer');

    // A later comment refreshes the untouched candidate (new revision, same entry).
    await a.agent.post(`/api/v1/incidents/${incident}/comments`).set(CSRF).send({ body: 'Ordered a spare adapter for the cabinet' });
    const detail = await a.agent.get(`/api/v1/knowledge/${c.id}`);
    expect(detail.body.fix_steps).toContain('Ordered a spare adapter');
    expect(detail.body.revision).toBe(2);
    expect(detail.body.revisions.map((r: { action: string }) => r.action)).toEqual(['refreshed', 'captured']);

    // Capture is idempotent and audited as a system action of the automation.
    await withTenant(a.organizationId, (db) => captureCandidates(db, a.organizationId));
    expect((await a.agent.get('/api/v1/knowledge?status=all')).body.total).toBe(1);
    const captured = (await auditActions(a)).filter((e) => e.action === 'knowledge.candidate_captured');
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({ actor: 'system', target_id: c.id, metadata: { automation: 'suggest.knowledge_from_incidents', incident_id: incident } });

    // Once a person edits the candidate, new comments no longer overwrite their text.
    const edited = await a.agent.patch(`/api/v1/knowledge/${c.id}`).set(CSRF).send({ expected_revision: 2, title: 'Router power adapter failure' });
    expect(edited.status).toBe(200);
    await a.agent.post(`/api/v1/incidents/${incident}/comments`).set(CSRF).send({ body: 'Another note' });
    expect((await a.agent.get(`/api/v1/knowledge/${c.id}`)).body).toMatchObject({ title: 'Router power adapter failure', revision: 3 });
  });

  it('captures resolved incidents with comments only, skips silent auto-resolves, never re-creates discarded or deleted candidates, and honours the automation switch', async () => {
    const a = await newAccount('kb-rules');
    const silent = await addIncident(a, { status: 'resolved' });
    const commented = await addIncident(a, { status: 'resolved', title: 'DNS slow' });
    await a.agent.post(`/api/v1/incidents/${commented}/comments`).set(CSRF).send({ body: 'Switched the forwarder to the ISP resolver' });
    const list = (await a.agent.get('/api/v1/knowledge?status=candidate')).body.items;
    expect(list.map((e: { incident_id: string }) => e.incident_id)).toEqual([commented]);
    expect(list.map((e: { incident_id: string }) => e.incident_id)).not.toContain(silent);

    // Discard: stays discarded; restore brings it back as a candidate.
    const id = list[0].id;
    expect((await a.agent.post(`/api/v1/knowledge/${id}/discard`).set(CSRF)).body.status).toBe('discarded');
    expect((await a.agent.get('/api/v1/knowledge/counts')).body).toMatchObject({ candidate: 0, discarded: 1 });
    expect((await a.agent.patch(`/api/v1/knowledge/${id}`).set(CSRF).send({ expected_revision: 1, title: 'x y z' })).status).toBe(409);
    expect((await a.agent.post(`/api/v1/knowledge/${id}/restore`).set(CSRF)).body.status).toBe('candidate');

    // Delete (admin): the incident is not captured again.
    expect((await a.agent.delete(`/api/v1/knowledge/${id}`).set(CSRF)).status).toBe(204);
    expect((await a.agent.get('/api/v1/knowledge?status=all')).body.total).toBe(0);

    // Automation off for the organization: nothing is captured.
    const off = await a.agent.put('/api/v1/automation/suggest.knowledge_from_incidents').set(CSRF).send({ enabled: false });
    expect(off.status).toBe(200);
    await addIncident(a, { status: 'resolved', note: 'Rebooted the switch', resolutionKind: 'manual' });
    expect((await a.agent.get('/api/v1/knowledge/counts')).body.candidate).toBe(0);
    await a.agent.put('/api/v1/automation/suggest.knowledge_from_incidents').set(CSRF).send({ enabled: true });
    expect((await a.agent.get('/api/v1/knowledge/counts')).body.candidate).toBe(1);
  });
});

// ── permissions, workflow, audit ──

describe('knowledge permissions and workflow', () => {
  it('lets technicians draft and edit, admins publish and delete, viewers read published only — every change audited', async () => {
    const a = await newAccount('kb-perm');
    await setRole(a.email, a.organizationId, 'technician');
    const draft = await a.agent.post('/api/v1/knowledge').set(CSRF).send({
      kind: 'runbook',
      title: 'Printer offline after DHCP renew',
      symptoms: 'Printer shows **offline** on all PCs',
      fix_steps: '1. Reserve the printer IP\n2. Re-add the port',
      tags: ['Printer', 'DHCP', 'printer'],
      device_types: ['printer'],
      event_types: ['device_ip_changed'],
    });
    expect(draft.status).toBe(201);
    expect(draft.body).toMatchObject({ status: 'draft', source: 'manual', kind: 'runbook', tags: ['printer', 'dhcp'], cause_source: 'manual', revision: 1 });
    const id = draft.body.id;

    // A technician cannot publish (neither directly nor on create).
    expect((await a.agent.post(`/api/v1/knowledge/${id}/publish`).set(CSRF)).status).toBe(403);
    expect((await a.agent.post('/api/v1/knowledge').set(CSRF).send({ title: 'Direct publish', fix_steps: 'x', publish: true })).status).toBe(403);
    // Edits need the current revision; a stale one is rejected.
    expect((await a.agent.patch(`/api/v1/knowledge/${id}`).set(CSRF).send({ expected_revision: 1, cause: 'Lease expired and the printer got a new address' })).status).toBe(200);
    const stale = await a.agent.patch(`/api/v1/knowledge/${id}`).set(CSRF).send({ expected_revision: 1, title: 'Older edit' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('stale_revision');
    // Validation: unknown fields, HTML-ish tags, links to rows of no organization.
    expect((await a.agent.patch(`/api/v1/knowledge/${id}`).set(CSRF).send({ expected_revision: 2, surprise: true })).status).toBe(400);
    expect((await a.agent.patch(`/api/v1/knowledge/${id}`).set(CSRF).send({ expected_revision: 2, tags: ['<script>'] })).status).toBe(400);
    expect((await a.agent.patch(`/api/v1/knowledge/${id}`).set(CSRF).send({ expected_revision: 2, device_id: randomUUID() })).status).toBe(400);

    await setRole(a.email, a.organizationId, 'admin');
    const noFix = await a.agent.post('/api/v1/knowledge').set(CSRF).send({ title: 'Empty article' });
    expect((await a.agent.post(`/api/v1/knowledge/${noFix.body.id}/publish`).set(CSRF)).body.error.code).toBe('fix_required');
    const published = await a.agent.post(`/api/v1/knowledge/${id}/publish`).set(CSRF);
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ status: 'published', published_by_name: 'kb-perm admin' });

    // Technicians cannot edit published knowledge or delete anything.
    await setRole(a.email, a.organizationId, 'technician');
    expect((await a.agent.patch(`/api/v1/knowledge/${id}`).set(CSRF).send({ expected_revision: 2, title: 'Changed' })).status).toBe(403);
    expect((await a.agent.delete(`/api/v1/knowledge/${noFix.body.id}`).set(CSRF)).status).toBe(403);

    // Viewers: published only, read-only.
    await setRole(a.email, a.organizationId, 'viewer');
    const viewerList = await a.agent.get('/api/v1/knowledge');
    expect(viewerList.body.items.map((e: { id: string }) => e.id)).toEqual([id]);
    expect(viewerList.body.counts).toMatchObject({ draft: 0, published: 1 });
    expect((await a.agent.get(`/api/v1/knowledge/${noFix.body.id}`)).status).toBe(404);
    expect((await a.agent.get(`/api/v1/knowledge/${id}`)).status).toBe(200);
    expect((await a.agent.post('/api/v1/knowledge').set(CSRF).send({ title: 'Viewer article' })).status).toBe(403);
    expect((await a.agent.put(`/api/v1/knowledge/${id}/vote`).set(CSRF).send({ helpful: true })).status).toBe(403);
    expect((await a.agent.get('/api/v1/knowledge/tags')).body.items).toEqual(expect.arrayContaining([{ tag: 'printer', count: 1 }]));

    // Search: text, tag and kind filters.
    await setRole(a.email, a.organizationId, 'admin');
    expect((await a.agent.get('/api/v1/knowledge?q=renew')).body.items.map((e: { id: string }) => e.id)).toEqual([id]);
    expect((await a.agent.get('/api/v1/knowledge?q=lease')).body.items.map((e: { id: string }) => e.id)).toEqual([id]);
    expect((await a.agent.get('/api/v1/knowledge?tag=DHCP')).body.total).toBe(1);
    expect((await a.agent.get('/api/v1/knowledge?kind=article&status=published')).body.total).toBe(0);

    // Unpublish → draft; delete.
    expect((await a.agent.post(`/api/v1/knowledge/${id}/unpublish`).set(CSRF)).body.status).toBe('draft');
    expect((await a.agent.delete(`/api/v1/knowledge/${noFix.body.id}`).set(CSRF)).status).toBe(204);

    const revisions = (await a.agent.get(`/api/v1/knowledge/${id}`)).body.revisions;
    expect(revisions.map((r: { action: string }) => r.action)).toEqual(['unpublished', 'published', 'edited', 'created']);
    expect(revisions[2]).toMatchObject({ revision: 2, user_name: 'kb-perm admin', snapshot: { cause: 'Lease expired and the printer got a new address' } });

    const actions = (await auditActions(a)).map((e) => e.action).filter((x) => x.startsWith('knowledge.'));
    expect(actions).toEqual(['knowledge.created', 'knowledge.updated', 'knowledge.created', 'knowledge.published', 'knowledge.unpublished', 'knowledge.deleted']);
  });

  it('labels the doctor cause as inferred until a person rewrites or confirms it', async () => {
    const a = await newAccount('kb-cause');
    await addIncident(a, { status: 'resolved', note: 'Rebooted the router', resolutionKind: 'manual' });
    const c = (await a.agent.get('/api/v1/knowledge?status=candidate')).body.items[0];
    expect(c.cause_source).toBe('doctor');
    const kept = await a.agent.patch(`/api/v1/knowledge/${c.id}`).set(CSRF).send({ expected_revision: 1, tags: ['router'] });
    expect(kept.body.cause_source).toBe('doctor');
    const confirmed = await a.agent.patch(`/api/v1/knowledge/${c.id}`).set(CSRF).send({ expected_revision: 2, confirm_cause: true });
    expect(confirmed.body.cause_source).toBe('manual');
    // Candidates are published straight from the inbox by an admin.
    expect((await a.agent.post(`/api/v1/knowledge/${c.id}/publish`).set(CSRF)).body.status).toBe('published');
  });
});

// ── retrieval: ranking with reasons, votes, fix used ──

describe('knowledge suggestions', () => {
  it('ranks by rule, device, vendor and text with explained reasons; votes and "fix used" adjust the ranking', async () => {
    const a = await newAccount('kb-rank');
    const device = await addDevice(a, { ip: '10.1.0.1', vendor: 'MikroTik RouterBOARD', type: 'router' });
    const ruleEntry = await publishedEntry(a, { title: 'Restart the gateway', rule_ids: ['gateway-down'], incident_kinds: ['network'] });
    const deviceEntry = await publishedEntry(a, { title: 'Core box checklist', device_id: device });
    const vendorEntry = await publishedEntry(a, { title: 'Firmware quirks', vendors: ['mikrotik'] });
    const unrelated = await publishedEntry(a, { title: 'Printer paper jam', rule_ids: ['dns-down'], incident_kinds: ['service'] });
    const draftOnly = await a.agent.post('/api/v1/knowledge').set(CSRF).send({ title: 'Draft gateway notes', rule_ids: ['gateway-down'], fix_steps: 'x' });
    const incident = await addIncident(a, { deviceId: device });

    const res = await a.agent.get(`/api/v1/knowledge/suggest?incident_id=${incident}`);
    expect(res.status).toBe(200);
    expect(res.body.context).toMatchObject({ incident_id: incident, rule_ids: ['gateway-down'], incident_kind: 'network', device_type: 'router', vendor: 'MikroTik RouterBOARD', site_id: a.siteId });
    const ids = res.body.items.map((s: { entry: { id: string } }) => s.entry.id);
    expect(ids).toEqual([ruleEntry, deviceEntry, vendorEntry]);
    expect(ids).not.toContain(unrelated);
    expect(ids).not.toContain(draftOnly.body.id);
    const byId = (id: string) => res.body.items.find((s: { entry: { id: string } }) => s.entry.id === id);
    const codes = (id: string) => byId(id).reasons.map((r: { code: string }) => r.code);
    expect(codes(ruleEntry)).toEqual(expect.arrayContaining(['rule', 'incident_kind', 'text', 'recent']));
    expect(byId(ruleEntry).reasons.find((r: { code: string }) => r.code === 'rule')).toEqual({ code: 'rule', detail: 'gateway-down', points: 40 });
    expect(codes(deviceEntry)).toEqual(expect.arrayContaining(['device']));
    expect(codes(vendorEntry)).toEqual(expect.arrayContaining(['vendor']));
    // The score is exactly the sum of the explained points.
    for (const s of res.body.items) expect(s.score).toBeCloseTo(s.reasons.reduce((n: number, r: { points: number }) => n + r.points, 0), 1);

    // "Did this help?": one vote per user; a second person's vote counts separately.
    const before = byId(vendorEntry).score;
    expect((await a.agent.put(`/api/v1/knowledge/${vendorEntry}/vote`).set(CSRF).send({ helpful: true })).body).toMatchObject({ helpful: 1, my_vote: true });
    expect((await a.agent.put(`/api/v1/knowledge/${vendorEntry}/vote`).set(CSRF).send({ helpful: true })).body.helpful).toBe(1);
    const tech = await addMember(a, 'technician');
    expect((await tech.agent.put(`/api/v1/knowledge/${vendorEntry}/vote`).set(CSRF).send({ helpful: true })).body).toMatchObject({ helpful: 2, my_vote: true });
    expect((await tech.agent.put(`/api/v1/knowledge/${deviceEntry}/vote`).set(CSRF).send({ helpful: false })).body).toMatchObject({ not_helpful: 1, my_vote: false });
    const after = (await a.agent.get(`/api/v1/knowledge/suggest?incident_id=${incident}`)).body.items;
    const vendorAfter = after.find((s: { entry: { id: string } }) => s.entry.id === vendorEntry);
    expect(vendorAfter.reasons.find((r: { code: string }) => r.code === 'votes')).toMatchObject({ points: 6, detail: '+2 / -0' });
    expect(vendorAfter.score).toBeCloseTo(before + 6, 0);
    expect(after.find((s: { entry: { id: string } }) => s.entry.id === deviceEntry).reasons.find((r: { code: string }) => r.code === 'votes').points).toBe(-3);
    // Removing a vote.
    expect((await tech.agent.delete(`/api/v1/knowledge/${deviceEntry}/vote`).set(CSRF)).body).toMatchObject({ not_helpful: 0, my_vote: null });
    expect((await tech.agent.delete(`/api/v1/knowledge/${deviceEntry}/vote`).set(CSRF)).status).toBe(404);

    // "Mark as fix used": links entry and incident, notes it on the incident, boosts the entry.
    const used = await a.agent.post(`/api/v1/knowledge/${ruleEntry}/uses`).set(CSRF).send({ incident_id: incident });
    expect(used.status).toBe(201);
    expect(used.body.uses).toBe(1);
    const inc = (await a.agent.get(`/api/v1/incidents/${incident}`)).body;
    expect(inc.activity.map((x: { body: string }) => x.body)).toContain('Knowledge used as the fix: Restart the gateway');
    const detail = (await a.agent.get(`/api/v1/knowledge/${ruleEntry}`)).body;
    expect(detail.used_on).toMatchObject([{ incident_id: incident, incident_title: 'Gateway unreachable at HQ' }]);
    const withUse = (await a.agent.get(`/api/v1/knowledge/suggest?incident_id=${incident}`)).body.items[0];
    expect(withUse.reasons.find((r: { code: string }) => r.code === 'used')).toMatchObject({ points: 2, detail: '1' });
    // An incident whose fix was an existing article is not captured again as a candidate.
    await a.agent.post(`/api/v1/incidents/${incident}/resolve`).set(CSRF).send({ note: 'Used the runbook' });
    expect((await a.agent.get('/api/v1/knowledge/counts')).body.candidate).toBe(0);
    expect((await a.agent.delete(`/api/v1/knowledge/${ruleEntry}/uses/${incident}`).set(CSRF)).status).toBe(204);

    // Device and doctor-rule contexts.
    const forDevice = (await a.agent.get(`/api/v1/knowledge/suggest?device_id=${device}`)).body.items;
    expect(forDevice.find((s: { entry: { id: string } }) => s.entry.id === deviceEntry).reasons.map((r: { code: string }) => r.code)).toContain('device');
    const forRule = (await a.agent.get(`/api/v1/knowledge/suggest?rule=gateway-down&site_id=${a.siteId}`)).body.items;
    expect(forRule[0].entry.id).toBe(ruleEntry);
    expect((await a.agent.get('/api/v1/knowledge/suggest')).status).toBe(400);
    expect((await a.agent.get(`/api/v1/knowledge/suggest?incident_id=${randomUUID()}`)).status).toBe(404);

    const actions = (await auditActions(a)).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['knowledge.voted', 'knowledge.vote_removed', 'knowledge.fix_used', 'knowledge.fix_unlinked']));
  });

  it('leaves out the entry captured from the same incident', async () => {
    const a = await newAccount('kb-self');
    const incident = await addIncident(a, { status: 'resolved', note: 'Rebooted the router', resolutionKind: 'manual' });
    const c = (await a.agent.get('/api/v1/knowledge?status=candidate')).body.items[0];
    await a.agent.post(`/api/v1/knowledge/${c.id}/publish`).set(CSRF);
    expect((await a.agent.get(`/api/v1/knowledge/suggest?incident_id=${incident}`)).body.items).toHaveLength(0);
    const next = await addIncident(a);
    const items = (await a.agent.get(`/api/v1/knowledge/suggest?incident_id=${next}`)).body.items;
    expect(items.map((s: { entry: { id: string } }) => s.entry.id)).toEqual([c.id]);
    expect(items[0].reasons.map((r: { code: string }) => r.code)).toEqual(expect.arrayContaining(['rule', 'fault_domain', 'incident_kind', 'site']));
  });

  it('ranking is deterministic: score, then helpful votes, then recency, then id', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const ctx: RankContext = { incident_id: null, device_id: null, site_id: 's', check_id: null, rule_ids: ['gateway-down'], fault_domain: null, incident_kind: null, event_types: ['device_offline', 'check_down'], device_type: 'router', vendor: 'Cisco' };
    const base: RankCandidate = { id: 'x', rule_ids: [], fault_domain: null, incident_kinds: [], event_types: [], device_types: [], vendors: [], site_id: null, device_id: null, check_id: null, text_rank: 0, helpful: 0, not_helpful: 0, uses: 0, updated_at: '2025-01-01T00:00:00Z' };
    const entries: RankCandidate[] = [
      { ...base, id: 'b', site_id: 's' },
      { ...base, id: 'a', site_id: 's' },
      { ...base, id: 'c', site_id: 's', helpful: 1, not_helpful: 1 },
      { ...base, id: 'rule', rule_ids: ['GATEWAY-DOWN'] },
      { ...base, id: 'events', event_types: ['device_offline', 'check_down', 'x'] },
      { ...base, id: 'votes-only', helpful: 9 },
      { ...base, id: 'buried', site_id: 's', not_helpful: 5 },
    ];
    const ranked = rankEntries(ctx, entries, 10, now);
    expect(ranked.map((r) => r.entry.id)).toEqual(['rule', 'events', 'c', 'a', 'b']);
    expect(ranked[1]!.reasons).toEqual([{ code: 'event_type', detail: 'device_offline, check_down', points: 16 }]);
    expect(scoreEntry(ctx, entries[5]!, now)).toEqual({ score: 0, reasons: [] });
    expect(rankEntries(ctx, [...entries].reverse(), 10, now).map((r) => r.entry.id)).toEqual(['rule', 'events', 'c', 'a', 'b']);
    expect(textQuery("Gateway's down; DROP TABLE x -- 'quote' & | !")).toBe('gateway | down | drop | table | quote');
    expect(textQuery('عطل في البوابة')).toBe('عطل | البوابة');
  });
});

// ── tenant isolation and global search ──

describe('knowledge tenant isolation and search', () => {
  it('never shows another organization’s knowledge, incidents or votes', async () => {
    const a = await newAccount('kb-iso-a');
    const b = await newAccount('kb-iso-b');
    const entry = await publishedEntry(a, { title: 'Secret runbook for HQ firewall', rule_ids: ['gateway-down'] });
    const incidentA = await addIncident(a);
    const incidentB = await addIncident(b);

    expect((await b.agent.get(`/api/v1/knowledge/${entry}`)).status).toBe(404);
    expect((await b.agent.get('/api/v1/knowledge')).body.total).toBe(0);
    expect((await b.agent.get(`/api/v1/knowledge/suggest?incident_id=${incidentA}`)).status).toBe(404);
    expect((await b.agent.get(`/api/v1/knowledge/suggest?incident_id=${incidentB}`)).body.items).toHaveLength(0);
    expect((await b.agent.put(`/api/v1/knowledge/${entry}/vote`).set(CSRF).send({ helpful: true })).status).toBe(404);
    expect((await b.agent.patch(`/api/v1/knowledge/${entry}`).set(CSRF).send({ expected_revision: 1, title: 'Hijack' })).status).toBe(404);
    expect((await b.agent.delete(`/api/v1/knowledge/${entry}`).set(CSRF)).status).toBe(404);
    expect((await a.agent.post(`/api/v1/knowledge/${entry}/uses`).set(CSRF).send({ incident_id: incidentB })).status).toBe(404);
    expect((await b.agent.get('/api/v1/search?q=firewall')).body.items.filter((h: { kind: string }) => h.kind === 'knowledge')).toHaveLength(0);
    // Row Level Security itself: B's tenant transaction sees none of A's rows.
    const leaked = await withTenant(b.organizationId, (db) => db.query(`SELECT 1 FROM knowledge_entries UNION ALL SELECT 1 FROM knowledge_revisions UNION ALL SELECT 1 FROM knowledge_captured`));
    expect(leaked.rowCount).toBe(0);

    // Global search: published knowledge for viewers, drafts for technicians.
    await a.agent.post('/api/v1/knowledge').set(CSRF).send({ title: 'Firewall draft notes' });
    const hits = (await a.agent.get('/api/v1/search?q=firewall')).body.items.filter((h: { kind: string }) => h.kind === 'knowledge');
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ id: entry, href: `/mind/knowledge/${entry}`, status: 'published' });
    await setRole(a.email, a.organizationId, 'viewer');
    expect((await a.agent.get('/api/v1/search?q=firewall')).body.items.filter((h: { kind: string }) => h.kind === 'knowledge').map((h: { id: string }) => h.id)).toEqual([entry]);
    expect((await request(app).get('/api/v1/knowledge')).status).toBe(401);
  });
});

// ── safe markdown ──

describe('knowledge markdown renderer', () => {
  const allText = (blocks: ReturnType<typeof parseMarkdown>): string => JSON.stringify(blocks);
  const links = (src: string) => {
    const found: string[] = [];
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        if (o.type === 'link') found.push(String(o.href));
        Object.values(o).forEach(walk);
      }
    };
    walk(parseMarkdown(src));
    return found;
  };

  it('keeps raw HTML as literal text and only produces known node types', () => {
    const src = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)> **<b>bold</b>**\n- <iframe src="javascript:alert(1)">';
    const blocks = parseMarkdown(src);
    const types = new Set<string>();
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) x.forEach(walk);
      else if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        if (typeof o.type === 'string') types.add(o.type);
        Object.values(o).forEach(walk);
      }
    };
    walk(blocks);
    expect([...types].every((t) => ['heading', 'paragraph', 'list', 'quote', 'code', 'text', 'strong', 'em', 'link'].includes(t))).toBe(true);
    expect(blocks[0]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: '<script>alert(1)</script>' }] });
    expect(allText(blocks)).toContain('<img src=x onerror=alert(1)>');
    expect(links(src)).toEqual([]);
  });

  it('allows only http(s), mailto and in-app links', () => {
    expect(links('[ok](https://example.com/a?b=1) [mail](mailto:it@example.com) [inc](/incidents/123)')).toEqual(['https://example.com/a?b=1', 'mailto:it@example.com', '/incidents/123']);
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      ' javascript:alert(1)',
      'java\tscript:alert(1)',
      'java\nscript:alert(1)',
      'vbscript:msgbox(1)',
      'data:text/html,<script>alert(1)</script>',
      '//evil.example/x',
      '/\\evil.example',
      'https:/\\evil.example',
      'file:///etc/passwd',
      '&#106;avascript:alert(1)',
    ]) {
      expect(safeHref(bad), bad).toBeNull();
      expect(links(`[x](${bad})`), bad).toEqual([]);
    }
    // A rejected link keeps its label as plain text.
    expect(parseMarkdown('[click me](javascript:alert(1))')[0]).toMatchObject({ type: 'paragraph' });
    expect(markdownToText('[click me](javascript:alert(1))')).toContain('click me');
  });

  it('parses the supported subset', () => {
    const blocks = parseMarkdown('# Fix\nRestart **the** _router_ and `ping 10.0.0.1`\n\n1. Unplug\n2. Wait 30 s\n\n> Note\n\n```\n<b>raw</b>\n```\nsnake_case_name stays');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'quote', 'code', 'paragraph']);
    expect(blocks[2]).toMatchObject({ type: 'list', ordered: true, items: [[{ type: 'text', text: 'Unplug' }], [{ type: 'text', text: 'Wait 30 s' }]] });
    expect(blocks[4]).toEqual({ type: 'code', text: '<b>raw</b>' });
    expect(blocks[5]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'snake_case_name stays' }] });
  });

  it('the React view never injects HTML', async () => {
    const view = await readFile(path.join(import.meta.dirname, '../../web/features/knowledge/components/markdown-view.tsx'), 'utf8');
    expect(view).not.toMatch(/dangerouslySetInnerHTML|innerHTML|createContextualFragment|DOMParser/);
  });
});
