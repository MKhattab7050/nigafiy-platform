'use client';

import { GitBranch } from 'lucide-react';
import type { SpofReport } from '@lan-detective/shared-types';
import { Async } from '@/components/ui';
import { Metric, NextStep, Widget } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';

/** Dashboard: how many single points of failure the selected site has, and the largest one. */
export default function ImpactWidget() {
  const { t } = useI18n();
  const { siteId, sites } = useApp();
  const site = siteId ?? (sites.length === 1 ? sites[0]!.id : null);
  const query = useQuery<SpofReport>(site ? `/impact/spof${qs({ site_id: site })}` : null, ['devices', 'collectors'], 300_000);
  return (
    <Widget title={t('imp.title')} icon={GitBranch} href={site ? `/watch/impact${qs({ site })}` : '/watch/impact'}>
      {!site ? (
        <NextStep text={t('imp.selectSite')} />
      ) : (
        <Async query={query}>
          {(r) => {
            const top = r.items[0];
            return (
              <div className="space-y-3">
                <Metric label={t('imp.widget.spofs')} value={r.items.length} tone={r.items.length ? 'warn' : 'ok'} href={`/watch/impact${qs({ site })}`} size="lg" />
                {top ? (
                  <p className="text-xs leading-relaxed text-muted">
                    {t('imp.widget.largest')}: <span className="font-medium text-fg" dir="auto">{top.label}</span> — {fill(t('imp.spof.devices'), { n: top.devices_impacted })}
                    {top.checks_down ? ` · ${fill(t('imp.spof.checks'), { n: top.checks_down })}` : ''}
                  </p>
                ) : (
                  <p className="text-xs text-muted">{t('imp.spof.none')}</p>
                )}
              </div>
            );
          }}
        </Async>
      )}
    </Widget>
  );
}
