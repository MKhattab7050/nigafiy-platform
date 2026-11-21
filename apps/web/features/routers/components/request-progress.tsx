'use client';

import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { fill, useI18n } from '@/lib/i18n';
import type { RouterRequest } from '../types';
import { UpdateCredentialsLink, useMaybe } from './text';

const POLL_MS = 2000;
const LOGIN_KINDS = new Set(['bad_credentials', 'no_credentials', 'login_suspended', 'locked_out']);

/**
 * Follows one queued router request (GET /router-requests/:id) until it completes, fails or expires.
 * The server expires a pending request after 10 minutes, so polling always ends.
 */
export function useRouterRequest(id: string | null, onSettled?: (r: RouterRequest) => void): { request: RouterRequest | null; error: ApiError | null } {
  const [request, setRequest] = useState<RouterRequest | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const settled = useRef(onSettled);
  settled.current = onSettled;

  useEffect(() => {
    setRequest(null);
    setError(null);
    if (!id) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await api<RouterRequest>(`/router-requests/${id}`);
        if (stop) return;
        setRequest(r);
        setError(null);
        if (r.status !== 'pending') {
          settled.current?.(r);
          return;
        }
      } catch (err) {
        if (stop) return;
        setError(err as ApiError);
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [id]);

  return { request, error };
}

/**
 * The visible life of one request: waiting → done (with what changed) or failed (with what to do).
 * A login problem points to the credentials instead of offering a retry that would fail again.
 */
export function RequestProgress({
  requestId,
  routerId,
  collector,
  onSettled,
  onRetry,
  compact,
}: {
  requestId: string;
  routerId: string;
  collector?: string;
  onSettled?: (r: RouterRequest) => void;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const maybe = useMaybe();
  const { request, error } = useRouterRequest(requestId, onSettled);
  const status = request?.status ?? 'pending';

  if (status === 'pending') {
    return (
      <p role="status" className="flex items-center gap-2 text-[12.5px] text-muted">
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        <span>{collector ? fill(t('routers.req.pendingVia'), { collector }) : t('routers.req.pending')}</span>
        {error && <span className="text-warn">· {error.message}</span>}
      </p>
    );
  }

  if (status === 'completed' && request) {
    const change = request.result?.change;
    const text =
      request.action === 'block' && change?.already_in_effect ? t('routers.req.success.blockExisting') : maybe(`routers.req.success.${request.action}`, t('routers.req.completed'));
    return (
      <div role="status" className="space-y-1">
        <p className="flex items-start gap-2 text-[12.5px] text-fg">
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-ok" aria-hidden />
          <span>
            <span className="sr-only">{t('routers.req.completed')}: </span>
            {text}
          </span>
        </p>
        {!compact && change?.detail && (
          <p className="ps-5 text-xs text-muted" dir="auto">
            {change.detail}
          </p>
        )}
        {!compact && change?.undo && (
          <p className="ps-5 text-xs text-muted" dir="auto">
            {t('routers.req.undo')}: {change.undo}
          </p>
        )}
      </div>
    );
  }

  // failed or expired
  const kind = status === 'expired' ? 'expired' : (request?.error_kind ?? '');
  const login = LOGIN_KINDS.has(kind);
  return (
    <div role="alert" className="space-y-1.5">
      <p className="flex items-start gap-2 text-[12.5px] text-fg">
        <XCircle className="mt-0.5 size-3.5 shrink-0 text-crit" aria-hidden />
        <span>
          <span className="font-medium">{t(status === 'expired' ? 'routers.req.expired' : 'routers.req.failed')}: </span>
          {maybe(`routers.req.kind.${kind}`, request?.error ?? t('common.error'))}
        </span>
      </p>
      {!compact && request?.error && kind !== 'expired' && (
        <p className="ps-5 text-xs text-muted">
          {t('routers.req.routerSaid')}:{' '}
          <span dir="auto" className="text-faint">
            {request.error}
          </span>
        </p>
      )}
      <div className="flex flex-wrap gap-2 ps-5">
        {login ? <UpdateCredentialsLink routerId={routerId} /> : onRetry && (
          <Button size="sm" onClick={onRetry}>
            {t('routers.tryAgain')}
          </Button>
        )}
      </div>
    </div>
  );
}
