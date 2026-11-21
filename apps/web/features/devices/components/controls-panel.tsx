'use client';

import { Activity, Ban, ExternalLink, Power } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { type Collector, DEVICE_TRUSTS, type DeviceDetail, type DeviceTrust } from '@lan-detective/shared-types';
import { Button, CopyBlock, ErrorNote, Segmented } from '@/components/ui';
import { DeviceRouterCard, type DeviceRouterControls } from '@/features/routers';
import { type ApiError, api } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { DeviceToolLinks } from '@/features/toolbox';

/** Things the user can do about a device. Removing a device happens on the router; we explain how. */
export function ControlsPanel({ device: d, onChanged }: { device: DeviceDetail; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useApp();
  const collectors = useQuery<{ items: Collector[] }>('/collectors', ['collectors']);
  const controlsQuery = useQuery<{
    sections?: { router?: DeviceRouterControls & { available?: boolean } };
    router?: DeviceRouterControls & { available?: boolean };
  }>(`/devices/${d.id}/controls`, ['devices', 'collectors'], 30_000);
  const routerControls = controlsQuery.data?.sections?.router ?? controlsQuery.data?.router;
  const gateway = collectors.data?.items.find((c) => c.site_id === d.site_id && c.gateway_ip)?.gateway_ip ?? null;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [wakeVia, setWakeVia] = useState<string | null>(null);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  }

  const tech = can('technician');
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1.5 text-xs font-medium text-muted">{t('ctl.trustLabel')}</p>
        <Segmented<DeviceTrust>
          label={t('ctl.trustLabel')}
          value={d.trust}
          options={DEVICE_TRUSTS.map((v) => ({ value: v, label: t(`trust.${v}`) }))}
          onChange={(trust) => tech && trust !== d.trust && run('trust', () => api(`/devices/${d.id}`, { method: 'PATCH', body: { trust } }))}
        />
        <p className={`mt-1.5 text-xs ${d.trust === 'unwanted' ? 'text-crit' : 'text-faint'}`}>{t(`ctl.trustHint.${d.trust}`)}</p>
      </div>

      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          disabled={!tech || busy === 'mute'}
          checked={d.alerts_muted}
          onChange={(e) => run('mute', () => api(`/devices/${d.id}`, { method: 'PATCH', body: { alerts_muted: e.target.checked } }))}
          className="mt-0.5 size-4 accent-[var(--color-accent)]"
        />
        <span>
          <span className="block text-[13px] text-fg">{t('ctl.mute')}</span>
          <span className="block text-xs text-muted">{t('ctl.muteHint')}</span>
        </span>
      </label>

      <div className="space-y-1.5 border-t border-line pt-4">
        {d.monitor_check_id ? (
          <p className="flex items-center gap-2 text-[13px] text-ok">
            <Activity className="size-4" aria-hidden />
            {t('ctl.monitored')}
            <Link href="/monitoring" className="ms-auto text-xs text-accent-hover hover:underline">
              {t('ctl.openMonitoring')}
            </Link>
          </p>
        ) : (
          can('admin') && (
            <Button busy={busy === 'monitor'} disabled={!d.current_ip} onClick={() => run('monitor', () => api(`/devices/${d.id}/monitor`, { method: 'POST' }))}>
              <Activity className="size-4" aria-hidden />
              {t('ctl.monitor')}
            </Button>
          )
        )}
        <p className="text-xs text-faint">{t('ctl.monitorHint')}</p>
      </div>

      {tech && d.current_ip && <DeviceToolLinks siteId={d.site_id} ip={d.current_ip} />}

      {tech && d.primary_mac && (
        <div className="space-y-1.5">
          <Button
            busy={busy === 'wake'}
            onClick={() =>
              run('wake', async () => {
                const res = await api<{ collector: string }>(`/devices/${d.id}/wake`, { method: 'POST' });
                setWakeVia(res.collector);
              })
            }
          >
            <Power className="size-4" aria-hidden />
            {t('ctl.wake')}
          </Button>
          {wakeVia && (
            <p className="text-xs text-ok" role="status">
              {t('ctl.wakeSent')} {wakeVia}
            </p>
          )}
          <p className="text-xs text-faint">{t('ctl.wakeHint')}</p>
        </div>
      )}

      <ErrorNote error={error} />

      {routerControls && ('available' in routerControls ? routerControls.available !== false : true) && (
        <DeviceRouterCard
          device={{
            id: d.id,
            label: d.display_name || d.hostname || d.current_ip || d.primary_mac || d.id,
            ip: d.current_ip,
            mac: d.primary_mac,
          }}
          routerSection={routerControls}
          gatewayIp={gateway}
          onChanged={() => {
            controlsQuery.reload();
            onChanged();
          }}
        />
      )}

      <details className={`rounded-md border px-3 py-2.5 ${d.trust === 'unwanted' ? 'border-crit/40 bg-crit/5' : 'border-line'}`} open={d.trust === 'unwanted'}>
        <summary className="flex cursor-pointer items-center gap-2 text-[13px] font-medium text-fg">
          <Ban className="size-4 text-crit" aria-hidden />
          {t('ctl.block')}
        </summary>
        <p className="mt-2 text-xs leading-relaxed text-muted">{t('ctl.blockBody')}</p>
        <div className="mt-3 space-y-3">
          {d.primary_mac ? <CopyBlock label={t('ctl.macToBlock')} value={d.primary_mac} /> : <p className="text-xs text-warn">{t('ctl.noMac')}</p>}
          {gateway && (
            <a
              href={`http://${gateway}/`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-raised px-3 text-xs font-medium text-fg hover:bg-line"
            >
              {t('ctl.openRouter')} <span className="mono text-muted">{gateway}</span>
              <ExternalLink className="size-3" aria-hidden />
            </a>
          )}
        </div>
      </details>
    </div>
  );
}
