'use client';

import { Network } from 'lucide-react';
import Link from 'next/link';
import type { IpamSubnetSummary } from '@lan-detective/shared-types';
import { Meter } from '@/components/charts';
import { Async } from '@/components/ui';
import { NextStep, Widget, attentionFrom } from '@/components/widget';
import { qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { type AttentionItem, useReportAttention } from '@/lib/attention';
import { pct } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { countText } from './components/usage-bar';
import { ipamText } from './text';

const used = (s: IpamSubnetSummary) => s.online + s.offline + s.documented_only;
const share = (s: IpamSubnetSummary) => (s.usable > 0 ? (used(s) / s.usable) * 100 : 0);
/** A subnet counts as nearly full at 90 % of its usable addresses. */
const NEARLY_FULL = 90;

/** Dashboard: address usage per subnet and addresses that need checking (GET /ipam/subnets). */
export default function IpamWidget() {
  const { t, locale } = useI18n();
  const tx = ipamText(locale);
  const { siteId } = useApp();
  const query = useQuery<{ items: IpamSubnetSummary[] }>(`/ipam/subnets${qs({ site_id: siteId })}`, ['devices'], 30_000);

  useReportAttention(
    'ipam',
    attentionFrom([query], ({ items }) => {
      const out: AttentionItem[] = [];
      for (const s of items) {
        if (s.conflicts > 0)
          out.push({ id: `ipam-conflict-${s.id}`, tone: 'warn', text: fill(t('ipam.attn.conflicts'), { count: s.conflicts, cidr: s.cidr }), action: { label: t('ipam.attn.check'), href: `/radar/ipam?subnet=${s.id}` } });
        if (s.usable > 0 && share(s) >= NEARLY_FULL)
          out.push({ id: `ipam-full-${s.id}`, tone: 'warn', text: fill(t('ipam.attn.full'), { cidr: s.cidr, free: countText(s.free_exact) }), action: { label: t('ipam.attn.check'), href: `/radar/ipam?subnet=${s.id}` } });
      }
      return out;
    }),
  );

  return (
    <Widget title={tx.title} icon={Network} href="/radar/ipam">
      <Async query={query}>
        {({ items }) =>
          items.length === 0 ? (
            <NextStep text={tx.emptyBody} label={tx.emptyAction} href="/radar/discovery" />
          ) : (
            <ul className="space-y-3">
              {items.slice(0, 5).map((s) => {
                const p = share(s);
                return (
                  <li key={s.id}>
                    <Link href={`/radar/ipam?subnet=${s.id}`} className="-mx-1.5 block rounded-[7px] px-1.5 py-1 transition-colors hover:bg-raised/60">
                      <Meter
                        warn={NEARLY_FULL - 10}
                        crit={NEARLY_FULL}
                        value={p}
                        ariaLabel={`${s.cidr} · ${tx.usage}`}
                        label={
                          <span className="mono text-[12.5px] text-fg" dir="ltr">
                            {s.cidr}
                            {s.label && <span className="ms-2 font-sans text-faint">{s.label}</span>}
                          </span>
                        }
                        display={pct(p, 0)}
                        detail={
                          <span className="tnum">
                            {countText(s.free_exact)} {tx.free}
                            {s.conflicts > 0 && (
                              <span className="text-warn">
                                {' '}
                                · {s.conflicts} {tx.conflictsN}
                              </span>
                            )}
                          </span>
                        }
                      />
                    </Link>
                  </li>
                );
              })}
              {items.length > 5 && <li className="text-[11px] text-faint">{fill(t('incident.widget.more'), { count: items.length - 5 })}</li>}
            </ul>
          )
        }
      </Async>
    </Widget>
  );
}
