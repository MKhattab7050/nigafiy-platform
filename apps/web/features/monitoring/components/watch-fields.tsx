'use client';

import type { CheckKind, MonitoringCheck, SnmpCheckPreset, SnmpComparison, SnmpPresetEntry, SwitchSummary } from '@lan-detective/shared-types';
import { Field, Input, Select } from '@/components/ui';
import { qs } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { type Key, useI18n } from '@/lib/i18n';

/** The watch kinds (application-level checks) next to ping / TCP / DNS. */
export const WATCH_KINDS = ['http', 'https', 'tls_expiry', 'snmp_oid'] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];
export const isWatchKind = (k: CheckKind): k is WatchKind => (WATCH_KINDS as readonly string[]).includes(k);

type BodyChoice = 'none' | 'contain' | 'regex' | 'notContain' | 'notRegex';

/** Form state of a watch check's settings: strings for inputs, converted by buildWatch. */
export interface WatchDraft {
  url: string;
  path: string;
  method: 'GET' | 'HEAD';
  statusMin: string;
  statusMax: string;
  body: BodyChoice;
  bodyPattern: string;
  followRedirects: boolean;
  maxRedirects: string;
  tlsVerify: boolean;
  pin: string;
  allowPublic: boolean;
  sni: string;
  warnDays: string;
  criticalDays: string;
  snmpTargetId: string;
  preset: SnmpCheckPreset;
  index: string;
  oid: string;
  ratioOid: string;
  scale: string;
  comparison: SnmpComparison;
  warn: string;
  critical: string;
  unit: string;
}

export function emptyDraft(): WatchDraft {
  return {
    url: '',
    path: '/',
    method: 'GET',
    statusMin: '200',
    statusMax: '299',
    body: 'none',
    bodyPattern: '',
    followRedirects: true,
    maxRedirects: '5',
    tlsVerify: true,
    pin: '',
    allowPublic: false,
    sni: '',
    warnDays: '30',
    criticalDays: '7',
    snmpTargetId: '',
    preset: 'custom',
    index: '1',
    oid: '',
    ratioOid: '',
    scale: '1',
    comparison: 'gt',
    warn: '',
    critical: '',
    unit: '',
  };
}

const str = (v: unknown, fallback = '') => (v === null || v === undefined ? fallback : String(v));

/** The draft of an existing check (edit form). */
export function draftFromCheck(c: MonitoringCheck): WatchDraft {
  const d = emptyDraft();
  const cfg = c.config;
  const body = cfg.body_match;
  return {
    ...d,
    path: str(cfg.path, '/'),
    method: cfg.method ?? 'GET',
    statusMin: str(cfg.expect_status?.min, '200'),
    statusMax: str(cfg.expect_status?.max, '299'),
    body: !body ? 'none' : body.mode === 'regex' ? (body.negate ? 'notRegex' : 'regex') : body.negate ? 'notContain' : 'contain',
    bodyPattern: body?.pattern ?? '',
    followRedirects: cfg.follow_redirects ?? true,
    maxRedirects: str(cfg.max_redirects, '5'),
    tlsVerify: cfg.tls_verify ?? true,
    pin: str(cfg.pin_sha256),
    allowPublic: cfg.allow_public ?? false,
    sni: str(cfg.sni),
    warnDays: str(cfg.warn_days, '30'),
    criticalDays: str(cfg.critical_days, '7'),
    snmpTargetId: c.snmp_target_id ?? '',
    preset: cfg.preset ?? 'custom',
    oid: str(cfg.oid),
    ratioOid: str(cfg.ratio_oid),
    scale: str(cfg.scale, '1'),
    comparison: cfg.comparison ?? 'gt',
    warn: str(cfg.warn),
    critical: str(cfg.critical),
    unit: str(cfg.unit),
  };
}

export interface ParsedUrl {
  kind: 'http' | 'https';
  host: string;
  port: number | null;
  path: string;
}

/** Splits a typed URL into what the API stores (kind from the scheme, host, port, path). */
export function parseCheckUrl(raw: string, fallback: 'http' | 'https'): ParsedUrl | null {
  const text = raw.trim();
  if (!text) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `${fallback}://${text}`);
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname || u.username || u.password) return null;
    return { kind: u.protocol === 'https:' ? 'https' : 'http', host: u.hostname.replace(/^\[|\]$/g, ''), port: u.port ? Number(u.port) : null, path: `${u.pathname || '/'}${u.search}` };
  } catch {
    return null;
  }
}

const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

