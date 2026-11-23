'use client';

import clsx from 'clsx';
import { ChevronDown } from 'lucide-react';
import { useState } from 'react';
import type { AccessPage } from '@nigafiy/shared-types';
import { Button, Card, ErrorNote, Field, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { linesToList, CategoryPicker } from './rule-editors';
import { accessText } from '../text';

export function SiteRules({ data, site, admin, onChanged }: { data: AccessPage; site: string; admin: boolean; onChanged: () => void }) {
  const { locale, t } = useI18n();
  const tx = accessText(locale);
  const [upstreams, setUpstreams] = useState(data.settings.upstreams.join('\n'));
  // The Advanced part starts open only when upstream servers are already set.
  const [advanced, setAdvanced] = useState(data.settings.upstreams.length > 0);
  const [cats, setCats] = useState(data.settings.blocked_categories);
  const [blocked, setBlocked] = useState(data.settings.blocked_domains.join('\n'));
  const [allowed, setAllowed] = useState(data.settings.allowed_domains.join('\n'));
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/access/settings', { method: 'PUT', body: { site_id: site, blocked_categories: cats, blocked_domains: linesToList(blocked), allowed_domains: linesToList(allowed), upstreams: linesToList(upstreams) } });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onChanged();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title={tx.siteRules}>
      <p className="mb-3 text-xs text-muted">{tx.siteRulesHint}</p>
      <div className="space-y-4">
        <div>
          <p className="mb-2 text-xs font-medium text-muted">{tx.categories}</p>
          <CategoryPicker all={data.categories} value={cats} onChange={setCats} disabled={!admin} />
        </div>
        <div className="grid gap-3 md:grid-cols-2">
          <Field label={tx.blockedDomains} hint={tx.domainsHint}>
            {(id) => <Textarea id={id} rows={4} dir="ltr" value={blocked} disabled={!admin} onChange={(e) => setBlocked(e.target.value)} placeholder="tiktok.com" />}
          </Field>
          <Field label={tx.allowedDomains} hint={tx.domainsHint}>
            {(id) => <Textarea id={id} rows={4} dir="ltr" value={allowed} disabled={!admin} onChange={(e) => setAllowed(e.target.value)} placeholder="khanacademy.org" />}
          </Field>
        </div>
        <div>
          <button
            type="button"
            onClick={() => setAdvanced(!advanced)}
            aria-expanded={advanced}
            className="inline-flex h-8 items-center gap-1 rounded px-1 text-xs font-medium text-muted hover:text-fg"
          >
            {t('common.advanced')}
            <ChevronDown className={clsx('size-3.5 transition-transform duration-150', advanced && 'rotate-180')} aria-hidden />
          </button>
          {advanced && (
            <div className="mt-2 max-w-md">
              <Field label={t('access.upstreams')} hint={t('access.upstreamsHint')}>
                {(id) => <Textarea id={id} rows={3} dir="ltr" className="mono" value={upstreams} disabled={!admin} onChange={(e) => setUpstreams(e.target.value)} placeholder="1.1.1.1" />}
              </Field>
            </div>
          )}
        </div>
        {error && <ErrorNote error={error} />}
        {admin && (
          <Button variant="primary" busy={busy} onClick={save}>
            {saved ? tx.saved : tx.save}
          </Button>
        )}
      </div>
    </Card>
  );
}
