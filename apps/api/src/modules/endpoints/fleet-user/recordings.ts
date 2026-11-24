import { Router } from 'express';
import { z } from 'zod';
import { randomToken, sha256 } from '../../../common/crypto.ts';
import { AppError, notFound, parse } from '../../../common/http.ts';
import { type Db, withSystem, withTenant } from '../../../infrastructure/db.ts';
import { listSegments, readSegmentForPlayback } from '../remote-desktop/recording.ts';
import type { EndpointContext } from '../schema.ts';

// The user's side (Fleet Pro, migration 043): "Past recordings…" in the tray of a computer whose
// Fleet group allows it (fleet_groups.user_may_view_recordings). The agent lists the recordings of
// its own computer; the person picks one and the tray opens a short-lived link to a player page.
// The link's token is stored only as its SHA-256; it opens for 15 minutes and, once opened, plays
// for 4 hours. Every link and its first use are audited. Nothing here can reach another computer.

const OPEN_MINUTES = 15;
const PLAY_HOURS = 4;

async function allowed(db: Db, endpointId: string): Promise<boolean> {
  const r = await db.query<{ may: boolean | null }>(
    `SELECT g.user_may_view_recordings AS may FROM endpoints e LEFT JOIN fleet_groups g ON g.id = e.fleet_group_id WHERE e.id = $1`,
    [endpointId],
  );
  return r.rows[0]?.may === true;
}

/** Heartbeat: whether the tray shows "Past recordings…". */
export async function trayFlags(db: Db, endpointId: string): Promise<{ recordings: boolean }> {
  return { recordings: await allowed(db, endpointId) };
}

export interface UserRecording {
  id: string;
  started_at: string;
  ended_at: string | null;
  operator: string | null;
  reason: string | null;
}

/** POST /agent/recordings: this computer's recordings, when its group allows the person to watch them. */
export async function agentRecordings(ep: EndpointContext): Promise<{ allowed: boolean; recordings: UserRecording[] }> {
  return withTenant(ep.organizationId, async (db) => {
    if (!(await allowed(db, ep.id))) return { allowed: false, recordings: [] };
    const rows = (
      await db.query<{ id: string; started_at: Date; ended_at: Date | null; operator: string | null; reason: string | null }>(
        `SELECT r.id, r.started_at, r.ended_at, coalesce(s.operator_email, r.started_by_email) AS operator, s.reason
           FROM fleet_recordings r JOIN fleet_sessions s ON s.id = r.fleet_session_id
          WHERE r.endpoint_id = $1 AND r.state IN ('complete', 'recording', 'failed') AND r.segments > 0
          ORDER BY r.started_at DESC LIMIT 20`,
        [ep.id],
      )
    ).rows;
    return { allowed: true, recordings: rows.map((r) => ({ ...r, started_at: r.started_at.toISOString(), ended_at: r.ended_at ? r.ended_at.toISOString() : null })) };
  });
}

export const recordingLinkSchema = z
  .object({
    recording_id: z.uuid(),
    // The Windows / Unix account that asked (shown in the audit; never trusted for access).
    user: z.string().trim().max(120).optional(),
  })
  .strict();

