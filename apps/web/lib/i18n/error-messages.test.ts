// API error codes → plain sentences in English and Arabic (lib/i18n/error-messages.ts).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ERROR_MESSAGES, ERROR_PREFIXES, ERROR_UI, errorMessage, errorTechnicalDetails, errorTextFor, statusFallback } from './error-messages.ts';

const ARABIC = /[؀-ۿ]/;
const here = path.dirname(fileURLToPath(import.meta.url));
const apiSrc = path.resolve(here, '../../../api/src');

/** Every literal code thrown with `new AppError(status, 'code', …)` in the API. */
function apiCodes(): string[] {
  const codes = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) {
        for (const m of readFileSync(p, 'utf8').matchAll(/new AppError\(\s*[^,]+,\s*'([a-z0-9_]+)'/g)) codes.add(m[1] as string);
      }
    }
  };
  walk(apiSrc);
  return [...codes].sort();
}

describe('error messages', () => {
  it('has a non-empty English and Arabic sentence for every code, family and label', () => {
    const all = [...Object.entries(ERROR_MESSAGES), ...ERROR_PREFIXES.map(([p, t]) => [`${p}*`, t] as const), ...Object.entries(ERROR_UI)];
    for (const [code, text] of all) {
      assert.ok(text.en.trim(), `en ${code} is empty`);
      assert.ok(text.ar.trim(), `ar ${code} is empty`);
      assert.ok(ARABIC.test(text.ar), `ar ${code} has no Arabic`);
      assert.ok(!ARABIC.test(text.en), `en ${code} has Arabic`);
    }
  });

  it('has no developer wording in the sentences', () => {
    for (const [code, text] of Object.entries(ERROR_MESSAGES)) {
      for (const s of [text.en, text.ar]) {
        assert.ok(!/[{}[\]`]|\b[a-z]+_[a-z_]+\b/.test(s), `${code}: "${s}" looks technical`);
      }
    }
  });

  it('covers every code the API throws (exact or by family, not just by HTTP status)', () => {
    const codes = apiCodes();
    assert.ok(codes.length > 150, `found only ${codes.length} API codes: is ${apiSrc} right?`);
    const missing = codes.filter((c) => !(c in ERROR_MESSAGES) && !ERROR_PREFIXES.some(([p]) => c.startsWith(p)));
    assert.deepEqual(missing, [], 'API codes with no sentence');
  });

  it('falls back by HTTP status for an unknown code, never to the raw message or JSON', () => {
    const raw = '{"error":{"code":"weird","details":[{"path":"body.port"}]}}';
    for (const status of [0, 400, 401, 403, 404, 409, 410, 413, 418, 423, 429, 500, 502, 503, 504]) {
      for (const locale of ['en', 'ar'] as const) {
        const text = errorMessage({ status, code: 'totally_unknown_code_xyz', message: raw }, locale);
        assert.ok(text.trim(), `${status} ${locale} empty`);
        assert.ok(!text.includes('{') && !text.includes('body.port') && !text.includes('totally_unknown'), `${status} ${locale} leaks: ${text}`);
        assert.equal(text, statusFallback(status)[locale]);
      }
    }
    assert.equal(errorMessage({ message: raw }, 'ar'), statusFallback(0).ar);
  });

  it('words a validation error plainly and keeps the field paths for Details', () => {
    const err = { status: 400, code: 'validation_error', message: 'The request is invalid', details: [{ path: 'body.port', message: 'Too big' }], requestId: 'req-1' };
    assert.equal(errorMessage(err, 'ar'), ERROR_MESSAGES.validation_error?.ar);
    const rows = errorTechnicalDetails(err, 'en').map(([, v]) => v);
    assert.deepEqual(rows, ['validation_error', '400', 'The request is invalid', 'body.port: Too big', 'req-1']);
  });

  it('matches code families built at run time', () => {
    assert.equal(errorTextFor('backup_host_key_changed', 409), ERROR_PREFIXES.find(([p]) => p === 'backup_')?.[1]);
    assert.equal(errorTextFor('router_login_paused', 409), ERROR_PREFIXES.find(([p]) => p === 'router_')?.[1]);
    assert.equal(errorTextFor('profile_forbids_audio', 403), ERROR_PREFIXES.find(([p]) => p === 'profile_forbids_')?.[1]);
  });
});
