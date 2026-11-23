'use client';

import { useState } from 'react';
import type { CheckKind, CheckRole, Device, Paginated, SwitchSummary } from '@nigafiy/shared-types';
import { Badge, Button, ErrorNote, Field, Input, Modal, Select } from '@/components/ui';
import { ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { DEVICE_TYPE_LABEL } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import { AUTO_GATEWAY, type Thresholds, inferRole, presetFor } from './check-presets';
import { WATCH_KINDS, type WatchDraft, WatchFields, buildConfig, emptyDraft, isWatchKind, parseCheckUrl } from './watch-fields';

type ThresholdField = keyof Thresholds;
const deviceLabel = (d: Device) => d.display_name || d.hostname || d.current_ip || '—';

/**
 * Add a check with as little typing as possible: pick a device (or the gateway) and the target,
 * name, role and thresholds are filled in. Every filled value is labelled and stays editable; a
 * value the admin typed is never overwritten.
 */
export function AddCheck({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t, locale } = useI18n();
  const { sites, siteId } = useApp();
  const [site, setSite] = useState(siteId ?? sites[0]?.id ?? '');
  const [kind, setKind] = useState<CheckKind>('icmp');
  const [picked, setPicked] = useState('');
  const [target, setTarget] = useState('');
  const [port, setPort] = useState('');
  // null = not typed by the admin: the generated / inferred value is used.
  const [name, setName] = useState<string | null>(null);
  const [role, setRole] = useState<CheckRole | null>(null);
  const [typed, setTyped] = useState<Partial<Record<ThresholdField, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState<WatchDraft>(emptyDraft);
  const watch = isWatchKind(kind);
  const parsedUrl = kind === 'http' || kind === 'https' ? parseCheckUrl(draft.url, kind) : null;

  const devices = useQuery<Paginated<Device>>(site ? `/devices${qs({ site_id: site, page_size: 200, sort: 'name' })}` : null, ['devices'], 120_000);
  const choices = (devices.data?.items ?? []).filter((d) => d.current_ip);
  const pickedDevice = choices.find((d) => d.id === picked) ?? null;

  const effectiveRole = role ?? inferRole(kind, kind === 'http' || kind === 'https' ? (parsedUrl?.host ?? '') : target);
  const preset = presetFor(effectiveRole, kind);
  const value = (f: ThresholdField) => typed[f] ?? (preset[f] === null ? '' : String(preset[f]));
  const subject = target === AUTO_GATEWAY ? '' : pickedDevice && pickedDevice.current_ip === target.trim() ? deviceLabel(pickedDevice) : target.trim();
  const snmpDevice = useQuery<{ items: SwitchSummary[] }>(kind === 'snmp_oid' && site ? `/switches${qs({ site_id: site })}` : null, ['devices'], 120_000).data?.items.find((s) => s.id === draft.snmpTargetId);
  const generatedName =
    kind === 'http' || kind === 'https'
      ? parsedUrl
        ? fill(t('monitoring.name.http'), { target: `${parsedUrl.host}${parsedUrl.port ? `:${parsedUrl.port}` : ''}${parsedUrl.path === '/' ? '' : parsedUrl.path}` })
        : ''
      : kind === 'tls_expiry'
        ? subject
          ? fill(t('monitoring.name.tls'), { target: `${subject}${port && port !== '443' ? `:${port}` : ''}` })
          : ''
        : kind === 'snmp_oid'
          ? snmpDevice
            ? fill(t('monitoring.name.snmp'), { preset: draft.preset === 'custom' ? draft.oid || 'OID' : t(`monitoring.preset.${draft.preset}`), device: snmpDevice.name })
            : ''
          : target.trim() === AUTO_GATEWAY
            ? t('monitoring.name.gateway')
            : !subject
              ? ''
              : kind === 'icmp'
                ? fill(t('monitoring.name.ping'), { target: subject })
                : kind === 'tcp'
                  ? fill(t('monitoring.name.tcp'), { target: subject, port: port || '…' })
                  : fill(t('monitoring.name.dns'), { target: subject });
  const effectiveName = (name ?? generatedName).slice(0, 80);

  function pick(id: string) {
    setPicked(id);
    if (id === 'gateway') {
      setKind('icmp');
      setTarget(AUTO_GATEWAY);
    } else {
      const d = choices.find((x) => x.id === id);
      if (d?.current_ip) setTarget(d.current_ip);
    }
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const num = (f: ThresholdField) => (value(f) === '' ? null : Number(value(f)));
    let where: { kind: CheckKind; target: string; port: number | null; config?: Record<string, unknown>; snmp_target_id?: string } = {
      kind,
      target: target.trim(),
      port: kind === 'tcp' ? Number(port) : null,
    };
    if (kind === 'http' || kind === 'https') {
      if (!parsedUrl) {
        setError(new ApiError(400, 'invalid_target', t('monitoring.urlInvalid')));
        return;
      }
      where = { kind: parsedUrl.kind, target: parsedUrl.host, port: parsedUrl.port, config: buildConfig(parsedUrl.kind, draft, parsedUrl.path) };
    } else if (kind === 'tls_expiry') {
      where = { kind, target: target.trim(), port: Number(port || '443'), config: buildConfig(kind, draft, '/') };
    } else if (kind === 'snmp_oid') {
      where = { kind, target: '', port: null, snmp_target_id: draft.snmpTargetId, config: buildConfig(kind, draft, '/') };
    }
    setBusy(true);
    setError(null);
    try {
      await api('/checks', {
        method: 'POST',
        body: {
          site_id: site,
          name: effectiveName.trim(),
          role: effectiveRole,
          ...where,
          interval_seconds: Number(value('interval_seconds')),
          failure_threshold: Number(value('failure_threshold')),
          latency_warn_ms: num('latency_warn_ms'),
          loss_warn_pct: kind === 'icmp' ? num('loss_warn_pct') : null,
        },
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  const thresholdInput = (f: ThresholdField, label: string, min: number, max: number) => (
    <Field label={label}>
      {(id) => (
        <Input
          id={id}
          type="number"
          min={min}
          max={max}
          dir="ltr"
          required={f === 'interval_seconds' || f === 'failure_threshold'}
          value={value(f)}
          onChange={(e) => setTyped({ ...typed, [f]: e.target.value })}
        />
      )}
    </Field>
  );

  return (
    <Modal title={t('monitoring.addCheck')} onClose={onClose} wide={watch}>
      <form onSubmit={submit} className="space-y-3.5">
        {sites.length > 1 && (
          <Field label={t('common.site')}>
            {(id) => (
              <Select
                id={id}
                value={site}
                required
                onChange={(e) => {
                  setSite(e.target.value);
                  if (picked && picked !== 'gateway') {
                    setPicked('');
                    setTarget('');
                  }
                }}
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label={t('monitoring.kind')}>
          {(id) => (
            <Select
              id={id}
              value={kind}
              onChange={(e) => {
                const next = e.target.value as CheckKind;
                setKind(next);
                if (next !== 'icmp' && target === AUTO_GATEWAY) {
                  setTarget('');
                  setPicked('');
                }
                if ((next === 'dns' || isWatchKind(next)) && picked) {
                  setPicked('');
                  setTarget('');
                }
                if (next === 'tls_expiry' && !port) setPort('443');
              }}
            >
              <optgroup label={t('monitoring.kindGroup.basic')}>
                {(['icmp', 'tcp', 'dns'] as const).map((k) => (
                  <option key={k} value={k}>
                    {t(`monitoring.kind.${k}`)}
                  </option>
                ))}
              </optgroup>
              <optgroup label={t('monitoring.kindGroup.watch')}>
                {WATCH_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`monitoring.kind.${k}`)}
                  </option>
                ))}
              </optgroup>
            </Select>
          )}
        </Field>
        {(kind === 'icmp' || kind === 'tcp') && (
          <Field label={t('monitoring.pickDevice')} hint={t('monitoring.pickDeviceHint')}>
            {(id) => (
              <Select id={id} value={picked} onChange={(e) => pick(e.target.value)}>
                <option value="">{t('monitoring.pickNone')}</option>
                {kind === 'icmp' && <option value="gateway">{t('monitoring.pickGateway')}</option>}
                {choices.length > 0 && (
                  <optgroup label={t('monitoring.pickDevices')}>
                    {choices.map((d) => (
                      <option key={d.id} value={d.id}>
                        {deviceLabel(d)} · {d.current_ip} · {DEVICE_TYPE_LABEL[d.device_type]?.[locale] ?? d.device_type}
                      </option>
                    ))}
                  </optgroup>
                )}
              </Select>
            )}
          </Field>
        )}
        {(!watch || kind === 'tls_expiry') && (
        <div className={kind === 'tcp' || kind === 'tls_expiry' ? 'grid grid-cols-[minmax(0,1fr)_6rem] gap-3' : ''}>
          <Field label={t('monitoring.target')} hint={kind === 'icmp' ? fill(t('monitoring.targetHintIcmp'), { auto: AUTO_GATEWAY }) : undefined}>
            {(id) => (
              <Input
                id={id}
                value={target}
                onChange={(e) => {
                  setTarget(e.target.value);
                  setPicked('');
                }}
                required
                maxLength={253}
                dir="ltr"
                placeholder={kind === 'dns' ? 'example.com' : '192.168.1.10'}
              />
            )}
          </Field>
          {(kind === 'tcp' || kind === 'tls_expiry') && (
            <Field label={t('monitoring.port')}>{(id) => <Input id={id} type="number" min={1} max={65535} value={port} onChange={(e) => setPort(e.target.value)} required dir="ltr" />}</Field>
          )}
        </div>
        )}
        {watch && <WatchFields kind={kind} draft={draft} onChange={setDraft} siteId={site} mode="create" />}
        <Field label={t('common.name')} hint={name === null && generatedName ? t('monitoring.nameGenerated') : undefined}>
          {(id) => <Input id={id} value={effectiveName} onChange={(e) => setName(e.target.value)} required maxLength={80} />}
        </Field>
        <div>
          <Field label={t('monitoring.role')} hint={role === null && target.trim() ? t('monitoring.roleInferred') : undefined}>
            {(id) => (
              <Select id={id} value={effectiveRole} onChange={(e) => setRole(e.target.value as CheckRole)}>
                {(['service', 'gateway', 'internet', 'dns'] as const).map((r) => (
                  <option key={r} value={r}>
                    {t(`monitoring.role.${r}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {role === null && target.trim() && (
            <div className="mt-1.5">
              <Badge tone="info" dot={false}>
                {t('common.inferred')}
              </Badge>
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          {thresholdInput('interval_seconds', t('monitoring.interval'), 15, 3600)}
          {thresholdInput('failure_threshold', t('monitoring.threshold'), 1, 20)}
          {thresholdInput('latency_warn_ms', t('monitoring.latencyWarn'), 1, 60000)}
          {kind === 'icmp' && thresholdInput('loss_warn_pct', t('monitoring.lossWarn'), 0, 100)}
        </div>
        <p className="text-xs text-faint">{t('monitoring.thresholdsPrefilled')}</p>
        <p className="text-xs text-faint">{t('monitoring.measuredFrom')}</p>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!site || !effectiveName.trim()}>
            {t('common.add')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