/** POST /agent/recordings/link: a short-lived link to one recording of this computer. */
export async function agentRecordingLink(ep: EndpointContext, body: z.infer<typeof recordingLinkSchema>): Promise<{ path: string; expires_at: string }> {
  return withTenant(ep.organizationId, async (db) => {
    if (!(await allowed(db, ep.id))) throw new AppError(403, 'recordings_not_allowed', 'This computer’s group does not let the person watch recordings');
    const rec = (await db.query(`SELECT 1 FROM fleet_recordings WHERE id = $1 AND endpoint_id = $2 AND state <> 'deleted'`, [body.recording_id, ep.id])).rows[0];
    if (!rec) throw notFound('Recording');
    const token = randomToken(32);
    const expires = new Date(Date.now() + OPEN_MINUTES * 60_000);
    await db.query(
      `INSERT INTO fleet_recording_user_links (token_hash, organization_id, recording_id, endpoint_id, requested_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [sha256(token), ep.organizationId, body.recording_id, ep.id, body.user || null, expires],
    );
    await db.query(
      `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor)
       VALUES ($1, NULL, NULL, 'fleet.recording_user_link', 'endpoint', $2, $3, 'system')`,
      [ep.organizationId, ep.id, JSON.stringify({ recording_id: body.recording_id, user: body.user || null, expires_at: expires.toISOString(), source: 'tray' })],
    );
    return { path: `/recording-view/${token}`, expires_at: expires.toISOString() };
  });
}

interface LinkRow {
  organization_id: string;
  recording_id: string;
  endpoint_id: string;
  first_used_at: Date | null;
  usable: boolean;
}

async function byToken(token: string): Promise<LinkRow> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw notFound('Recording link');
  const row = await withSystem(
    async (db) =>
      (
        await db.query<LinkRow>(
          `SELECT organization_id, recording_id, endpoint_id, first_used_at,
                  (expires_at > now() OR (first_used_at IS NOT NULL AND first_used_at > now() - make_interval(hours => $2))) AS usable
             FROM fleet_recording_user_links WHERE token_hash = $1`,
          [sha256(token), PLAY_HOURS],
        )
      ).rows[0],
  );
  if (!row?.usable) throw new AppError(410, 'link_expired', 'This recording link has expired. Open “Past recordings…” from the Nigafiy icon again.');
  return row;
}

/** The public router: the player page reads the recording through the token only. */
export const recordingLinksRouter: Router = Router();

recordingLinksRouter.get('/:token', async (req, res) => {
  const { token } = parse(z.object({ token: z.string().max(100) }), req.params);
  const link = await byToken(token);
  const out = await withTenant(link.organization_id, async (db) => {
    // Still allowed (the group may have changed since the link was made) and still kept.
    if (!(await allowed(db, link.endpoint_id))) throw new AppError(403, 'recordings_not_allowed', 'Watching recordings is no longer allowed on this computer');
    const rec = (
      await db.query<{ id: string; state: string; started_at: Date; ended_at: Date | null; operator: string | null; reason: string | null; endpoint_name: string }>(
        `SELECT r.id, r.state, r.started_at, r.ended_at, coalesce(s.operator_email, r.started_by_email) AS operator, s.reason, e.name AS endpoint_name
           FROM fleet_recordings r JOIN fleet_sessions s ON s.id = r.fleet_session_id JOIN endpoints e ON e.id = r.endpoint_id
          WHERE r.id = $1 AND r.state <> 'deleted'`,
        [link.recording_id],
      )
    ).rows[0];
    if (!rec) throw notFound('Recording');
    if (!link.first_used_at) {
      await db.query(`UPDATE fleet_recording_user_links SET first_used_at = now() WHERE token_hash = $1 AND first_used_at IS NULL`, [sha256(token)]);
      await db.query(
        `INSERT INTO audit_logs (organization_id, user_id, user_email, action, target_type, target_id, metadata, actor, ip)
         VALUES ($1, NULL, NULL, 'fleet.recording_viewed_by_user', 'endpoint', $2, $3, 'system', $4)`,
        [link.organization_id, link.endpoint_id, JSON.stringify({ recording_id: rec.id, source: 'tray_link' }), req.ip ?? null],
      );
    }
    return { recording: { ...rec, started_at: rec.started_at.toISOString(), ended_at: rec.ended_at ? rec.ended_at.toISOString() : null }, segments: listSegments(link.organization_id, rec.id) };
  });
  res.setHeader('Cache-Control', 'no-store');
  res.json(out);
});

recordingLinksRouter.get('/:token/segments/:name', async (req, res) => {
  const { token, name } = parse(z.object({ token: z.string().max(100), name: z.string().regex(/^seg-\d{13}\.nrec$/) }), req.params);
  const link = await byToken(token);
  if (!link.first_used_at) throw new AppError(409, 'link_not_opened', 'Open the recording page first');
  await withTenant(link.organization_id, async (db) => {
    if (!(await allowed(db, link.endpoint_id))) throw new AppError(403, 'recordings_not_allowed', 'Watching recordings is no longer allowed on this computer');
  });
  const out = await readSegmentForPlayback(link.organization_id, link.recording_id, name);
  if (!out) throw notFound('Recording part');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Nigafiy-Records', String(out.records));
  if (out.error) res.setHeader('X-Nigafiy-Segment-Error', out.error);
  res.send(out.body);
});
