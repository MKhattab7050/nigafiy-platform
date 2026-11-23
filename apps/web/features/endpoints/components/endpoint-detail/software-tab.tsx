'use client';

import { PackagePlus } from 'lucide-react';
import { useMemo } from 'react';
import type { EndpointDetail } from '@nigafiy/shared-types';
import { Button, Card, Input } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { endpointsText } from '../../text';

export function SoftwareTab({
  ep,
  online,
  canAdmin,
  search,
  setSearch,
  pkgId,
  setPkgId,
  busy,
  onSoftwareAction,
}: {
  ep: EndpointDetail;
  online: boolean;
  canAdmin: boolean;
  search: string;
  setSearch: (v: string) => void;
  pkgId: string;
  setPkgId: (v: string) => void;
  busy: string;
  onSoftwareAction: (action: 'install' | 'upgrade' | 'uninstall', packageId: string) => void;
}) {
  const { locale } = useI18n();
  const tx = endpointsText(locale);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return ep.software;
    return ep.software.filter(
      (s) => s.name.toLowerCase().includes(q) || (s.publisher && s.publisher.toLowerCase().includes(q)),
    );
  }, [ep.software, search]);

  return (
    <div className="space-y-4">
      {canAdmin && (
        <Card title={locale === 'ar' ? 'نشر وتثبيت الحزم والتطبيقات المعتمدة' : 'Approved Package & Application Deployment'}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              dir="ltr"
              className="mono w-80 max-w-full"
              value={pkgId}
              onChange={(e) => setPkgId(e.target.value)}
              placeholder={tx.swPackagePlaceholder}
            />
            <Button
              variant="primary"
              disabled={!online || !pkgId.trim()}
              busy={busy === 'sw-install'}
              onClick={() => onSoftwareAction('install', pkgId.trim())}
            >
              <PackagePlus className="size-4" aria-hidden />
              {tx.swInstall}
            </Button>
            <Button
              disabled={!online || !pkgId.trim()}
              busy={busy === 'sw-upgrade'}
              onClick={() => onSoftwareAction('upgrade', pkgId.trim())}
            >
              {tx.swUpgrade}
            </Button>
            <Button
              variant="danger"
              disabled={!online || !pkgId.trim()}
              busy={busy === 'sw-uninstall'}
              onClick={() => onSoftwareAction('uninstall', pkgId.trim())}
            >
              {tx.swUninstall}
            </Button>
          </div>
        </Card>
      )}

      <Card
        title={tx.tabs.software}
        action={
          <div className="w-64 max-w-full">
            <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tx.searchSoftware} />
          </div>
        }
        padded={false}
      >
        {ep.software.length === 0 ? (
          <p className="p-6 text-center text-[13px] text-muted">{tx.noInventoryYet}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-start text-xs">
              <thead className="border-b border-line bg-raised/60 text-muted">
                <tr>
                  <th className="px-4 py-2.5 text-start font-medium">{tx.colAppName}</th>
                  <th className="w-40 px-4 py-2.5 text-start font-medium">{tx.colVersion}</th>
                  <th className="px-4 py-2.5 text-start font-medium">{tx.colPublisher}</th>
                  <th className="w-32 px-4 py-2.5 text-start font-medium">{tx.colInstalled}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {filtered.map((s) => (
                  <tr key={s.name} className="hover:bg-raised/40">
                    <td className="px-4 py-2 font-medium text-fg">{s.name}</td>
                    <td dir="ltr" className="mono px-4 py-2 text-muted">
                      {s.version || '—'}
                    </td>
                    <td className="px-4 py-2 text-muted">{s.publisher || '—'}</td>
                    <td dir="ltr" className="mono px-4 py-2 text-faint">
                      {s.install_date || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
