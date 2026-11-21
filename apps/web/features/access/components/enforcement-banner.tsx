'use client';

import type { AccessPage } from '@lan-detective/shared-types';
import { AlertTriangle, Router, ShieldAlert, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { Badge, Card } from '@/components/ui';
import { fill, useI18n } from '@/lib/i18n';
import { accessText } from '../text';

const MODE_TONE = {
  router_and_dns: 'ok',
  router_only: 'info',
  dns_only: 'warn',
  none: 'idle',
} as const;

export function EnforcementBanner({ data }: { data: AccessPage }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const enf = data.enforcement;
  if (!enf) return null;

  return (
    <Card title={tx.enforcement.title}>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={MODE_TONE[enf.mode]} dot>
              {enf.mode === 'router_and_dns' ? (
                <ShieldCheck className="size-3.5" aria-hidden />
              ) : (
                <ShieldAlert className="size-3.5" aria-hidden />
              )}
              {tx.enforcement.mode[enf.mode]}
            </Badge>
            {enf.active_router_count > 0 && (
              <Badge tone="idle" dot={false}>
                {fill(tx.enforcement.routersActive, { n: enf.active_router_count })}
              </Badge>
            )}
          </div>
          {enf.active_router_count === 0 && (
            <Link
              href="/guard/routers"
              className="inline-flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2.5 py-1 text-xs font-medium text-accent hover:bg-accent/15"
            >
              <Router className="size-3.5" aria-hidden />
              {tx.enforcement.routerCta}
            </Link>
          )}
        </div>

        <p className="text-xs text-muted">{tx.enforcement.modeDesc[enf.mode]}</p>

        {enf.single_point_of_failure && (
          <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{tx.enforcement.spofWarn}</span>
          </div>
        )}

        {enf.doh_bypass_queries_24h > 0 ? (
          <div className="rounded-md border border-crit/30 bg-crit/10 px-3 py-2 text-xs">
            <p className="font-medium text-crit">
              {fill(tx.enforcement.dohAlert, {
                queries: enf.doh_bypass_queries_24h,
                devices: enf.doh_bypass_devices_24h,
              })}
            </p>
            {enf.top_doh_domains_24h.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5" dir="ltr">
                {enf.top_doh_domains_24h.map((item) => (
                  <span key={item.domain} className="mono rounded bg-bg/60 px-1.5 py-0.5 text-[11px] text-fg">
                    {item.domain} ({item.count})
                  </span>
                ))}
              </div>
            )}
          </div>
        ) : (
          enf.dns_active && <p className="text-xs text-faint">{tx.enforcement.dohClean}</p>
        )}
      </div>
    </Card>
  );
}
