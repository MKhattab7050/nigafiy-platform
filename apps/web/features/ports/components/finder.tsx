'use client';

import type { PortSearchHit } from '@lan-detective/shared-types';
import { Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Card, Input, StatusBadge } from '@/components/ui';
import { qs } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { LocationView } from './location-view';
import { portsText } from '../text';
import { DeviceLink } from '@/components/device-link';

export function Finder({ siteId }: { siteId: string | null }) {
  const { locale } = useI18n();
  const tx = portsText(locale);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(text.trim()), 300);
    return () => clearTimeout(timer);
  }, [text]);
  const hits = useQuery<{ items: PortSearchHit[] }>(q.length >= 2 ? `/ports/find${qs({ q, site_id: siteId })}` : null, [], 0);
  return (
    <Card>
      <div className="relative">
        <Search className="pointer-events-none absolute start-3 top-2.5 size-4 text-faint" aria-hidden />
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder={tx.search} aria-label={tx.search} className="ps-9" maxLength={100} />
      </div>
      {q.length >= 2 && hits.data && (
        <ul className="mt-3 divide-y divide-line">
          {hits.data.items.length === 0 && <li className="py-2 text-sm text-muted">{tx.noHits}</li>}
          {hits.data.items.map((h) => (
            <li key={h.device.id} className="py-3">
              <p className="mb-1 flex flex-wrap items-center gap-2 text-sm">
                <DeviceLink id={h.device.id} className="font-medium hover:text-accent-hover" dir="auto">
                  {h.device.label}
                </DeviceLink>
                <StatusBadge status={h.device.status} />
                <span className="mono text-xs text-muted">{[h.device.ip, h.device.mac].filter(Boolean).join(' · ')}</span>
              </p>
              {h.location ? <LocationView loc={h.location} /> : <p className="text-xs text-muted">{h.device.mac ? tx.notLocated.not_seen : tx.notLocated.no_mac}</p>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
