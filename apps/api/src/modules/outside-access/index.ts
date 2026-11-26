import { Router } from 'express';
import { z } from 'zod';
import { audit } from '../../common/audit.ts';
import { AppError, auth, parse, requireRole } from '../../common/http.ts';
import { env, setRuntimeWebOrigins } from '../../config/env.ts';
import { withSystem, withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { defineModule } from '../../infrastructure/module.ts';
import { cloudflaredState, serveArgs, tailscaleServe, tailscaleState } from './detect.ts';

/**
 * Access from outside home (UX review 2026-11-26, item 18; migration 061).
 *
 * The web app of an installed copy listens on 127.0.0.1. Away from home the owner reaches it through
 * a private tunnel that THEY install and sign in to — never an opened router port, never software
 * this app downloads:
 *  * Tailscale (recommended): `tailscale serve` publishes https://<pc>.<tailnet>.ts.net to their own
 *    tailnet only (Serve, not Funnel), with a real certificate. The app can run that one command when
 *    the owner presses "Turn on".
 *  * Cloudflare Tunnel: the owner runs cloudflared with their Cloudflare account and a hostname of
 *    theirs (ideally behind Cloudflare Access); the app only detects cloudflared and accepts the hostname.
 * Either way the browser sends the tunnel's origin, which the CSRF Origin check must accept: those
 * origins live in web_origins and are mirrored into isWebOrigin (setRuntimeWebOrigins).
 *
 * Safety rules:
 *  * owner only, and only on a server with one organization (OUTSIDE_ACCESS_SETUP=auto; "on" / "off"
 *    override), because an accepted origin applies to the whole server;
 *  * refused while anyone can still create an account (ALLOW_REGISTRATION=true, or "first" before the
 *    owner exists): the address would put a sign-up form on the tailnet or the internet;
 *  * https origins with a host name only (no IP literal, no localhost, no path); a Tailscale origin
 *    must be this PC's own MagicDNS name.
 *
 *   GET  /outside-access                 admin: what is installed, the tunnel's address, accepted origins
 *   POST /outside-access/tailscale/serve owner, { on: boolean, confirm: true }: Serve on (and accept its origin) or off
 *   POST /outside-access/origins         owner, { origin, kind }: accept a tunnel's origin
 *   POST /outside-access/origins/remove  owner, { origin }: stop accepting it
 */

const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:[0-9]{1,5})?$/;

/** The local port of the web app (WEB_ORIGIN's), the one a tunnel forwards to. */
export function webPort(webOrigin: string = env.WEB_ORIGIN): number {
  try {
    const u = new URL(webOrigin);
    return Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  } catch {
    return 3100;
  }
}

/** A browser origin a tunnel may give: https, a dotted host name (no IP, no localhost), optional port, nothing else. */
export function normalizeOrigin(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  const origin = u.origin.toLowerCase();
  if (!ORIGIN_RE.test(origin)) return null;
  const host = u.hostname;
  if (/^\d+(\.\d+){3}$/.test(host) || host === 'localhost' || host.endsWith('.localhost')) return null;
  return origin;
}

async function registrationOpen(): Promise<boolean> {
  if (env.ALLOW_REGISTRATION === 'first') return !(await withSystem((db) => db.query(`SELECT 1 FROM users LIMIT 1`))).rowCount;
  return env.ALLOW_REGISTRATION === 'true';
}

/** Why the setup is not offered here, or null when it is. */
async function setupBlocked(): Promise<'disabled' | 'multi_tenant' | null> {
  if (env.OUTSIDE_ACCESS_SETUP === 'off') return 'disabled';
  if (env.OUTSIDE_ACCESS_SETUP === 'on') return null;
  const orgs = await withSystem((db) => db.query<{ n: number }>(`SELECT count(*)::int AS n FROM organizations`));
  return (orgs.rows[0]?.n ?? 0) > 1 ? 'multi_tenant' : null;
}

/** Reloads the accepted origins into the CSRF check. */
export async function refreshOutsideOrigins(): Promise<string[]> {
  const rows = await withSystem((db) => db.query<{ origin: string }>(`SELECT origin FROM web_origins ORDER BY created_at`));
  const list = rows.rows.map((r) => r.origin);
  setRuntimeWebOrigins(list);
  return list;
}

async function listOrigins(): Promise<{ origin: string; kind: string; created_at: string }[]> {
  const rows = await withSystem((db) => db.query<{ origin: string; kind: string; created_at: Date }>(`SELECT origin, kind, created_at FROM web_origins ORDER BY created_at`));
  return rows.rows.map((r) => ({ origin: r.origin, kind: r.kind, created_at: r.created_at.toISOString() }));
}

const router: Router = Router();

router.get('/outside-access', requireRole('admin'), async (_req, res) => {
  const port = webPort();
  const [tailscale, cloudflared, origins, blocked, signUpOpen] = await Promise.all([tailscaleState(port), cloudflaredState(), listOrigins(), setupBlocked(), registrationOpen()]);
  res.json({
    available: blocked === null,
    blocked_reason: blocked,
    registration_open: signUpOpen,
    web_port: port,
    local_target: `http://127.0.0.1:${port}`,
    serve_command: `tailscale ${serveArgs(port).join(' ')}`,
    tailscale: { ...tailscale, origin_accepted: tailscale.origin ? origins.some((o) => o.origin === tailscale.origin) : false },
    cloudflared,
    origins,
  });
});

