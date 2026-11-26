import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROGRAMS, type PlatformProgramsResponse, type PlatformUpdatesResponse } from '@nigafiy/shared-types/programs';
import { Router } from 'express';
import { z } from 'zod';
import { audit, auditSystem } from '../../common/audit.ts';
import { auth, parse, requireRole } from '../../common/http.ts';
import { env, ownLanAddresses } from '../../config/env.ts';
import { defineModule } from '../../infrastructure/module.ts';
import { withTenant } from '../../infrastructure/db.ts';
import { logger } from '../../infrastructure/logger.ts';
import { engineStatus } from './engine.ts';
import { configuredEngine, configuredUpdate, installStatus, managedElsewhere, prepareDownload, refuseIfMsiManaged, requestInstall, startDownload } from './install.ts';
import { cachedUpdateCheck, configuredSource } from './updates.ts';

/**
 * The Nigafiy platform layer (spec §6): which programs exist and are installed, the local engine's
 * health, and the update check. Read by the Hub home and, from Milestone 4, by every program shell
 * and the shared device card.
 *
 *   GET  /platform/programs        any role
 *   GET  /platform/engine          any role (no secrets: states, restarts, last errors)
 *   GET  /platform/updates         any role (cached)
 *   POST /platform/updates/check   admin (re-check now)
 *   GET  /platform/updates/install any role (download progress, staged update, last installation)
 *   POST /platform/updates/download admin (download, verify and stage the newer signed release)
 *   POST /platform/updates/install  admin, body { version, confirm: true } (hand the staged
 *                                   installer to the engine; never happens without this request)
 *
 * An installation the engine reports as MSI-managed (Windows Installer, deployed by GPO/Intune) is
 * updated by its administrator: the check answers `msi_managed`, download and install are refused.
 * The Microsoft Store package (MSIX) is updated by the Store: `store_managed`, refused the same way.
 */
const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../../../package.json'), 'utf8')).version ?? '0.0.0');
  } catch {
    return '0.0.0';
  }
})();

const router: Router = Router();

/**
 * Programs this install offers, from NIGAFIY_PROGRAMS ("all" by default). Hub is always there: it is
 * the engine's own UI. `bundled` = part of this single install; Milestone 5's per-program installers
 * will register as `installed`.
 */
export function installedPrograms(setting: string = env.NIGAFIY_PROGRAMS): PlatformProgramsResponse {
  const wanted = setting === 'all' ? null : new Set(setting.split(',').map((id) => id.trim()));
  return {
    items: PROGRAMS.map((p) => {
      const installed = p.id === 'hub' || !wanted || wanted.has(p.id);
      return { ...p, installed, install_source: installed ? 'bundled' : null };
    }),
  };
}

router.get('/platform/programs', (req, res) => {
  auth(req);
  res.json(installedPrograms());
});

/**
 * Addresses a phone on the same network can open this web app at: WEB_ORIGIN's scheme and port on each
 * of this machine's LAN IPv4 addresses, kept only when the web app actually answers there (a web
 * server bound to 127.0.0.1 does not, and then the list is empty). Shown as a QR code in the app.
 */
export async function phoneUrls(webOrigin: string = env.WEB_ORIGIN, addrs: Iterable<string> = ownLanAddresses()): Promise<string[]> {
  let w: URL;
  try {
    w = new URL(webOrigin);
  } catch {
    return [];
  }
  const candidates = [...addrs].filter((a) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a)).map((a) => `${w.protocol}//${a}${w.port ? `:${w.port}` : ''}`);
  const answers = await Promise.all(
    candidates.map(async (url) => {
      try {
        const res = await fetch(`${url}/`, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(1500) });
        return res.status < 500 ? url : null;
      } catch {
        return null;
      }
    }),
  );
  return answers.filter((u): u is string => u !== null);
}

router.get('/platform/phone-access', async (req, res) => {
  auth(req);
  res.json({ urls: await phoneUrls() });
});

router.get('/platform/engine', async (req, res) => {
  auth(req);
  res.json(await engineStatus());
});

/** The update check, or `msi_managed` / `store_managed` when the administrator or the Microsoft Store updates this installation. */
async function updateCheck(force: boolean): Promise<PlatformUpdatesResponse> {
  const elsewhere = await managedElsewhere(configuredEngine());
  if (elsewhere) return { configured: false, reason: elsewhere, current_version: VERSION };
  return cachedUpdateCheck(configuredSource(VERSION), force);
}

router.get('/platform/updates', async (req, res) => {
  auth(req);
  res.json(await updateCheck(false));
});

router.post('/platform/updates/check', requireRole('admin'), async (_req, res) => {
  res.json(await updateCheck(true));
});

router.get('/platform/updates/install', async (req, res) => {
  auth(req);
  res.json(await installStatus(configuredUpdate(VERSION), configuredEngine()));
});

router.post('/platform/updates/download', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const cfg = configuredUpdate(VERSION);
  try {
    await refuseIfMsiManaged(configuredEngine());
  } catch (err) {
    await withTenant(ctx.organizationId, (db) => audit(db, req, 'platform.update.download_refused', { type: 'update', id: (err as { code?: string }).code === 'store_managed' ? 'msix' : 'msi' }, { error: (err as Error).message.slice(0, 500) }));
    throw err;
  }
  const release = await prepareDownload(cfg);
  await withTenant(ctx.organizationId, (db) =>
    audit(db, req, 'platform.update.download_started', { type: 'update', id: release.payload.version }, { version: release.payload.version, component: release.component.id, size: release.component.size, sha256: release.component.sha256 }),
  );
  void startDownload(cfg, release, ctx.userEmail, (r) => {
    // The outcome is audited in the same organization once the download is over.
    void withTenant(ctx.organizationId, (db) =>
      auditSystem(db, ctx.organizationId, {
        automation: 'platform.update',
        action: r.ok ? 'platform.update.staged' : 'platform.update.download_failed',
        target: { type: 'update', id: release.payload.version },
        metadata: { version: release.payload.version, requested_by: ctx.userEmail, ...(r.error ? { error: r.error } : {}) },
      }),
    ).catch((err) => logger.warn({ err: (err as Error).message }, 'could not audit the update download'));
  });
  res.status(202).json(await installStatus(cfg, configuredEngine()));
});

const installBody = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), confirm: z.literal(true) });

router.post('/platform/updates/install', requireRole('admin'), async (req, res) => {
  const ctx = auth(req);
  const body = parse(installBody, req.body);
  const cfg = configuredUpdate(VERSION);
  try {
    await requestInstall(body.version, cfg.dir, configuredEngine());
  } catch (err) {
    await withTenant(ctx.organizationId, (db) =>
      audit(db, req, 'platform.update.install_refused', { type: 'update', id: body.version }, { version: body.version, error: (err as Error).message.slice(0, 500) }),
    );
    throw err;
  }
  await withTenant(ctx.organizationId, (db) => audit(db, req, 'platform.update.install_requested', { type: 'update', id: body.version }, { version: body.version }));
  res.status(202).json({ ok: true, version: body.version });
});

export const platformModule = defineModule({ name: 'platform', api: router });
