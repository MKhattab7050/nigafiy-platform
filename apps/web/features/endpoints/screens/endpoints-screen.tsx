'use client';

import { Cpu, Plus } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { EndpointComplianceStatus, EndpointCreated, EndpointEnrollmentSuggestion, EndpointPlatform, EndpointSummary } from '@lan-detective/shared-types';
import { Async, Button, CopyBlock, ErrorNote, Field, InferredBadge, Input, Modal, Notice, PageHeader, Select, SkeletonBlock, SuggestedBadge } from '@/components/ui';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp, useQuery } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';
import { FleetContent } from '../components/fleet-content';
import { endpointsText } from '../text';

export function EndpointsScreen() {
  const { locale, t } = useI18n();
  const tx = endpointsText(locale);
  const { sites, siteId, can } = useApp();
  const query = useQuery<{ items: EndpointSummary[] }>(`/endpoints${qs({ site_id: siteId })}`, ['devices'], 8_000);

  const [platformFilter, setPlatformFilter] = useState<'all' | EndpointPlatform>('all');
  const [complianceFilter, setComplianceFilter] = useState<'all' | EndpointComplianceStatus>('all');

  const [showAdd, setShowAdd] = useState(false);
  const [chosenSite, setChosenSite] = useState('');
  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<EndpointPlatform>('windows');
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [issued, setIssued] = useState<EndpointCreated | null>(null);
  // Prefill for enrolling a discovered device (GET /devices/:id/enrollment-suggestion); every value stays editable.
  const [suggestion, setSuggestion] = useState<EndpointEnrollmentSuggestion | null>(null);
  const [suggesting, setSuggesting] = useState(false);

  useEffect(() => {
    const enrollDevice = new URLSearchParams(window.location.search).get('enroll_device');
    if (!enrollDevice || !can('admin')) return;
    setDeviceId(enrollDevice);
    setShowAdd(true);
    setSuggesting(true);
    api<EndpointEnrollmentSuggestion>(`/devices/${encodeURIComponent(enrollDevice)}/enrollment-suggestion`)
      .then((s) => {
        setSuggestion(s);
        setName(s.suggested_name);
        setPlatform(s.suggested_platform);
        setChosenSite(s.site_id);
      })
      .catch((err: ApiError) => setError(err))
      .finally(() => setSuggesting(false));
  }, [can]);

  const openBlank = () => {
    setSuggestion(null);
    setDeviceId(null);
    setName('');
    setPlatform('windows');
    setShowAdd(true);
  };

  const activeSite = chosenSite || siteId || sites[0]?.id || '';

  async function createEndpoint(e: React.FormEvent) {
    e.preventDefault();
    if (!activeSite || !name.trim()) return;
    setBusy('create');
    setError(null);
    try {
      const created = await api<EndpointCreated>('/endpoints', {
        method: 'POST',
        body: {
          site_id: activeSite,
          name: name.trim(),
          platform,
          device_id: deviceId,
        },
      });
      setShowAdd(false);
      setName('');
      setDeviceId(null);
      setSuggestion(null);
      setIssued(created);
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function reissueToken(id: string) {
    setBusy(`reissue-${id}`);
    setError(null);
    try {
      const res = await api<EndpointCreated>(`/endpoints/${id}/enrollment-token`, { method: 'POST' });
      setIssued(res);
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  async function revokeEndpoint(id: string) {
    if (!window.confirm(tx.revokeConfirm)) return;
    setBusy(`revoke-${id}`);
    setError(null);
    try {
      await api(`/endpoints/${id}/revoke`, { method: 'POST' });
      query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      <PageHeader icon={<Cpu className="size-[18px]" aria-hidden />}
        title={tx.title}
        description={tx.subtitle}
        actions={
          can('admin') ? (
            <Button variant="primary" onClick={openBlank}>
              <Plus className="size-4" aria-hidden />
              {tx.addEndpoint}
            </Button>
          ) : undefined
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorNote error={error} />
        </div>
      )}

      <Async query={query}>
        {({ items }) => (
          <FleetContent
            items={items}
            platformFilter={platformFilter}
            setPlatformFilter={setPlatformFilter}
            complianceFilter={complianceFilter}
            setComplianceFilter={setComplianceFilter}
            busy={busy}
            canAdmin={can('admin')}
            onAdd={openBlank}
            onReissue={reissueToken}
            onRevoke={revokeEndpoint}
          />
        )}
      </Async>

      {showAdd && (
        <Modal title={tx.addEndpoint} onClose={() => setShowAdd(false)}>
          <form onSubmit={createEndpoint} className="space-y-4">
            {suggesting && (
              <div>
                <p className="mb-1 text-xs text-muted">{t('endpoints.enroll.loading')}</p>
                <SkeletonBlock lines={2} />
              </div>
            )}
            {suggestion?.existing_endpoint_id && (
              <Notice>
                {t('endpoints.enroll.existing')}{' '}
                <Link href={`/fleet/endpoints/${suggestion.existing_endpoint_id}`} className="font-medium text-accent-hover hover:underline">
                  {t('endpoints.enroll.openExisting')}
                </Link>
              </Notice>
            )}
            {sites.length > 1 && (
              <Field label={t('common.site')}>
                {(id) => (
                  <Select id={id} value={activeSite} onChange={(e) => setChosenSite(e.target.value)}>
                    {sites.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <Field label={tx.endpointName} hint={suggestion && name === suggestion.suggested_name ? t('endpoints.enroll.nameFromDevice') : undefined}>
              {(id) => (
                <Input
                  id={id}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={tx.endpointNamePlaceholder}
                  maxLength={80}
                  required
                />
              )}
            </Field>
            <Field label={tx.platformLabel}>
              {(id) => (
                <Select id={id} value={platform} onChange={(e) => setPlatform(e.target.value as EndpointPlatform)}>
                  <option value="windows">{tx.platformOptions.windows}</option>
                  <option value="linux">{tx.platformOptions.linux}</option>
                  <option value="macos">{tx.platformOptions.macos}</option>
                </Select>
              )}
            </Field>
            {suggestion && platform === suggestion.suggested_platform && (
              <div className="-mt-2 space-y-1.5">
                {suggestion.platform_source === 'default' ? (
                  <>
                    <SuggestedBadge>{t('common.default')}</SuggestedBadge>
                    <p className="text-xs text-faint">{t('endpoints.enroll.platformDefault')}</p>
                  </>
                ) : (
                  <>
                    <InferredBadge confidence={suggestion.platform_confidence} />
                    <p className="text-xs text-faint">{t('endpoints.enroll.platformInferred')}</p>
                    <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted" dir="auto">
                      {suggestion.platform_evidence.map((e) => (
                        <li key={e}>{e}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button onClick={() => setShowAdd(false)}>{t('common.cancel')}</Button>
              <Button type="submit" variant="primary" busy={busy === 'create'}>
                {tx.create}
              </Button>
            </div>
          </form>
        </Modal>
      )}

      {issued && (
        <Modal title={tx.tokenModalTitle} onClose={() => setIssued(null)} wide>
          <div className="space-y-4">
            <p className="text-[13px] text-muted">{tx.tokenOnce}</p>
            <CopyBlock label={tx.tokenLabel} value={issued.enrollment_token} />

            <InstallCommands issued={issued} />
          </div>
        </Modal>
      )}
    </>
  );
}

/** Agent install commands for the issued token, pointed at the server address the API reported. */
function InstallCommands({ issued }: { issued: EndpointCreated }) {
  const { locale, t } = useI18n();
  const tx = endpointsText(locale);
  const server = issued.server_url.replace(/\/+$/, '');
  const insecure = server.startsWith('http://');
  const flags = `-server ${server}${insecure ? ' -allow-insecure-http' : ''} -token ${issued.enrollment_token}`;
  let local = false;
  try {
    local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(server).hostname);
  } catch {
    /* not a URL: show only the generic commands */
  }
  return (
    <>
      {local && <CopyBlock label={tx.installLocal} multiline value={`pnpm build:agent && ./agents/endpoint-agent/bin/endpoint-agent ${flags}`} />}
      {issued.endpoint.platform === 'windows' && <CopyBlock label={tx.installWindows} multiline value={`endpoint-agent.exe ${flags}`} />}
      {issued.endpoint.platform === 'linux' && <CopyBlock label={tx.installLinux} multiline value={`sudo ./endpoint-agent ${flags}`} />}
      {issued.endpoint.platform === 'macos' && <CopyBlock label={tx.installMacos} multiline value={`sudo ./endpoint-agent ${flags}`} />}
      {issued.server_url_source === 'request' && <p className="text-xs text-muted">{fill(t('endpoints.install.serverFromRequest'), { url: server })}</p>}
      {insecure && <p className="text-xs text-warn">{t('endpoints.install.insecure')}</p>}
    </>
  );
}
