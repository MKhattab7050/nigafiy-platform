'use client';

import { CheckCircle2, Lock, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { Collector, Site } from '@lan-detective/shared-types';
import { Badge, Button, Fact, Field, Input, Modal, Notice, Select, Switch } from '@/components/ui';
import { api } from '@/lib/api';
import { absoluteTime, relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import type { FetchedCertificate, QueuedRequest, RouterDetail, RouterTransport, SiteRouter } from '../types';
import { ROUTER_TRANSPORTS, ROUTER_VENDORS } from '../types';
import { RequestProgress } from './request-progress';
import { Fingerprint, RouterErrorNote } from './text';

export function RouterWizardModal({
  siteId,
  sites,
  collectors,
  onClose,
  onSaved,
}: {
  siteId: string;
  sites?: Site[];
  collectors: Collector[];
  onClose: () => void;
  onSaved: (routerId: string) => void;
}) {
  const { t, locale } = useI18n();
  const [selectedSiteId, setSelectedSiteId] = useState(siteId);
  const siteCollectors = collectors.filter((c) => c.site_id === selectedSiteId);
  const detectedCollector = siteCollectors.find((c) => c.gateway_ip);
  const detectedGateway = detectedCollector?.gateway_ip ?? null;

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [vendor, setVendor] = useState<string>(ROUTER_VENDORS[0].value);
  const [address, setAddress] = useState(detectedGateway ?? '192.168.1.1');
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<RouterTransport>('https-pinned');
  const [port, setPort] = useState('');
  const [refreshMinutes, setRefreshMinutes] = useState('5');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [created, setCreated] = useState<SiteRouter | null>(null);
  const [certReq, setCertReq] = useState<QueuedRequest | null>(null);
  const [fetchedCert, setFetchedCert] = useState<FetchedCertificate | null>(null);
  const [trusted, setTrusted] = useState(false);
  const [readReq, setReadReq] = useState<QueuedRequest | null>(null);
  const [readDone, setReadDone] = useState(false);

  const defaultName = fill(t('routers.wizard.defaultName'), {
    vendor: ROUTER_VENDORS.find((v) => v.value === vendor)?.label ?? 'Zyxel',
    address: address.trim() || '192.168.1.1',
  });

  async function submitCredentials(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const mins = Math.min(1440, Math.max(2, Number(refreshMinutes) || 5));
      const portNum = port.trim() ? Number(port.trim()) : null;
      const router = await api<SiteRouter>('/routers', {
        method: 'POST',
        body: {
          site_id: selectedSiteId,
          name: (name.trim() || defaultName).slice(0, 80),
          vendor,
          address: address.trim(),
          port: portNum,
          transport,
          credentials: { username: username.trim(), password },
          refresh_interval_seconds: mins * 60,
          enabled: true,
        },
      });
      setCreated(router);
      if (transport === 'https-pinned') {
        setStep(3);
        const q = await api<QueuedRequest>(`/routers/${router.id}/certificate/fetch`, { method: 'POST' });
        setCertReq(q);
      } else {
        setStep(4);
      }
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function fetchCertAgain() {
    if (!created) return;
    setBusy(true);
    setError(null);
    try {
      const q = await api<QueuedRequest>(`/routers/${created.id}/certificate/fetch`, { method: 'POST' });
      setCertReq(q);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function trustCert() {
    if (!created || !fetchedCert) return;
    setBusy(true);
    setError(null);
    try {
      await api<SiteRouter>(`/routers/${created.id}/certificate/trust`, {
        method: 'POST',
        body: { sha256: fetchedCert.sha256 },
      });
      setTrusted(true);
      setStep(4);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function triggerFirstRead() {
    if (!created) return;
    setBusy(true);
    setError(null);
    try {
      const q = await api<QueuedRequest>(`/routers/${created.id}/refresh`, { method: 'POST' });
      setReadReq(q);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t('routers.wizard.title')} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex items-center justify-between text-xs text-muted">
          <span>{fill(t('routers.wizard.stepOf'), { n: step, total: 4 })}</span>
          <span className="font-medium text-fg">
            {step === 1
              ? t('routers.wizard.step.address')
              : step === 2
                ? t('routers.wizard.step.credentials')
                : step === 3
                  ? t('routers.wizard.step.certificate')
                  : t('routers.wizard.step.read')}
          </span>
        </div>

        {step === 1 && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setStep(2);
            }}
            className="space-y-4"
          >
            {sites && sites.length > 1 && (
              <Field label={t('routers.site')}>
                {(id) => (
                  <Select
                    id={id}
                    value={selectedSiteId}
                    onChange={(e) => {
                      const nextSite = e.target.value;
                      const nextGateway = collectors.find((c) => c.site_id === nextSite && c.gateway_ip)?.gateway_ip ?? null;
                      const prevDefault = detectedGateway ?? '192.168.1.1';
                      if (address === prevDefault) setAddress(nextGateway ?? '192.168.1.1');
                      setSelectedSiteId(nextSite);
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

            {detectedGateway && detectedCollector ? (
              <div className="rounded-[var(--radius-control)] border border-line-strong bg-sunken px-3 py-2.5 text-xs">
                <span className="font-medium text-fg">{t('routers.wizard.detected')}: </span>
                <span className="mono text-accent-hover">{detectedGateway}</span>
                <span className="ms-1.5 text-muted">
                  ({fill(t('routers.wizard.detectedBy'), { collector: detectedCollector.name })})
                </span>
              </div>
            ) : (
              <p className="text-xs text-muted">{t('routers.wizard.noDetected')}</p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('routers.vendor')} hint={t('routers.wizard.vendorHint')}>
                {(id) => (
                  <Select id={id} value={vendor} onChange={(e) => setVendor(e.target.value)}>
                    {ROUTER_VENDORS.map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('routers.address')}>
                {(id) => (
                  <Input
                    id={id}
                    className="mono"
                    dir="ltr"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    required
                  />
                )}
              </Field>
            </div>

            <Field label={t('routers.name')}>
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  placeholder={defaultName}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={80}
                />
              )}
            </Field>

            <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
              <Field label={t('routers.transport')}>
                {(id) => (
                  <Select id={id} value={transport} onChange={(e) => setTransport(e.target.value as RouterTransport)}>
                    {ROUTER_TRANSPORTS.map((tr) => (
                      <option key={tr} value={tr}>
                        {t(`routers.transport.${tr}`)}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label={t('routers.port')} hint={t('routers.portHint')}>
                {(id) => (
                  <Input
                    id={id}
                    type="number"
                    min={1}
                    max={65535}
                    className="mono"
                    dir="ltr"
                    placeholder={transport === 'http' ? '80' : '443'}
                    value={port}
                    onChange={(e) => setPort(e.target.value)}
                  />
                )}
              </Field>
            </div>

            {transport === 'http' && (
              <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-warn/40 bg-warn/10 p-3 text-xs text-fg">
                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
                <span>{t('routers.httpWarning')}</span>
              </div>
            )}

            <Field label={`${t('routers.refreshInterval')} (${t('routers.minutes')})`} hint={t('routers.refreshIntervalHint')}>
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={2}
                  max={1440}
                  className="mono sm:max-w-36"
                  dir="ltr"
                  value={refreshMinutes}
                  onChange={(e) => setRefreshMinutes(e.target.value)}
                />
              )}
            </Field>

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button type="submit" variant="primary" disabled={!address.trim()}>
                {t('routers.wizard.next')}
              </Button>
            </div>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={submitCredentials} className="space-y-4">
            <p className="text-[13px] leading-relaxed text-muted">{t('routers.wizard.credentialsIntro')}</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t('routers.wizard.username')}>
                {(id) => (
                  <Input
                    id={id}
                    dir="ltr"
                    autoComplete="off"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Field label={t('routers.wizard.password')}>
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    dir="ltr"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                )}
              </Field>
            </div>

            <RouterErrorNote error={error} />

            <div className="flex justify-between gap-2 pt-1">
              <Button variant="ghost" onClick={() => setStep(1)}>
                {t('routers.wizard.back')}
              </Button>
              <div className="flex gap-2">
                <Button variant="ghost" onClick={onClose}>
                  {t('common.cancel')}
                </Button>
                <Button type="submit" variant="primary" busy={busy} disabled={!username.trim() || !password}>
                  {t('routers.wizard.save')}
                </Button>
              </div>
            </div>
          </form>
        )}

        {step === 3 && created && (
          <div className="space-y-4">
            <Notice>{t('routers.wizard.saved')}</Notice>
            <p className="text-[13px] leading-relaxed text-muted">{t('routers.cert.intro')}</p>

            {certReq && (
              <RequestProgress
                requestId={certReq.request_id}
                routerId={created.id}
                collector={certReq.collector}
                onSettled={(r) => {
                  if (r.status === 'completed' && r.result?.certificate) {
                    setFetchedCert(r.result.certificate);
                  }
                }}
                onRetry={() => void fetchCertAgain()}
              />
            )}

            {fetchedCert && (
              <div className="space-y-3 rounded-[var(--radius-control)] border border-line-strong bg-sunken p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-fg">
                    <Lock className="size-3.5 text-accent-hover" aria-hidden />
                    {t('routers.cert.fingerprint')}
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {fetchedCert.self_signed && <Badge tone="info">{t('routers.cert.selfSigned').split(':')[0]}</Badge>}
                    {fetchedCert.expired && <Badge tone="warn">{t('routers.cert.expired').split('.')[0]}</Badge>}
                    {fetchedCert.system_trust && <Badge tone="ok">{t('routers.cert.systemTrusted')}</Badge>}
                  </div>
                </div>
                <Fingerprint value={fetchedCert.sha256} />
                <p className="text-xs text-muted">{t('routers.cert.compare')}</p>
                <dl>
                  <Fact label={t('routers.cert.subject')}>{fetchedCert.subject}</Fact>
                  <Fact label={t('routers.cert.issuer')}>{fetchedCert.issuer}</Fact>
                  <Fact label={t('routers.cert.validity')}>
                    {fill(t('routers.cert.validRange'), {
                      from: absoluteTime(fetchedCert.not_before, locale),
                      to: absoluteTime(fetchedCert.not_after, locale),
                    })}
                  </Fact>
                </dl>
              </div>
            )}

            <RouterErrorNote error={error} routerId={created.id} />

            <div className="flex flex-wrap justify-between gap-2 pt-1">
              <Button
                variant="ghost"
                onClick={() => {
                  onSaved(created.id);
                  onClose();
                }}
              >
                {t('routers.wizard.later')}
              </Button>
              <div className="flex gap-2">
                <Button variant="secondary" busy={busy} onClick={() => void fetchCertAgain()}>
                  {t(fetchedCert ? 'routers.cert.refetch' : 'routers.cert.fetch')}
                </Button>
                {fetchedCert && (
                  <Button variant="primary" busy={busy} onClick={() => void trustCert()}>
                    <ShieldCheck className="size-4" aria-hidden />
                    {t('routers.cert.trust')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}

        {step === 4 && created && (
          <div className="space-y-4">
            <Notice>
              <span className="inline-flex items-center gap-2 font-medium">
                <CheckCircle2 className="size-4 text-ok" aria-hidden />
                {trusted ? t('routers.cert.trusted') : t('routers.wizard.saved')}
              </span>
            </Notice>
            <p className="text-[13px] leading-relaxed text-muted">{t('routers.wizard.readIntro')}</p>

            {readReq && (
              <RequestProgress
                requestId={readReq.request_id}
                routerId={created.id}
                collector={readReq.collector}
                onSettled={(r) => {
                  if (r.status === 'completed') setReadDone(true);
                }}
                onRetry={() => void triggerFirstRead()}
              />
            )}

            <RouterErrorNote error={error} routerId={created.id} />

            <div className="flex justify-end gap-2 pt-1">
              {!readReq && (
                <Button variant="secondary" busy={busy} onClick={() => void triggerFirstRead()}>
                  {t('routers.readNow')}
                </Button>
              )}
              <Button
                variant="primary"
                onClick={() => {
                  onSaved(created.id);
                  onClose();
                }}
              >
                {t(readDone || readReq ? 'routers.wizard.finish' : 'routers.wizard.later')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export function EditRouterModal({
  router,
  initialReplaceCredentials = false,
  onClose,
  onSaved,
}: {
  router: SiteRouter | RouterDetail;
  initialReplaceCredentials?: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(router.name);
  const [transport, setTransport] = useState<RouterTransport>(router.transport);
  const [port, setPort] = useState(router.port ? String(router.port) : '');
  const [refreshMinutes, setRefreshMinutes] = useState(String(Math.max(2, Math.round(router.refresh_interval_seconds / 60))));
  const [enabled, setEnabled] = useState(router.enabled);
  const [replaceCreds, setReplaceCreds] = useState(initialReplaceCredentials);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const transportChanged = transport !== router.transport || (port.trim() ? Number(port.trim()) : null) !== router.port;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const mins = Math.min(1440, Math.max(2, Number(refreshMinutes) || 5));
      await api(`/routers/${router.id}`, {
        method: 'PATCH',
        body: {
          name: name.trim(),
          transport,
          port: port.trim() ? Number(port.trim()) : null,
          refresh_interval_seconds: mins * 60,
          enabled,
          ...(replaceCreds && username.trim() && password
            ? { credentials: { username: username.trim(), password } }
            : {}),
        },
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={fill(t('routers.editTitle'), { name: router.name })} onClose={onClose} wide>
      <form onSubmit={save} className="space-y-4">
        <Field label={t('routers.name')}>
          {(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />}
        </Field>

        <div className="grid gap-3 sm:grid-cols-[1fr_9rem]">
          <Field label={t('routers.transport')}>
            {(id) => (
              <Select id={id} value={transport} onChange={(e) => setTransport(e.target.value as RouterTransport)}>
                {ROUTER_TRANSPORTS.map((tr) => (
                  <option key={tr} value={tr}>
                    {t(`routers.transport.${tr}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t('routers.port')} hint={t('routers.portHint')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={1}
                max={65535}
                className="mono"
                dir="ltr"
                placeholder={transport === 'http' ? '80' : '443'}
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            )}
          </Field>
        </div>

        {transportChanged && router.pin_sha256 && (
          <p className="text-xs text-warn">{t('routers.transportChangeNote')}</p>
        )}

        {transport === 'http' && (
          <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-warn/40 bg-warn/10 p-3 text-xs text-fg">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" aria-hidden />
            <span>{t('routers.httpWarning')}</span>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={`${t('routers.refreshInterval')} (${t('routers.minutes')})`} hint={t('routers.refreshIntervalHint')}>
            {(id) => (
              <Input
                id={id}
                type="number"
                min={2}
                max={1440}
                className="mono"
                dir="ltr"
                value={refreshMinutes}
                onChange={(e) => setRefreshMinutes(e.target.value)}
              />
            )}
          </Field>
          <div className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-line bg-sunken px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium text-fg">{t('routers.enabled')}</p>
              <p className="text-[11px] text-muted">{t('routers.enabledHint')}</p>
            </div>
            <Switch checked={enabled} onChange={setEnabled} label={t('routers.enabled')} />
          </div>
        </div>

        <div className="rounded-[var(--radius-control)] border border-line bg-sunken p-3.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium text-fg">{t('routers.replaceCredentials')}</p>
              <p className="text-[11px] text-muted">{t('routers.replaceCredentialsHint')}</p>
            </div>
            <Switch checked={replaceCreds} onChange={setReplaceCreds} label={t('routers.replaceCredentials')} />
          </div>
          {replaceCreds && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <Field label={t('routers.wizard.username')}>
                {(id) => <Input id={id} dir="ltr" autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} required />}
              </Field>
              <Field label={t('routers.wizard.password')}>
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    dir="ltr"
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                  />
                )}
              </Field>
            </div>
          )}
        </div>

        <RouterErrorNote error={error} />

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || (replaceCreds && (!username.trim() || !password))}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function CertTrustModal({
  router,
  onClose,
  onTrusted,
}: {
  router: RouterDetail;
  onClose: () => void;
  onTrusted: () => void;
}) {
  const { t, locale } = useI18n();
  const [certReq, setCertReq] = useState<QueuedRequest | null>(null);
  const [fetched, setFetched] = useState<FetchedCertificate | null>(router.certificate.fetched);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const differs = Boolean(router.certificate.pinned && fetched?.sha256 && router.certificate.pinned !== fetched.sha256);

  async function fetchCert() {
    setBusy(true);
    setError(null);
    try {
      const q = await api<QueuedRequest>(`/routers/${router.id}/certificate/fetch`, { method: 'POST' });
      setCertReq(q);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  async function trustCert() {
    if (!fetched) return;
    setBusy(true);
    setError(null);
    try {
      await api<SiteRouter>(`/routers/${router.id}/certificate/trust`, {
        method: 'POST',
        body: { sha256: fetched.sha256 },
      });
      onTrusted();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={t('routers.cert.title')} onClose={onClose} wide>
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-muted">{t('routers.cert.intro')}</p>

        {differs && (
          <div className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-crit/40 bg-crit/10 p-3 text-xs text-fg">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-crit" aria-hidden />
            <span>{t('routers.cert.differs')}</span>
          </div>
        )}

        {router.certificate.pinned && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-muted">{t('routers.cert.trusted')}</span>
              {router.certificate.pinned_at && (
                <span className="text-faint" title={absoluteTime(router.certificate.pinned_at, locale)}>
                  {fill(t('routers.cert.trustedAt'), { when: relativeTime(router.certificate.pinned_at, locale) })}
                </span>
              )}
            </div>
            <Fingerprint value={router.certificate.pinned} />
          </div>
        )}

        {certReq && (
          <RequestProgress
            requestId={certReq.request_id}
            routerId={router.id}
            collector={certReq.collector}
            onSettled={(r) => {
              if (r.status === 'completed' && r.result?.certificate) {
                setFetched(r.result.certificate);
              }
            }}
            onRetry={() => void fetchCert()}
          />
        )}

        {fetched ? (
          <div className="space-y-3 rounded-[var(--radius-control)] border border-line-strong bg-sunken p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-fg">{t('routers.cert.fingerprint')}</span>
              <div className="flex flex-wrap gap-1.5">
                {fetched.self_signed && <Badge tone="info">{t('routers.cert.selfSigned').split(':')[0]}</Badge>}
                {fetched.expired && <Badge tone="warn">{t('routers.cert.expired').split('.')[0]}</Badge>}
                {fetched.system_trust && <Badge tone="ok">{t('routers.cert.systemTrusted')}</Badge>}
              </div>
            </div>
            <Fingerprint value={fetched.sha256} />
            <p className="text-xs text-muted">{t('routers.cert.compare')}</p>
            <dl>
              <Fact label={t('routers.cert.subject')}>{fetched.subject}</Fact>
              <Fact label={t('routers.cert.issuer')}>{fetched.issuer}</Fact>
              <Fact label={t('routers.cert.validity')}>
                {fill(t('routers.cert.validRange'), {
                  from: absoluteTime(fetched.not_before, locale),
                  to: absoluteTime(fetched.not_after, locale),
                })}
              </Fact>
            </dl>
          </div>
        ) : (
          <p className="text-xs text-muted">{t('routers.cert.none')}</p>
        )}

        <RouterErrorNote error={error} routerId={router.id} />

        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>
            {t('common.close')}
          </Button>
          <Button variant="secondary" busy={busy} onClick={() => void fetchCert()}>
            {t(fetched ? 'routers.cert.refetch' : 'routers.cert.fetch')}
          </Button>
          {fetched && fetched.sha256 !== router.certificate.pinned && (
            <Button variant="primary" busy={busy} onClick={() => void trustCert()}>
              <ShieldCheck className="size-4" aria-hidden />
              {t('routers.cert.trust')}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function DeleteRouterModal({
  router,
  onClose,
  onDeleted,
}: {
  router: SiteRouter | RouterDetail;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function confirmDelete() {
    setBusy(true);
    setError(null);
    try {
      await api(`/routers/${router.id}`, { method: 'DELETE' });
      onDeleted();
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={fill(t('routers.deleteTitle'), { name: router.name })} onClose={onClose}>
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-muted">{t('routers.deleteBody')}</p>
        <p className="rounded-[var(--radius-control)] border border-warn/30 bg-warn/[0.08] px-3 py-2.5 text-xs leading-relaxed text-fg">
          {t('routers.deleteBlocks')}
        </p>
        <RouterErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="danger" busy={busy} onClick={() => void confirmDelete()}>
            {t('routers.deleteConfirm')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
