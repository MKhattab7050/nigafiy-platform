'use client';

import { useState } from 'react';
import { useApp } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { Select } from './ui';

/**
 * For screens whose data belongs to one site (the API needs a site_id): the site chosen in the top
 * bar, or, with "All sites" chosen, a local choice that starts at the first site. `picker` is the
 * local selector, rendered only when it is needed (no global site and more than one site).
 */
export function useSiteScope(): { siteId: string | null; picker: React.ReactNode } {
  const { t } = useI18n();
  const { siteId: globalSite, sites } = useApp();
  const [local, setLocal] = useState<string | null>(null);
  const siteId = globalSite ?? (local && sites.some((s) => s.id === local) ? local : (sites[0]?.id ?? null));
  const picker =
    !globalSite && sites.length > 1 ? (
      <Select aria-label={t('common.site')} value={siteId ?? ''} onChange={(e) => setLocal(e.target.value)} className="w-48">
        {sites.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    ) : null;
  return { siteId, picker };
}
