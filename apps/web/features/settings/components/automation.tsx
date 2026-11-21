'use client';

import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { AutomationItem, AutomationList } from '@lan-detective/shared-types';
import { Async, Badge, Button, Card, ErrorNote, Field, Input, Select, Switch, Tag } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { automationDescription, automationName, configHint, configLabel } from '../automation-text';

/**
 * Mind → Automation (GET /automation; formerly in Settings). Everyone can see what LAN Detective does by itself;
 * administrators switch each behaviour on or off and tune it, for the organization or (with a site
 * picked in the top bar) for one site only.
 */
export function Automation() {
  const { t } = useI18n();
  const { siteId, sites, can } = useApp();
  const admin = can('admin');
  const query = useQuery<AutomationList>(`/automation${qs({ site_id: siteId })}`, [], 60_000);
  const site = sites.find((s) => s.id === siteId);
  const ref = useRef<HTMLDivElement>(null);
  const loaded = query.data !== undefined;

  // The page renders after the session loads, so the browser's own #automation jump finds nothing; do it once data is here.
  useEffect(() => {
    if (loaded && window.location.hash === '#automation') ref.current?.scrollIntoView({ block: 'start' });
  }, [loaded]);

  return (
    <div id="automation" ref={ref} className="scroll-mt-20">
      <Card title={t('automation.title')} description={t('automation.intro')}>
        <p className="mb-3 text-xs text-muted" dir="auto">
          {site ? fill(t('automation.scopeSite'), { site: site.name }) : t('automation.scopeOrg')}
        </p>
        {!admin && <p className="mb-3 text-xs text-muted">{t('automation.readOnly')}</p>}
        <Async query={query}>
          {({ items }) => (
            <ul className="divide-y divide-line rounded-[var(--radius-control)] border border-line">
              {items.map((item) => (
                <AutomationRow key={`${siteId ?? 'org'}-${item.key}`} item={item} siteId={siteId} admin={admin} onChanged={query.reload} />
              ))}
            </ul>
          )}
        </Async>
      </Card>
    </div>
  );
}

function AutomationRow({ item, siteId, admin, onChanged }: { item: AutomationItem; siteId: string | null; admin: boolean; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const name = automationName(t, item.key);
  const nameId = `automation-${item.key.replaceAll('.', '-')}`;
  const fields = Object.keys(item.default_config);
  const ownOverride = siteId ? item.site_override : item.org_override;
  const inheritedEnabled = item.org_override?.enabled ?? item.default_enabled;
  const dirty = Object.keys(draft).some((f) => draft[f] !== String(item.config[f] ?? ''));

  const send = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      setDraft({});
      onChanged();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  };

  const put = (enabled: boolean, config?: Record<string, unknown>) =>
    api<AutomationItem>(`/automation/${encodeURIComponent(item.key)}`, { method: 'PUT', body: { site_id: siteId, enabled, ...(config ? { config } : {}) } });

  const configBody = () =>
    Object.fromEntries(
      fields.map((f) => {
        const raw = draft[f] ?? String(item.config[f] ?? '');
        return [f, typeof item.default_config[f] === 'number' ? Number(raw) : raw];
      }),
    );

  const effect = item.last_effect;
  return (
    <li className="space-y-2.5 px-3 py-3.5 sm:px-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p id={nameId} className="text-[13px] font-semibold text-fg">
            {name}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={item.kind === 'act' ? 'info' : 'idle'} dot={false}>
              {t(`automation.kind.${item.kind}` as Key)}
            </Badge>
            <Tag>
              {t('automation.source')}: {t(`automation.source.${item.source}` as Key)}
            </Tag>
            {siteId && item.source === 'site' && (
              <span className="text-[11.5px] text-faint">{fill(t('automation.orgValue'), { state: t(inheritedEnabled ? 'automation.on' : 'automation.off') })}</span>
            )}
          </div>
        </div>
        <span className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted" aria-hidden>
            {t(item.enabled ? 'automation.on' : 'automation.off')}
          </span>
          <Switch checked={item.enabled} disabled={!admin || busy !== ''} label={name} onChange={(next) => void send('toggle', () => put(next))} />
        </span>
      </div>
      <p className="max-w-3xl text-[12.5px] leading-relaxed text-muted" dir="auto">
        {automationDescription(t, item)}
      </p>

      {fields.length > 0 && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void send('config', () => put(item.enabled, configBody()));
          }}
        >
          {fields.map((f) => {
            const value = draft[f] ?? String(item.config[f] ?? '');
            const set = (v: string) => setDraft({ ...draft, [f]: v });
            return (
              <div key={f} className="w-full sm:w-72">
                <Field label={configLabel(t, f)} hint={configHint(t, f)}>
                  {(id) =>
                    f === 'min_confidence' ? (
                      <Select id={id} value={value} disabled={!admin} onChange={(e) => set(e.target.value)}>
                        <option value="medium">{t('automation.config.medium')}</option>
                        <option value="high">{t('automation.config.high')}</option>
                      </Select>
                    ) : typeof item.default_config[f] === 'number' ? (
                      <Input
                        id={id}
                        type="number"
                        dir="ltr"
                        inputMode="numeric"
                        min={f === 'min_interval_minutes' ? 1 : undefined}
                        max={f === 'min_interval_minutes' ? 60 : undefined}
                        value={value}
                        disabled={!admin}
                        onChange={(e) => set(e.target.value)}
                        className="w-32"
                      />
                    ) : (
                      <Input id={id} value={value} disabled={!admin} onChange={(e) => set(e.target.value)} />
                    )
                  }
                </Field>
              </div>
            );
          })}
          {admin && dirty && (
            <Button type="submit" size="sm" variant="primary" busy={busy === 'config'} className="mb-6">
              {t('automation.saveConfig')}
            </Button>
          )}
        </form>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <p className="text-xs text-faint" title={effect.last_at ? absoluteTime(effect.last_at, locale) : undefined}>
          {effect.count > 0
            ? fill(t('automation.lastEffect'), { count: effect.count, days: effect.window_days, when: relativeTime(effect.last_at, locale) })
            : fill(t('automation.lastEffectNone'), { days: effect.window_days })}
        </p>
        {admin && ownOverride && (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-[11.5px] text-faint">{t(siteId ? 'automation.resetHintSite' : 'automation.resetHintOrg')}</span>
            <Button
              size="sm"
              variant="ghost"
              busy={busy === 'reset'}
              onClick={() => void send('reset', () => api(`/automation/${encodeURIComponent(item.key)}${qs({ site_id: siteId })}`, { method: 'DELETE' }))}
            >
              <RotateCcw className="size-3.5" aria-hidden />
              {t('automation.reset')}
            </Button>
          </span>
        )}
      </div>
      {error && <ErrorNote error={error} />}
    </li>
  );
}
