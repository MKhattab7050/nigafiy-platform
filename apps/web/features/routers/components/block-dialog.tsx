'use client';

import { Ban, ShieldOff } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Modal, SkeletonBlock } from '@/components/ui';
import { api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';
import type { BlockResponse, DeviceRef, RouterDetail } from '../types';
import { RequestProgress } from './request-progress';
import { RouterErrorNote, useRefusalText } from './text';

/**
 * The one confirmation for blocking or unblocking devices on a router. It names every device,
 * states how THIS router blocks (from the capability the router reported) and how to undo it, and
 * then shows the outcome per device, following each queued request until it completes or fails.
 */
export function BlockDialog({
  routerId,
  action,
  devices,
  onClose,
  onDone,
}: {
  routerId: string;
  action: 'block' | 'unblock';
  devices: DeviceRef[];
  onClose: () => void;
  onDone?: () => void;
}) {
  const { t } = useI18n();
  const refusal = useRefusalText();
  const router = useQuery<RouterDetail>(`/routers/${routerId}`, ['devices'], 60_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [response, setResponse] = useState<BlockResponse | null>(null);
  const name = router.data?.name ?? '…';
  const cap = router.data?.capabilities?.find((c) => c.capability === 'block');
  const labelOf = new Map(devices.map((d) => [d.id, d]));

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<BlockResponse>(`/routers/${routerId}/${action}`, { method: 'POST', body: { device_ids: devices.map((d) => d.id) } });
      setResponse(res);
      onDone?.();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  const Icon = action === 'block' ? Ban : ShieldOff;
  return (
    <Modal title={fill(t(action === 'block' ? 'routers.confirmBlockTitle' : 'routers.confirmUnblockTitle'), { router: name })} onClose={onClose} wide>
      {!router.data && !router.error ? (
        <SkeletonBlock lines={4} />
      ) : response ? (
        <div className="space-y-3">
          <h3 className="text-xs font-medium text-muted">{t('routers.results')}</h3>
          <ul className="divide-y divide-line rounded-[var(--radius-control)] border border-line">
            {response.results.map((r) => {
              const d = labelOf.get(r.device_id);
              return (
                <li key={r.device_id} className="space-y-1.5 px-3 py-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 truncate text-[13px] font-medium" dir="auto">
                      {d?.label ?? r.device_id}
                    </span>
                    <Badge tone={r.status === 'queued' ? 'info' : 'warn'}>{t(r.status === 'queued' ? 'routers.result.queued' : 'routers.result.refused')}</Badge>
                  </div>
                  {r.status === 'queued' && r.request_id ? (
                    <RequestProgress requestId={r.request_id} routerId={routerId} onSettled={() => onDone?.()} />
                  ) : (
                    <p className="text-xs text-muted" dir="auto">
                      {refusal(r)}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose}>
              {t('routers.done')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-[13px] text-fg">{fill(t(action === 'block' ? 'routers.confirmBlockIntro' : 'routers.confirmUnblockIntro'), { router: name })}</p>
          <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-[var(--radius-control)] border border-line">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2 text-[13px]">
                <span className="min-w-0 flex-1 truncate font-medium" dir="auto">
                  {d.label}
                </span>
                {d.ip && <span className="mono text-xs text-muted">{d.ip}</span>}
                {d.mac && <span className="mono text-xs text-faint">{d.mac}</span>}
              </li>
            ))}
          </ul>
          {action === 'block' && (
            <div className="rounded-[var(--radius-control)] border border-line-strong bg-raised px-3 py-2.5">
              <p className="text-xs font-medium text-muted">{t('routers.mechanism')}</p>
              <p className="mt-1 text-[13px] text-fg" dir="auto">
                {cap?.mechanism ?? t('routers.mechanismUnknown')}
              </p>
              {cap?.note && (
                <p className="mt-1 text-xs text-muted" dir="auto">
                  {cap.note}
                </p>
              )}
            </div>
          )}
          <p className="text-xs leading-relaxed text-muted">{t(action === 'block' ? 'routers.undoBlock' : 'routers.undoUnblock')}</p>
          <RouterErrorNote error={error ?? router.error} routerId={routerId} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button variant={action === 'block' ? 'danger' : 'primary'} busy={busy} disabled={!router.data} onClick={() => void confirm()}>
              <Icon className="size-4" aria-hidden />
              {fill(t(action === 'block' ? 'routers.confirmBlock' : 'routers.confirmUnblock'), { count: devices.length })}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