/** The checks every change goes through: owner, setup offered here, nobody can sign up. */
async function assertMayChange(): Promise<void> {
  const blocked = await setupBlocked();
  if (blocked) {
    throw new AppError(
      403,
      'outside_access_unavailable',
      blocked === 'disabled' ? 'Access from outside is turned off on this server (OUTSIDE_ACCESS_SETUP=off)' : 'This server has several organizations; its administrator sets WEB_EXTRA_ORIGINS instead',
    );
  }
  if (await registrationOpen()) {
    throw new AppError(409, 'registration_open', 'Anyone can still create an account on this server. Close sign-up (ALLOW_REGISTRATION=first or false) before opening it from outside.');
  }
}

async function acceptOrigin(organizationId: string, userId: string, origin: string, kind: 'tailscale' | 'cloudflare' | 'custom'): Promise<boolean> {
  const r = await withSystem((db) =>
    db.query(`INSERT INTO web_origins (origin, kind, organization_id, added_by) VALUES ($1,$2,$3,$4) ON CONFLICT (origin) DO NOTHING`, [origin, kind, organizationId, userId]),
  );
  await refreshOutsideOrigins();
  return Boolean(r.rowCount);
}

const serveBody = z.object({ on: z.boolean(), confirm: z.literal(true) });

router.post('/outside-access/tailscale/serve', requireRole('owner'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(serveBody, req.body);
  const port = webPort();
  if (body.on) await assertMayChange();
  const before = await tailscaleState(port);
  if (!before.installed) throw new AppError(409, 'tailscale_missing', 'Tailscale is not installed on this computer');
  if (body.on && (before.state !== 'Running' || !before.origin)) {
    throw new AppError(409, 'tailscale_not_ready', 'Sign in to Tailscale on this computer and turn on MagicDNS first');
  }
  const result = await tailscaleServe(body.on, port);
  let accepted = false;
  if (result.ok && body.on && before.origin) accepted = await acceptOrigin(ctx.organizationId, ctx.userId, before.origin, 'tailscale');
  if (result.ok && !body.on && before.origin) {
    await withSystem((db) => db.query(`DELETE FROM web_origins WHERE origin = $1 AND kind = 'tailscale'`, [before.origin]));
    await refreshOutsideOrigins();
  }
  await withTenant(ctx.organizationId, (db) =>
    audit(db, req, body.on ? 'outside_access.tailscale.serve_on' : 'outside_access.tailscale.serve_off', { type: 'web_origin', id: before.origin }, { ok: result.ok, port, accepted }),
  );
  // 200 either way: ok=false carries Tailscale's own answer (e.g. the link to enable HTTPS) for the page to show.
  res.json({ ok: result.ok, output: result.output, origin: before.origin, tailscale: await tailscaleState(port) });
});

const originBody = z.object({ origin: z.string().max(300), kind: z.enum(['tailscale', 'cloudflare', 'custom']) });

router.post('/outside-access/origins', requireRole('owner'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(originBody, req.body);
  await assertMayChange();
  const origin = normalizeOrigin(body.origin);
  if (!origin) throw new AppError(400, 'invalid_origin', 'Use the https address of the tunnel, like https://nigafiy.example.com (a name, not an IP address, and no path)');
  if (origin === env.WEB_ORIGIN.toLowerCase()) throw new AppError(409, 'origin_exists', 'This is already the address of the app');
  if (body.kind === 'tailscale') {
    const ts = await tailscaleState(webPort());
    if (!ts.origin || ts.origin !== origin) throw new AppError(400, 'invalid_origin', "A Tailscale address must be this computer's own name on the tailnet");
  }
  const added = await acceptOrigin(ctx.organizationId, ctx.userId, origin, body.kind);
  await withTenant(ctx.organizationId, (db) => audit(db, req, 'outside_access.origin_added', { type: 'web_origin', id: origin }, { kind: body.kind, added }));
  res.status(added ? 201 : 200).json({ origin, kind: body.kind, origins: await listOrigins() });
});

const removeBody = z.object({ origin: z.string().max(300) });

router.post('/outside-access/origins/remove', requireRole('owner'), async (req, res) => {
  const ctx = auth(req);
  const { origin } = parse(removeBody, req.body);
  // Removing is always allowed (it only narrows what the server accepts).
  if ((await setupBlocked()) === 'multi_tenant') throw new AppError(403, 'outside_access_unavailable', 'This server has several organizations; its administrator manages WEB_EXTRA_ORIGINS');
  const r = await withSystem((db) => db.query(`DELETE FROM web_origins WHERE origin = $1`, [origin.trim().toLowerCase()]));
  await refreshOutsideOrigins();
  await withTenant(ctx.organizationId, (db) => audit(db, req, 'outside_access.origin_removed', { type: 'web_origin', id: origin }, { removed: Boolean(r.rowCount) }));
  res.json({ removed: Boolean(r.rowCount), origins: await listOrigins() });
});

let timer: NodeJS.Timeout | undefined;

export const outsideAccessModule = defineModule({
  name: 'outside-access',
  api: router,
  lifecycle: {
    // Load the accepted origins at start, then every 30 s (another API instance may have changed them).
    start: async () => {
      await refreshOutsideOrigins().catch((err) => logger.warn({ err: (err as Error).message }, 'could not load the outside-access origins'));
      timer = setInterval(() => void refreshOutsideOrigins().catch(() => undefined), 30_000);
      timer.unref();
    },
    stop: async () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  },
});
