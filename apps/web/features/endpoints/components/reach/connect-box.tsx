'use client';

import { PlugZap, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { FleetConnectTarget } from '@nigafiy/shared-types';
import { Button, Field, Input, Modal, Notice } from '@/components/ui';
import { ApiError, api, qs } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ltr } from '@/lib/localize/bidi';
import { codeMessage, policyText } from '../fleet-policy/policy-text';
import { formatId, reachText } from './reach-text';

type EndpointTarget = Extract<FleetConnectTarget, { kind: 'endpoint' }>['endpoint'];

/**
 * "Connect by name, Nigafiy ID or code" (technicians): one computer opens its page with the
 * connect dialog; a Quick Support code asks for the one-time PIN.
 */
export function ConnectBox() {
  const { locale } = useI18n();
  const tx = reachText(locale);
  const router = useRouter();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [many, setMany] = useState<EndpointTarget[] | null>(null);
  const [none, setNone] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [qsCode, setQsCode] = useState<string | null>(null);

  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true);
    setMany(null);
    setNone(false);
    setError(null);
    try {
      const r = await api<{ targets: FleetConnectTarget[] }>(`/fleet/connect/resolve${qs({ q: q.trim() })}`);
      const first = r.targets[0];
      if (!first) setNone(true);
      else if (first.kind === 'quick_support') setQsCode(first.code);
      else if (r.targets.length === 1) router.push(`/fleet/endpoints/${first.endpoint.id}?connect=1`);
      else setMany(r.targets.flatMap((t) => (t.kind === 'endpoint' ? [t.endpoint] : [])));
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <form onSubmit={go} className="flex flex-wrap items-end gap-2">
        <div className="min-w-64 flex-1">
          <Field label={tx.connectLabel}>
            {(id) => <Input id={id} value={q} maxLength={120} onChange={(e) => setQ(e.target.value)} placeholder={tx.connectPlaceholder} dir="auto" />}
          </Field>
        </div>
        <Button type="submit" variant="primary" busy={busy} disabled={!q.trim()}>
          <PlugZap className="size-4" aria-hidden />
          {tx.connectGo}
        </Button>
      </form>
      {none && <p className="text-xs text-muted">{tx.connectNone}</p>}
      {error && <p className="text-xs text-crit">{error.message}</p>}
      {many && (
        <div className="text-xs">
          <p className="mb-1 text-muted">{tx.connectMany}</p>
          <ul className="flex flex-wrap gap-2">
            {many.map((e) => (
              <li key={e.id}>
                <Link href={`/fleet/endpoints/${e.id}?connect=1`} className="rounded border border-line px-2 py-1 hover:border-accent" dir="auto">
                  {e.name} · {e.site_name} · {ltr(formatId(e.nigafiy_id))}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
      {qsCode !== null && <QuickConnectDialog code={qsCode} onClose={() => setQsCode(null)} onConnected={(id) => router.push(`/fleet/endpoints/${id}?tab=desktop`)} />}
    </div>
  );
}

/** The code and the one-time PIN the person reads out of nigafiy-support.exe (POST /fleet/quick-support/connect). */
export function QuickConnectDialog({ code: initial, onClose, onConnected }: { code: string; onClose: () => void; onConnected: (endpointId: string) => void }) {
  const { locale } = useI18n();
  const tx = reachText(locale);
  const px = policyText(locale);
  const [code, setCode] = useState(initial);
  const [pin, setPin] = useState('');
  const [reason, setReason] = useState('');
  const [record, setRecord] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const digits = code.replace(/[\s-]/g, '');
  const ready = /^[1-9]\d{8}$/.test(digits) && /^\d{6}$/.test(pin) && reason.trim().length >= 3;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ endpoint_id: string }>('/fleet/quick-support/connect', { method: 'POST', body: { code: digits, pin, reason: reason.trim(), recording_enabled: record } });
      onConnected(r.endpoint_id);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={tx.qsTitle} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Notice>{tx.qsHelp}</Notice>
        <Field label={tx.qsCode}>
          {(id) => <Input id={id} value={code} inputMode="numeric" maxLength={11} onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))} dir="ltr" className="mono w-44 tracking-[0.2em]" />}
        </Field>
        <Field label={tx.qsPin}>
          {(id) => <Input id={id} value={pin} inputMode="numeric" autoComplete="off" maxLength={6} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} dir="ltr" className="mono w-36 tracking-[0.3em]" autoFocus />}
        </Field>
        <Field label={tx.qsReason}>
          {(id) => <Input id={id} value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} dir="auto" />}
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={record} onChange={(e) => setRecord(e.target.checked)} />
          {tx.qsRecord}
        </label>
        {error && (
          <div role="alert" className="flex items-start gap-2 rounded-md border border-crit/30 bg-crit/[0.07] px-3 py-2 text-[13px]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-crit" aria-hidden />
            <span>{codeMessage(px, error)}</span>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {tx.cancel}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!ready}>
            {tx.qsSend}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
