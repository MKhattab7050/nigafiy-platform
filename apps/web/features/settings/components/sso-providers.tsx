'use client';

import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import type { IdentityProvider, IdentityProviderKind, IdentityProviderRoleMapping, SsoAssignableRole } from '@nigafiy/shared-types';
import { Async, Badge, Button, Card, CopyBlock, EmptyState, ErrorNote, Field, Input, Modal, Select, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { type Key, fill, useI18n } from '@/lib/i18n';

const ROLES: SsoAssignableRole[] = ['viewer', 'technician', 'admin'];

interface CheckResult {
  ok: boolean;
  checks: Array<{ check: string; ok: boolean; detail: string }>;
}

/** Settings → Single sign-on: the organization's OIDC / SAML identity providers (owner and admin). */
export function SsoProviders() {
  const { t, tn } = useI18n();
  const query = useQuery<{ items: IdentityProvider[] }>('/sso/providers', [], 60_000);
  const [editing, setEditing] = useState<IdentityProvider | 'new-oidc' | 'new-saml' | null>(null);
  const [checks, setChecks] = useState<Record<string, CheckResult | ApiError>>({});
  const [busy, setBusy] = useState<string | null>(null);

  async function runCheck(p: IdentityProvider) {
    setBusy(p.id);
    try {
      const res = await api<CheckResult>(`/sso/providers/${p.id}/check`, { method: 'POST', body: {} });
      setChecks((c) => ({ ...c, [p.id]: res }));
    } catch (err) {
      setChecks((c) => ({ ...c, [p.id]: err as ApiError }));
    } finally {
      setBusy(null);
    }
  }

  async function remove(p: IdentityProvider) {
    if (!window.confirm(fill(t('settings.sso.deleteConfirm'), { name: p.name }))) return;
    setBusy(p.id);
    try {
      await api(`/sso/providers/${p.id}`, { method: 'DELETE' });
      query.reload();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title={t('settings.sso.title')}
      description={t('settings.sso.desc')}
      action={
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={() => setEditing('new-oidc')}>
            <Plus className="size-3.5" aria-hidden />
            {t('settings.sso.addOidc')}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setEditing('new-saml')}>
            <Plus className="size-3.5" aria-hidden />
            {t('settings.sso.addSaml')}
          </Button>
        </div>
      }
    >
      <Async query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <EmptyState icon={<KeyRound className="size-8" />} title={t('settings.sso.empty')}>
              <p className="max-w-md text-[13px] text-muted">{t('settings.sso.emptyHint')}</p>
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {data.items.map((p) => {
                const check = checks[p.id];
                return (
                  <li key={p.id} className="py-3 first:pt-0 last:pb-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium" dir="auto">
                        {p.name}
                      </span>
                      <Badge tone="idle" dot={false}>
                        {p.kind === 'oidc' ? 'OIDC' : 'SAML 2.0'}
                      </Badge>
                      <Badge tone={p.enabled ? 'ok' : 'idle'}>{p.enabled ? t('settings.sso.enabled') : t('settings.sso.disabled')}</Badge>
                      {p.jit_provisioning && <Badge tone="info" dot={false}>{t('settings.sso.jit')}</Badge>}
                      <span className="ms-auto flex gap-1.5">
                        <Button size="sm" variant="ghost" busy={busy === p.id} onClick={() => runCheck(p)}>
                          {t('settings.sso.check')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                          {t('common.edit')}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => remove(p)}>
                          {t('common.delete')}
                        </Button>
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-muted">
                      {t('settings.sso.domains')}:{' '}
                      {p.allowed_email_domains.map((d) => (
                        <bdi key={d} className="mono me-1.5" dir="ltr">
                          {d}
                        </bdi>
                      ))}
                      · {fill(tn('settings.sso.linked', p.linked_users), { n: p.linked_users })} · {t('settings.sso.mfaLabel')}: {p.trust_idp_mfa ? t('settings.sso.mfaIdp') : t('settings.sso.mfaLocal')}
                    </p>
                    {check && 'checks' in check && (
                      <ul className="mt-2 space-y-0.5 text-xs">
                        {check.checks.map((c) => (
                          <li key={c.check} className={c.ok ? 'text-ok' : 'text-crit'}>
                            {c.ok ? '✓' : '✗'} <span className="mono">{c.check}</span>:{' '}
                            <span className="mono break-all" dir="ltr">
                              {c.detail}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    {check && !('checks' in check) && (
                      <div className="mt-2">
                        <ErrorNote error={check} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        }
      </Async>
      {editing && (
        <ProviderModal
          provider={typeof editing === 'string' ? null : editing}
          kind={typeof editing === 'string' ? (editing === 'new-oidc' ? 'oidc' : 'saml') : editing.kind}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            query.reload();
          }}
        />
      )}
    </Card>
  );
}

function ProviderModal({ provider, kind, onClose, onSaved }: { provider: IdentityProvider | null; kind: IdentityProviderKind; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState(() => ({
    name: provider?.name ?? (kind === 'oidc' ? 'OpenID Connect' : 'SAML'),
    enabled: provider?.enabled ?? true,
    oidc_issuer: provider?.oidc_issuer ?? '',
    oidc_client_id: provider?.oidc_client_id ?? '',
    oidc_client_secret: '',
    clear_secret: false,
    oidc_scopes: provider?.oidc_scopes ?? 'openid email profile',
    saml_entry_point: provider?.saml_entry_point ?? '',
    saml_idp_entity_id: provider?.saml_idp_entity_id ?? '',
    saml_idp_cert: provider?.saml_idp_cert ?? '',
    saml_request_binding: provider?.saml_request_binding ?? 'redirect',
    email_attribute: provider?.email_attribute ?? 'email',
    name_attribute: provider?.name_attribute ?? '',
    role_attribute: provider?.role_attribute ?? '',
    role_mapping: provider?.role_mapping ?? ([] as IdentityProviderRoleMapping[]),
    domains: provider?.allowed_email_domains.join(', ') ?? '',
    jit_provisioning: provider?.jit_provisioning ?? false,
    default_role: provider?.default_role ?? ('viewer' as SsoAssignableRole),
    trust_idp_mfa: provider?.trust_idp_mfa ?? true,
  }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((prev) => ({ ...prev, [k]: v }));
  const fieldError = (path: string) => error?.details?.find((d) => d.path === path || d.path.startsWith(`${path}.`))?.message;

  async function save() {
    setBusy(true);
    setError(null);
    const common = {
      name: f.name.trim(),
      enabled: f.enabled,
      email_attribute: f.email_attribute.trim() || 'email',
      name_attribute: f.name_attribute.trim() || null,
      role_attribute: f.role_attribute.trim() || null,
      role_mapping: f.role_mapping.filter((m) => m.value.trim()),
      allowed_email_domains: f.domains.split(/[\s,;،]+/).filter(Boolean),
      jit_provisioning: f.jit_provisioning,
      default_role: f.default_role,
      trust_idp_mfa: f.trust_idp_mfa,
    };
    const specific =
      kind === 'oidc'
        ? {
            oidc_issuer: f.oidc_issuer.trim(),
            oidc_client_id: f.oidc_client_id.trim(),
            oidc_scopes: f.oidc_scopes.trim(),
            ...(f.oidc_client_secret ? { oidc_client_secret: f.oidc_client_secret } : {}),
            ...(provider && f.clear_secret && !f.oidc_client_secret ? { clear_oidc_client_secret: true } : {}),
          }
        : { saml_entry_point: f.saml_entry_point.trim(), saml_idp_entity_id: f.saml_idp_entity_id.trim(), saml_idp_cert: f.saml_idp_cert, saml_request_binding: f.saml_request_binding };
    try {
      if (provider) await api(`/sso/providers/${provider.id}`, { method: 'PATCH', body: { ...common, ...specific } });
      else await api('/sso/providers', { method: 'POST', body: { kind, ...common, ...specific } });
      onSaved();
    } catch (err) {
      setError(err as ApiError);
      setBusy(false);
    }
  }

  const toggle = (k: 'enabled' | 'jit_provisioning' | 'trust_idp_mfa', label: Key, hint: Key) => (
    <label className="flex cursor-pointer items-start gap-2.5 sm:col-span-2">
      <input type="checkbox" checked={f[k]} onChange={(e) => set(k, e.target.checked)} className="mt-0.5 size-4 accent-[var(--color-accent)]" />
      <span>
        <span className="block text-[13px] font-medium text-fg">{t(label)}</span>
        <span className="block text-xs text-muted">{t(hint)}</span>
      </span>
    </label>
  );

  return (
    <Modal title={provider ? fill(t('settings.sso.editTitle'), { name: provider.name }) : kind === 'oidc' ? t('settings.sso.addOidc') : t('settings.sso.addSaml')} onClose={onClose} wide>
      {provider && (
        <div className="mb-4 space-y-2 rounded-md border border-line bg-sunken p-3">
          <p className="text-xs font-medium text-fg">{t('settings.sso.spInfo')}</p>
          {kind === 'oidc' ? (
            <CopyBlock label={t('settings.sso.redirectUri')} value={provider.service_provider.oidc_redirect_uri} />
          ) : (
            <>
              <CopyBlock label={t('settings.sso.acsUrl')} value={provider.service_provider.saml_acs_url} />
              <CopyBlock label={t('settings.sso.entityId')} value={provider.service_provider.saml_entity_id} />
              <CopyBlock label={t('settings.sso.metadataUrl')} value={provider.service_provider.saml_metadata_url} />
            </>
          )}
        </div>
      )}
      {!provider && <p className="mb-3 text-xs text-muted">{t('settings.sso.spAfterSave')}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('common.name')} error={fieldError('name')}>
          {(id) => <Input id={id} value={f.name} onChange={(e) => set('name', e.target.value)} maxLength={80} />}
        </Field>
        <Field label={t('settings.sso.domains')} hint={t('settings.sso.domainsHint')} error={fieldError('allowed_email_domains')}>
          {(id) => <Input id={id} dir="ltr" value={f.domains} onChange={(e) => set('domains', e.target.value)} placeholder="example.com" maxLength={1000} />}
        </Field>
        {kind === 'oidc' ? (
          <>
            <Field label={t('settings.sso.issuer')} hint={t('settings.sso.issuerHint')} error={fieldError('oidc_issuer')}>
              {(id) => <Input id={id} dir="ltr" value={f.oidc_issuer} onChange={(e) => set('oidc_issuer', e.target.value)} placeholder="https://login.example.com" maxLength={500} />}
            </Field>
            <Field label={t('settings.sso.clientId')} error={fieldError('oidc_client_id')}>
              {(id) => <Input id={id} dir="ltr" value={f.oidc_client_id} onChange={(e) => set('oidc_client_id', e.target.value)} maxLength={300} />}
            </Field>
            <Field label={t('settings.sso.clientSecret')} hint={provider?.oidc_client_secret_set ? t('settings.sso.secretSet') : t('settings.sso.secretHint')} error={fieldError('oidc_client_secret')}>
              {(id) => <Input id={id} dir="ltr" type="password" autoComplete="new-password" value={f.oidc_client_secret} onChange={(e) => set('oidc_client_secret', e.target.value)} maxLength={2000} />}
            </Field>
            <Field label={t('settings.sso.scopes')} error={fieldError('oidc_scopes')}>
              {(id) => <Input id={id} dir="ltr" value={f.oidc_scopes} onChange={(e) => set('oidc_scopes', e.target.value)} maxLength={300} />}
            </Field>
            {provider?.oidc_client_secret_set && (
              <label className="flex items-center gap-2 text-xs text-muted sm:col-span-2">
                <input type="checkbox" checked={f.clear_secret} onChange={(e) => set('clear_secret', e.target.checked)} className="size-4 accent-[var(--color-accent)]" />
                {t('settings.sso.clearSecret')}
              </label>
            )}
          </>
        ) : (
          <>
            <Field label={t('settings.sso.entryPoint')} error={fieldError('saml_entry_point')}>
              {(id) => <Input id={id} dir="ltr" value={f.saml_entry_point} onChange={(e) => set('saml_entry_point', e.target.value)} placeholder="https://idp.example.com/sso/saml" maxLength={500} />}
            </Field>
            <Field label={t('settings.sso.idpEntityId')} error={fieldError('saml_idp_entity_id')}>
              {(id) => <Input id={id} dir="ltr" value={f.saml_idp_entity_id} onChange={(e) => set('saml_idp_entity_id', e.target.value)} maxLength={500} />}
            </Field>
            <Field label={t('settings.sso.binding')}>
              {(id) => (
                <Select id={id} value={f.saml_request_binding} onChange={(e) => set('saml_request_binding', e.target.value as 'redirect' | 'post')}>
                  <option value="redirect">HTTP-Redirect</option>
                  <option value="post">HTTP-POST</option>
                </Select>
              )}
            </Field>
            <div className="sm:col-span-2">
              <Field label={t('settings.sso.idpCert')} hint={t('settings.sso.idpCertHint')} error={fieldError('saml_idp_cert')}>
                {(id) => <Textarea id={id} dir="ltr" rows={5} className="mono text-xs" value={f.saml_idp_cert} onChange={(e) => set('saml_idp_cert', e.target.value)} maxLength={20000} />}
              </Field>
            </div>
          </>
        )}
        <Field label={t('settings.sso.emailAttr')} error={fieldError('email_attribute')}>
          {(id) => <Input id={id} dir="ltr" value={f.email_attribute} onChange={(e) => set('email_attribute', e.target.value)} maxLength={200} />}
        </Field>
        <Field label={t('settings.sso.nameAttr')} error={fieldError('name_attribute')}>
          {(id) => <Input id={id} dir="ltr" value={f.name_attribute} onChange={(e) => set('name_attribute', e.target.value)} placeholder="name" maxLength={200} />}
        </Field>
        <Field label={t('settings.sso.roleAttr')} hint={t('settings.sso.roleAttrHint')} error={fieldError('role_attribute')}>
          {(id) => <Input id={id} dir="ltr" value={f.role_attribute} onChange={(e) => set('role_attribute', e.target.value)} placeholder="groups" maxLength={200} />}
        </Field>
        <Field label={t('settings.sso.defaultRole')} hint={t('settings.sso.defaultRoleHint')}>
          {(id) => (
            <Select id={id} value={f.default_role} onChange={(e) => set('default_role', e.target.value as SsoAssignableRole)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`control.role.${r}` as Key)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <div className="space-y-2 sm:col-span-2">
          <p className="text-[13px] font-medium">{t('settings.sso.mapping')}</p>
          <p className="text-xs text-muted">{t('settings.sso.mappingHint')}</p>
          {f.role_mapping.map((m, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place, the index is their identity
            <div key={i} className="flex gap-2">
              <Input
                dir="ltr"
                aria-label={t('settings.sso.mappingValue')}
                value={m.value}
                onChange={(e) => set('role_mapping', f.role_mapping.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                maxLength={200}
              />
              <Select aria-label={t('settings.role')} value={m.role} onChange={(e) => set('role_mapping', f.role_mapping.map((x, j) => (j === i ? { ...x, role: e.target.value as SsoAssignableRole } : x)))}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`control.role.${r}` as Key)}
                  </option>
                ))}
              </Select>
              <Button variant="ghost" size="sm" onClick={() => set('role_mapping', f.role_mapping.filter((_, j) => j !== i))}>
                {t('common.delete')}
              </Button>
            </div>
          ))}
          <Button variant="secondary" size="sm" onClick={() => set('role_mapping', [...f.role_mapping, { value: '', role: 'viewer' }])} disabled={f.role_mapping.length >= 50}>
            <Plus className="size-3.5" aria-hidden />
            {t('settings.sso.addMapping')}
          </Button>
        </div>
        {toggle('jit_provisioning', 'settings.sso.jitLabel', 'settings.sso.jitHint')}
        {toggle('trust_idp_mfa', 'settings.sso.trustMfa', 'settings.sso.trustMfaHint')}
        {toggle('enabled', 'settings.sso.enabledLabel', 'settings.sso.enabledHint')}
      </div>
      {error && !error.details?.length && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="primary" busy={busy} onClick={save}>
          {t('common.save')}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {t('common.cancel')}
        </Button>
      </div>
    </Modal>
  );
}
