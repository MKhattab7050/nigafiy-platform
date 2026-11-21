import type { Request } from 'express';
import { audit } from '../../common/audit.ts';
import { decryptSecret, encryptSecret } from '../../common/crypto.ts';
import { AppError, type AuthContext } from '../../common/http.ts';
import { type Db, systemPool, withTenant } from '../../infrastructure/db.ts';
import { ASSISTANT_MODELS, type AssistantModel, DEFAULT_DAILY_BUDGET, DEFAULT_MODEL, DEFAULT_USER_PER_HOUR, DISCLOSURE_VERSION, type SettingsPatch } from './schema.ts';

// The organization's assistant settings. The API key is sealed (AES-256-GCM) before it is stored,
// decrypted in exactly one place (openApiKey, used to call the provider), and never returned,
// logged or audited — the audit trail only records that it was set or removed.

export interface SettingsRow {
  enabled: boolean;
  api_key_sealed: string | null;
  api_key_updated_at: Date | null;
  model: AssistantModel;
  daily_request_budget: number;
  user_requests_per_hour: number;
  keep_transcripts: boolean;
  disclosure_version: string | null;
  disclosure_accepted_at: Date | null;
  disclosure_accepted_name: string | null;
  last_test_at: Date | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  updated_at: Date | null;
}

const DEFAULTS: SettingsRow = {
  enabled: false,
  api_key_sealed: null,
  api_key_updated_at: null,
  model: DEFAULT_MODEL,
  daily_request_budget: DEFAULT_DAILY_BUDGET,
  user_requests_per_hour: DEFAULT_USER_PER_HOUR,
  keep_transcripts: false,
  disclosure_version: null,
  disclosure_accepted_at: null,
  disclosure_accepted_name: null,
  last_test_at: null,
  last_test_ok: null,
  last_test_error: null,
  updated_at: null,
};

const COLUMNS = `enabled, api_key_sealed, api_key_updated_at, model, daily_request_budget, user_requests_per_hour, keep_transcripts,
  disclosure_version, disclosure_accepted_at, disclosure_accepted_name, last_test_at, last_test_ok, last_test_error, updated_at`;

export async function loadSettings(db: Db, lock = false): Promise<SettingsRow> {
  const row = (await db.query<SettingsRow>(`SELECT ${COLUMNS} FROM assistant_settings${lock ? ' FOR UPDATE' : ''}`)).rows[0];
  return row ?? { ...DEFAULTS };
}

export const disclosureAccepted = (s: SettingsRow) => s.disclosure_version === DISCLOSURE_VERSION && s.disclosure_accepted_at !== null;

/** On, with a key and the current disclosure confirmed: only then does anything leave the network. */
export const isAvailable = (s: SettingsRow) => s.enabled && s.api_key_sealed !== null && disclosureAccepted(s);

export function openApiKey(s: SettingsRow): string {
  if (!s.api_key_sealed) throw new AppError(409, 'assistant_disabled', 'The AI assistant is not configured');
  try {
    return decryptSecret(s.api_key_sealed);
  } catch {
    throw new AppError(409, 'assistant_key_unreadable', 'The stored API key cannot be decrypted (the application key changed). An administrator must enter it again.');
  }
}

/** The administrator's view. The key is write-only: only whether and when it was set. */
export function presentSettings(s: SettingsRow) {
  return {
    enabled: s.enabled,
    available: isAvailable(s),
    api_key: { set: s.api_key_sealed !== null, updated_at: s.api_key_updated_at },
    model: s.model,
    models: ASSISTANT_MODELS,
    daily_request_budget: s.daily_request_budget,
    user_requests_per_hour: s.user_requests_per_hour,
    keep_transcripts: s.keep_transcripts,
    disclosure: {
      current_version: DISCLOSURE_VERSION,
      accepted_version: s.disclosure_version,
      accepted: disclosureAccepted(s),
      accepted_at: s.disclosure_accepted_at,
      accepted_by_name: s.disclosure_accepted_name,
    },
    last_test: s.last_test_at ? { at: s.last_test_at, ok: s.last_test_ok, error: s.last_test_error } : null,
    updated_at: s.updated_at,
  };
}

async function displayName(userId: string): Promise<string> {
  const row = await systemPool.query<{ display_name: string }>(`SELECT display_name FROM users WHERE id = $1`, [userId]);
  return row.rows[0]?.display_name ?? 'Unknown user';
}