/** The config object the API validates for this kind (modules/monitoring/kinds.ts). */
export function buildConfig(kind: WatchKind, d: WatchDraft, path: string): Record<string, unknown> {
  if (kind === 'http' || kind === 'https') {
    const body =
      d.body === 'none' || !d.bodyPattern
        ? null
        : { mode: d.body === 'regex' || d.body === 'notRegex' ? 'regex' : 'substring', pattern: d.bodyPattern, negate: d.body === 'notContain' || d.body === 'notRegex' };
    return {
      path: path || '/',
      method: d.method,
      expect_status: { min: Number(d.statusMin), max: Number(d.statusMax) },
      body_match: d.method === 'HEAD' ? null : body,
      follow_redirects: d.followRedirects,
      max_redirects: Number(d.maxRedirects),
      allow_public: d.allowPublic,
      ...(kind === 'https' ? { tls_verify: d.tlsVerify, pin_sha256: d.pin.trim() || null } : {}),
    };
  }
  if (kind === 'tls_expiry') {
    return { sni: d.sni.trim() || null, warn_days: Number(d.warnDays), critical_days: Number(d.criticalDays), allow_public: d.allowPublic };
  }
  return {
    preset: d.preset,
    oid: d.oid.trim(),
    ratio_oid: d.ratioOid.trim() || null,
    scale: Number(d.scale || '1'),
    comparison: d.comparison,
    warn: numOrNull(d.warn),
    critical: numOrNull(d.critical),
    unit: d.unit.trim(),
  };
}

