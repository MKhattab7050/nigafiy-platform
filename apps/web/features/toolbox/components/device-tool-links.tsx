'use client';

import { Wrench } from 'lucide-react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { toolboxText } from '../text';

/** Device page shortcut: open a toolbox probe already pointed at this device. */
export function DeviceToolLinks({ siteId, ip }: { siteId: string; ip: string }) {
  const { locale } = useI18n();
  const txTool = toolboxText(locale);
  return (
    <div className="space-y-1.5 border-t border-line pt-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
        <Wrench className="size-3.5" aria-hidden />
        {txTool.deviceCardTitle}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {(['ping', 'ports', 'tcp', 'rdns', 'traceroute'] as const).map((tool) => (
          <Link
            key={tool}
            href={`/toolbox?site_id=${encodeURIComponent(siteId)}&target=${encodeURIComponent(ip)}&tool=${tool}`}
            className="inline-flex h-7 items-center rounded-md border border-line-strong bg-raised px-2.5 text-xs font-medium text-fg hover:bg-line"
          >
            {txTool.tools[tool]}
          </Link>
        ))}
      </div>
      <p className="text-xs text-faint">{txTool.deviceCardHint}</p>
    </div>
  );
}