export async function updateSettings(req: Request, ctx: AuthContext, patch: SettingsPatch) {
  const name = patch.disclosure_accepted ? await displayName(ctx.userId) : null;
  return withTenant(ctx.organizationId, async (db) => {
    await db.query(`INSERT INTO assistant_settings (organization_id) VALUES ($1) ON CONFLICT (organization_id) DO NOTHING`, [ctx.organizationId]);
    const current = await loadSettings(db, true);
    const next: SettingsRow = { ...current };
    let keyChange: 'set' | 'removed' | null = null;
    if (patch.api_key !== undefined) {
      next.api_key_sealed = patch.api_key === null ? null : encryptSecret(patch.api_key);
      next.api_key_updated_at = patch.api_key === null ? null : new Date();
      keyChange = patch.api_key === null ? 'removed' : 'set';
      // A new key has not been tested yet.
      next.last_test_at = null;
      next.last_test_ok = null;
      next.last_test_error = null;
      if (patch.api_key === null) next.enabled = false;
    }
    if (patch.model !== undefined) next.model = patch.model;
    if (patch.daily_request_budget !== undefined) next.daily_request_budget = patch.daily_request_budget;
    if (patch.user_requests_per_hour !== undefined) next.user_requests_per_hour = patch.user_requests_per_hour;
    if (patch.keep_transcripts !== undefined) next.keep_transcripts = patch.keep_transcripts;
    if (patch.disclosure_accepted) {
      next.disclosure_version = DISCLOSURE_VERSION;
      next.disclosure_accepted_at = new Date();
      next.disclosure_accepted_name = name;
    }
    if (patch.enabled !== undefined) {
      if (patch.enabled && !next.api_key_sealed) throw new AppError(409, 'assistant_key_required', 'Enter your Anthropic API key before turning the assistant on');
      if (patch.enabled && !disclosureAccepted(next)) throw new AppError(409, 'assistant_disclosure_required', 'Confirm what the assistant sends outside your network before turning it on');
      next.enabled = patch.enabled;
    }

    await db.query(
      `UPDATE assistant_settings
          SET enabled = $1, api_key_sealed = $2, api_key_updated_at = $3, model = $4, daily_request_budget = $5, user_requests_per_hour = $6,
              keep_transcripts = $7, disclosure_version = $8, disclosure_accepted_at = $9, disclosure_accepted_name = $10,
              disclosure_accepted_by = CASE WHEN $11 THEN $12::uuid ELSE disclosure_accepted_by END,
              last_test_at = $13, last_test_ok = $14, last_test_error = $15, updated_at = now(), updated_by = $12`,
      [
        next.enabled,
        next.api_key_sealed,
        next.api_key_updated_at,
        next.model,
        next.daily_request_budget,
        next.user_requests_per_hour,
        next.keep_transcripts,
        next.disclosure_version,
        next.disclosure_accepted_at,
        next.disclosure_accepted_name,
        Boolean(patch.disclosure_accepted),
        ctx.userId,
        next.last_test_at,
        next.last_test_ok,
        next.last_test_error,
      ],
    );
    // Turning "keep transcripts" off deletes what was kept: nothing lingers that the setting says is not stored.
    let transcriptsDeleted = 0;
    if (current.keep_transcripts && !next.keep_transcripts) transcriptsDeleted = (await db.query(`DELETE FROM assistant_conversations`)).rowCount ?? 0;

    await audit(db, req, 'assistant.settings_updated', { type: 'assistant_settings', id: ctx.organizationId }, {
      fields: Object.keys(patch),
      ...(keyChange ? { api_key: keyChange } : {}),
      enabled: next.enabled,
      model: next.model,
      daily_request_budget: next.daily_request_budget,
      user_requests_per_hour: next.user_requests_per_hour,
      keep_transcripts: next.keep_transcripts,
      ...(patch.disclosure_accepted ? { disclosure_version: DISCLOSURE_VERSION } : {}),
      ...(transcriptsDeleted ? { transcripts_deleted: transcriptsDeleted } : {}),
    });
    return presentSettings(await loadSettings(db));
  });
}

export async function recordTest(db: Db, ok: boolean, error: string | null) {
  await db.query(`UPDATE assistant_settings SET last_test_at = now(), last_test_ok = $1, last_test_error = $2`, [ok, error]);
}
