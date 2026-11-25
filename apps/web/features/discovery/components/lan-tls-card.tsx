'use client';

import type { TlsStatus } from '@nigafiy/shared-types';
import { LockKeyhole } from 'lucide-react';
import { Async, Badge, Card, CopyBlock } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';

/**
 * Hub, Sensors: the HTTPS listener collectors and agents connect to, and the SHA-256 fingerprint they
 * pin. With built-in LAN TLS the pin is the local CA's, so it survives server-certificate renewals.
 */
export function LanTlsCard() {
  const { t } = useI18n();
  const tls = useQuery<TlsStatus>('/system/tls', [], 60_000);
  return (
    <Card title={<span className="inline-flex items-center gap-2"><LockKeyhole className="size-4" aria-hidden />{t('discovery.tls.title')}</span>} description={t('discovery.tls.intro')}>
      <Async query={tls}>{(s) => <TlsBody s={s} />}</Async>
    </Card>
  );
}

const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|::1|\[::1\])$/;

/**
 * The address a sensor on another computer should use: the browser's host when it is not loopback;
 * otherwise the first LAN address (IPv4 first) the certificate covers, then its hostname.
 */
function serverHost(s: TlsStatus): string {
  const browser = typeof window === 'undefined' ? '' : window.location.hostname;
  if (browser && !LOOPBACK.test(browser)) return browser;
  const lan = s.ip_addresses.filter((ip) => !LOOPBACK.test(ip));
  return lan.find((ip) => !ip.includes(':')) ?? lan[0] ?? s.dns_names.find((d) => !LOOPBACK.test(d)) ?? 'localhost';
}

function TlsBody({ s }: { s: TlsStatus }) {
  const { t, locale } = useI18n();
  if (s.mode === 'off' || !s.https_port) return <p className="text-[13px] text-muted">{t('discovery.tls.off')}</p>;
  const host = serverHost(s);
  const server = `https://${host.includes(':') ? `[${host}]` : host}:${s.https_port}`;
  const pin = s.pin_sha256;
  const collector = `NIGAFIY_SENSOR_SERVER_URL=${server} \\\nNIGAFIY_SENSOR_ENROLLMENT_TOKEN=<token>${pin ? ` \\\nNIGAFIY_SENSOR_TLS_PIN_SHA256=${pin}` : ''} \\\n./nigafiy-engine sensor -config collector.yaml`;
  const agent = `nigafiy-agent install -server ${server} -token <token>${pin ? ` -tls-pin ${pin}` : ''}`;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-[13px]">
        <Badge tone="ok">{s.mode === 'auto' ? t('discovery.tls.modeAuto') : t('discovery.tls.modeFiles')}</Badge>
        <span className="text-muted">
          {t('discovery.tls.listening')} <bdi className="mono">{`${s.https_host ?? '0.0.0.0'}:${s.https_port}`}</bdi>
        </span>
      </div>
      {pin ? (
        <>
          <CopyBlock label={s.pin_kind === 'ca' ? t('discovery.tls.pinCa') : t('discovery.tls.pinLeaf')} value={pin} />
          <p className="text-xs text-faint">{s.pin_kind === 'ca' ? t('discovery.tls.pinCaHint') : t('discovery.tls.pinLeafHint')}</p>
        </>
      ) : (
        <p className="text-[13px] text-muted">{t('discovery.tls.noPin')}</p>
      )}
      {s.mode === 'auto' && (
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[max-content_1fr]">
          <dt className="text-muted">{t('discovery.tls.covers')}</dt>
          <dd className="min-w-0 break-all">
            <bdi className="mono text-xs">{[...s.dns_names, ...s.ip_addresses].join(', ')}</bdi>
          </dd>
          <dt className="text-muted">{t('discovery.tls.serverUntil')}</dt>
          <dd>{absoluteTime(s.leaf_not_after, locale)}</dd>
          <dt className="text-muted">{t('discovery.tls.caUntil')}</dt>
          <dd>{absoluteTime(s.ca_not_after, locale)}</dd>
        </dl>
      )}
      <CopyBlock label={t('discovery.tls.collectorCommand')} value={collector} multiline />
      <CopyBlock label={t('discovery.tls.agentCommand')} value={agent} multiline />
      <p className="text-xs text-faint">{t('discovery.tls.tokenHint')}</p>
    </div>
  );
}
