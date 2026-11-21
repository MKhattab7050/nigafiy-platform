import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PROGRAMS, type PlatformProgramsResponse } from '@lan-detective/shared-types/programs';
import { Router } from 'express';
import { auth, requireRole } from '../../common/http.ts';
import { env } from '../../config/env.ts';
import { defineModule } from '../../infrastructure/module.ts';
import { engineStatus } from './engine.ts';
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

router.get('/platform/engine', async (req, res) => {
  auth(req);
  res.json(await engineStatus());
});

router.get('/platform/updates', async (req, res) => {
  auth(req);
  res.json(await cachedUpdateCheck(configuredSource(VERSION)));
});

router.post('/platform/updates/check', requireRole('admin'), async (_req, res) => {
  res.json(await cachedUpdateCheck(configuredSource(VERSION), true));
});

export const platformModule = defineModule({ name: 'platform', api: router });
