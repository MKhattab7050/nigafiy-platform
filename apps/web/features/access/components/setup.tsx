'use client';

import { CheckCircle2, CircleAlert, ExternalLink } from 'lucide-react';
import type { AccessPage } from '@nigafiy/shared-types';
import { Badge, Card, CopyBlock } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { accessText } from '../text';

export function Setup({ data }: { data: AccessPage }) {
  const { locale } = useI18n();
  const tx = accessText(locale);
  const st = data.setup;
  const running = st.collector?.online && st.status?.listening;
  return (
    <Card title={tx.setup}>
      <div className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        {running ? (
          <Badge tone="ok">
            <CheckCircle2 className="size-3" aria-hidden /> {tx.statusListening}
          </Badge>
        ) : (
          <Badge tone="crit">
            <CircleAlert className="size-3" aria-hidden /> {st.collector?.online ? tx.statusNotListening : tx.statusOff}
          </Badge>
        )}
        {st.status?.error && <span className="text-xs text-crit">{st.status.error}</span>}
        {st.status?.list_error && <span className="text-xs text-warn">{st.status.list_error}</span>}
      </div>
      <p className="mb-2 text-sm text-muted">{tx.setupIntro}</p>
      <ol className="list-decimal space-y-2 ps-5 text-sm">
        <li>
          {tx.step1}
          {st.gateway_ip && (
            <a href={`http://${st.gateway_ip}/`} target="_blank" rel="noreferrer" className="ms-2 inline-flex items-center gap-1 text-accent hover:underline">
              http://{st.gateway_ip}/ <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </li>
        <li>
          {tx.step2} {st.dns_server_ip ? <span className="inline-block align-middle"><CopyBlock value={st.dns_server_ip} /></span> : <em>{tx.step2NoIp}</em>}
        </li>
        <li>{tx.step3}</li>
        <li>{tx.step4}</li>
      </ol>
      <p className="mt-3 text-xs text-muted">{tx.stepAlt}</p>
      <p className="mt-1 text-xs text-warn">{tx.keepOn}</p>
      <p className="mt-3 border-t border-line pt-3 text-xs text-faint">{tx.limits}</p>
    </Card>
  );
}
