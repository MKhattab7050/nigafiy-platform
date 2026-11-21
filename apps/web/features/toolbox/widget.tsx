'use client';

import { Wrench } from 'lucide-react';
import Link from 'next/link';
import type { ToolRun } from '@lan-detective/shared-types';
import { Async, Badge } from '@/components/ui';
import { NextStep, Widget } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { relativeTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { runTone } from './components/tools';
import { toolboxText } from './text';

/** Dashboard: the latest probes run from the IT Toolbox (GET /toolbox, limit 5). */
export default function ToolboxWidget() {
  const { t, locale } = useI18n();
  const tx = toolboxText(locale);
  const { siteId, sites } = useApp();
  const site = siteId ?? sites[0]?.id ?? null;
  const query = useQuery<{ items: ToolRun[] }>(site ? `/toolbox${qs({ site_id: site, limit: 5 })}` : null, ['checks', 'collectors'], 15_000);

  return (
    <Widget title={tx.title} icon={Wrench} href="/toolbox">
      {!site ? (
        <NextStep text={t('doctor.noSites')} label={t('overview.setupCta')} href="/discovery" />
      ) : (
        <Async query={query}>
          {({ items }) =>
            items.length === 0 ? (
              <NextStep text={tx.subtitle} label={tx.runTitle} href="/toolbox" />
            ) : (
              <ul className="divide-y divide-line rounded-md border border-line">
                {items.map((r) => (
                  <li key={r.id}>
                    <Link href="/toolbox" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 hover:bg-raised/60">
                      <span className="text-[13px] font-medium">{tx.tools[r.tool]}</span>
                      <span className="mono min-w-0 flex-1 truncate text-xs text-muted" dir="ltr">
                        {r.target}
                        {r.port ? `:${r.port}` : ''}
                      </span>
                      <Badge tone={runTone(r)}>{tx.status[r.status]}</Badge>
                      <span className="text-[11px] text-faint">{relativeTime(r.created_at, locale)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
      )}
    </Widget>
  );
}