function Check({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-start gap-2 text-[13px]">
      <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="mt-0.5 block text-xs text-faint">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * The settings of one watch kind. `mode: 'create'` asks for the URL / device; `mode: 'edit'` keeps
 * kind, host, port and device as created (as the API does) and edits everything else.
 */
export function WatchFields({
  kind,
  draft,
  onChange,
  siteId,
  mode,
}: {
  kind: WatchKind;
  draft: WatchDraft;
  onChange: (d: WatchDraft) => void;
  siteId: string;
  mode: 'create' | 'edit';
}) {
  const { t } = useI18n();
  const set = <K extends keyof WatchDraft>(k: K, v: WatchDraft[K]) => onChange({ ...draft, [k]: v });
  const input = (k: keyof WatchDraft, extra: React.InputHTMLAttributes<HTMLInputElement> = {}) => (id: string) => (
    <Input id={id} dir="ltr" value={String(draft[k])} onChange={(e) => set(k, e.target.value as never)} {...extra} />
  );
  const switches = useQuery<{ items: SwitchSummary[] }>(kind === 'snmp_oid' && siteId ? `/switches${qs({ site_id: siteId })}` : null, ['devices'], 120_000);
  const presets = useQuery<{ items: SnmpPresetEntry[] }>(kind === 'snmp_oid' ? '/checks/snmp-presets' : null, [], 600_000);

  const applyPreset = (preset: SnmpCheckPreset, index: string) => {
    const p = presets.data?.items.find((x) => x.preset === preset);
    if (!p) return onChange({ ...draft, preset, index });
    const fillIndex = (oid: string) => oid.replace('{index}', index || '1');
    onChange({
      ...draft,
      preset,
      index,
      oid: fillIndex(p.oid),
      ratioOid: p.ratio_oid ? fillIndex(p.ratio_oid) : '',
      comparison: p.comparison,
      warn: p.warn === null ? '' : String(p.warn),
      critical: p.critical === null ? '' : String(p.critical),
      unit: p.unit,
      scale: '1',
    });
  };

  if (kind === 'http' || kind === 'https') {
    return (
      <div className="space-y-3.5">
        {mode === 'create' ? (
          <Field label={t('monitoring.url')} hint={t('monitoring.urlHint')}>
            {input('url', { required: true, maxLength: 2300, placeholder: kind === 'https' ? 'https://192.168.1.10/health' : 'http://printer.lan/' })}
          </Field>
        ) : (
          <Field label={t('monitoring.path')}>{input('path', { required: true, maxLength: 2000 })}</Field>
        )}
        <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,1fr)] gap-3">
          <Field label={t('monitoring.method')}>
            {(id) => (
              <Select id={id} value={draft.method} onChange={(e) => set('method', e.target.value as 'GET' | 'HEAD')}>
                <option value="GET">GET</option>
                <option value="HEAD">HEAD</option>
              </Select>
            )}
          </Field>
          <Field label={`${t('monitoring.expectStatus')} · ${t('monitoring.statusFrom')}`}>{input('statusMin', { type: 'number', min: 100, max: 599, required: true })}</Field>
          <Field label={t('monitoring.statusTo')}>{input('statusMax', { type: 'number', min: 100, max: 599, required: true })}</Field>
        </div>
        <p className="-mt-2 text-xs text-faint">{t('monitoring.expectStatusHint')}</p>
        {draft.method === 'GET' && (
          <>
            <Field label={t('monitoring.bodyMatch')}>
              {(id) => (
                <Select id={id} value={draft.body} onChange={(e) => set('body', e.target.value as BodyChoice)}>
                  {(['none', 'contain', 'notContain', 'regex', 'notRegex'] as const).map((b) => (
                    <option key={b} value={b}>
                      {t(`monitoring.body.${b}` as Key)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            {draft.body !== 'none' && (
              <Field label={t('monitoring.bodyPattern')} hint={t('monitoring.bodyHint')}>
                {input('bodyPattern', { required: true, maxLength: 200 })}
              </Field>
            )}
          </>
        )}
        <div className="grid grid-cols-[minmax(0,1fr)_9rem] items-end gap-3">
          <Check label={t('monitoring.followRedirects')} checked={draft.followRedirects} onChange={(v) => set('followRedirects', v)} />
          {draft.followRedirects && <Field label={t('monitoring.maxRedirects')}>{input('maxRedirects', { type: 'number', min: 0, max: 10, required: true })}</Field>}
        </div>
        {kind === 'https' && (
          <>
            <Check label={t('monitoring.tlsVerify')} hint={draft.tlsVerify ? undefined : t('monitoring.tlsVerifyOff')} checked={draft.tlsVerify} onChange={(v) => set('tlsVerify', v)} />
            <Field label={t('monitoring.pin')} hint={t('monitoring.pinHint')}>
              {input('pin', { maxLength: 100, placeholder: 'AB:CD:…' })}
            </Field>
          </>
        )}
        <Check label={t('monitoring.allowPublic')} hint={t('monitoring.allowPublicHint')} checked={draft.allowPublic} onChange={(v) => set('allowPublic', v)} />
      </div>
    );
  }

  if (kind === 'tls_expiry') {
    return (
      <div className="space-y-3.5">
        <Field label={t('monitoring.sni')} hint={t('monitoring.sniHint')}>
          {input('sni', { maxLength: 253, placeholder: 'nas.example.lan' })}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('monitoring.warnDays')}>{input('warnDays', { type: 'number', min: 1, max: 365, required: true })}</Field>
          <Field label={t('monitoring.criticalDays')}>{input('criticalDays', { type: 'number', min: 0, max: 365, required: true })}</Field>
        </div>
        <Check label={t('monitoring.allowPublic')} hint={t('monitoring.allowPublicHint')} checked={draft.allowPublic} onChange={(v) => set('allowPublic', v)} />
      </div>
    );
  }

  const devices = switches.data?.items ?? [];
  const note = draft.preset === 'custom' ? null : t(`monitoring.note.${draft.preset}` as Key);
  return (
    <div className="space-y-3.5">
      {mode === 'create' && (
        <Field label={t('monitoring.snmpDevice')} hint={devices.length ? t('monitoring.snmpDeviceHint') : t('monitoring.snmpNoDevices')}>
          {(id) => (
            <Select id={id} value={draft.snmpTargetId} required onChange={(e) => set('snmpTargetId', e.target.value)}>
              <option value="">—</option>
              {devices.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.host}
                </option>
              ))}
            </Select>
          )}
        </Field>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
        <Field label={t('monitoring.preset')}>
          {(id) => (
            <Select id={id} value={draft.preset} onChange={(e) => applyPreset(e.target.value as SnmpCheckPreset, draft.index)}>
              {(['cpu', 'memory', 'temperature', 'link_status', 'custom'] as const).map((p) => (
                <option key={p} value={p}>
                  {t(`monitoring.preset.${p}` as Key)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {draft.preset !== 'custom' && (
          <Field label={t('monitoring.presetIndex')}>
            {(id) => <Input id={id} dir="ltr" inputMode="numeric" value={draft.index} onChange={(e) => applyPreset(draft.preset, e.target.value.replace(/\D/g, ''))} />}
          </Field>
        )}
      </div>
      {draft.preset !== 'custom' && <p className="-mt-2 text-xs text-faint">{t('monitoring.presetIndexHint')}</p>}
      {note && (
        <div className="rounded-[6px] border border-line bg-sunken px-2.5 py-2 text-xs text-muted">
          <span className="font-medium text-fg">{t('monitoring.vendorNote')}: </span>
          <span dir="auto">{note}</span>
        </div>
      )}
      <Field label={t('monitoring.oid')}>{input('oid', { required: true, maxLength: 128, placeholder: '1.3.6.1.2.1.2.2.1.8.1' })}</Field>
      <div className="grid grid-cols-[minmax(0,1fr)_7rem] gap-3">
        <Field label={t('monitoring.ratioOid')}>{input('ratioOid', { maxLength: 128 })}</Field>
        <Field label={t('monitoring.scale')}>{input('scale', { type: 'number', step: 'any', min: 0.000001, required: true })}</Field>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Field label={t('monitoring.comparison')}>
          {(id) => (
            <Select id={id} value={draft.comparison} onChange={(e) => set('comparison', e.target.value as SnmpComparison)}>
              {(['gt', 'lt', 'eq', 'ne'] as const).map((c) => (
                <option key={c} value={c}>
                  {t(`monitoring.cmp.${c}` as Key)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label={t('monitoring.warnValue')}>{input('warn', { type: 'number', step: 'any' })}</Field>
        <Field label={t('monitoring.criticalValue')}>{input('critical', { type: 'number', step: 'any' })}</Field>
        <Field label={t('monitoring.unit')}>{input('unit', { maxLength: 16 })}</Field>
      </div>
    </div>
  );
}
