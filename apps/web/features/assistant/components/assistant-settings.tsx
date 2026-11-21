'use client';

import { useEffect, useState } from 'react';
import { Async, Badge, Button, Card, ErrorNote, Field, Input, Notice, Select, Switch } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { absoluteTime, relativeTime } from '@/lib/format';
import { fill, useI18n } from '@/lib/i18n';
import type { AssistantSettings as Settings, KeyTestResult } from '../types';

/**
 * Administrator setup: the API key is write-only (the form never receives it back), the model
 * defaults to the newest one the API offers (its first), and nothing can be turned on until a key
 * is saved and the "what is sent" disclosure is confirmed.
 */
export function AssistantSettings({ onChanged }: { onChanged: () => void }) {
  const { t, locale } = useI18n();
  const query = useQuery<Settings>('/assistant/settings', [], 0);
  const [key, setKey] = useState('');
  const [replacing, setReplacing] = useState(false);
  const [form, setForm] = useState<{ model: string; daily_request_budget: number; user_requests_per_hour: number; keep_transcripts: boolean } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState('');
  const [test, setTest] = useState<KeyTestResult | null>(null);

  const s = query.data;
  useEffect(() => {
    if (s) setForm({ model: s.model, daily_request_budget: s.daily_request_budget, user_requests_per_hour: s.user_requests_per_hour, keep_transcripts: s.keep_transcripts });
  }, [s]);

  async function put(name: string, body: Record<string, unknown>, done?: string) {
    setBusy(name);
    setError(null);
    setNotice('');
    try {
      await api<Settings>('/assistant/settings', { method: 'PUT', body });
      if (done) setNotice(done);
      query.reload();
      onChanged();
      return true;
    } catch (err) {
      setError(err as ApiError);
      return false;
    } finally {
      setBusy('');
    }
  }

  async function runTest(candidate: boolean) {
    setBusy(candidate ? 'test-new' : 'test');
    setError(null);
    setTest(null);
    try {
      setTest(await api<KeyTestResult>('/assistant/settings/test', { method: 'POST', body: candidate ? { api_key: key.trim(), model: form?.model } : {} }));
      if (!candidate) query.reload();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy('');
    }
  }

  return (
    <Card title={t('ai.settings.title')} description={t('ai.settings.desc')}>
      <Async query={query}>
        {(st) => {
          const disclosureOutdated = st.disclosure.accepted_version !== null && !st.disclosure.accepted;
          const showKeyInput = !st.api_key.set || replacing;
          return (
            <div className="space-y-5">
              {error && <ErrorNote error={error} />}
              {notice && <Notice>{notice}</Notice>}

              <div className="flex flex-wrap items-center gap-3">
                <Switch
                  id="ai-enabled"
                  checked={st.enabled}
                  disabled={busy !== '' || (!st.enabled && (!st.api_key.set || !st.disclosure.accepted))}
                  onChange={(next) => void put('enabled', { enabled: next }, t('common.saved'))}
                />
                <label htmlFor="ai-enabled" className="text-[13px] font-medium">
                  {t('ai.settings.enabled')}
                </label>
                <Badge tone={st.available ? 'ok' : 'idle'}>{t(st.available ? 'ai.settings.available' : 'ai.settings.notAvailable')}</Badge>
                {!st.enabled && !st.api_key.set && <span className="text-xs text-muted">{t('ai.settings.enableNeedsKey')}</span>}
                {!st.enabled && st.api_key.set && !st.disclosure.accepted && <span className="text-xs text-muted">{t('ai.settings.enableNeedsDisclosure')}</span>}
              </div>

              <section className="space-y-2">
                <h3 className="text-[13px] font-semibold">{t('ai.settings.key')}</h3>
                <p className="text-xs text-muted">{st.api_key.set ? fill(t('ai.settings.keySet'), { when: absoluteTime(st.api_key.updated_at, locale) }) : t('ai.settings.keyNone')}</p>
                {st.last_test && (
                  <p className="text-xs text-muted">
                    {t('ai.settings.lastTest')}: {relativeTime(st.last_test.at, locale)} ·{' '}
                    {st.last_test.ok ? <span className="text-ok">OK</span> : <span className="text-crit">{st.last_test.error ?? '—'}</span>}
                  </p>
                )}
                {showKeyInput ? (
                  <form
                    className="space-y-2"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      if (await put('key', { api_key: key.trim() }, t('common.saved'))) {
                        setKey('');
                        setReplacing(false);
                      }
                    }}
                  >
                    <Field label={t('ai.settings.keyNew')} hint={t('ai.settings.keyHint')}>
                      {(id) => <Input id={id} type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} dir="ltr" className="mono" placeholder="sk-ant-…" />}
                    </Field>
                    <div className="flex flex-wrap gap-2">
                      <Button type="submit" variant="primary" busy={busy === 'key'} disabled={key.trim().length < 20}>
                        {t('ai.settings.keySave')}
                      </Button>
                      <Button busy={busy === 'test-new'} disabled={key.trim().length < 20} onClick={() => void runTest(true)}>
                        {t('ai.settings.keyTest')}
                      </Button>
                      {replacing && (
                        <Button variant="ghost" onClick={() => setReplacing(false)}>
                          {t('common.cancel')}
                        </Button>
                      )}
                    </div>
                  </form>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" busy={busy === 'test'} onClick={() => void runTest(false)}>
                      {t('ai.settings.keyTestStored')}
                    </Button>
                    <Button size="sm" onClick={() => setReplacing(true)}>
                      {t('ai.settings.keyReplace')}
                    </Button>
                    <Button size="sm" variant="danger" busy={busy === 'remove'} title={t('ai.settings.keyRemoveHint')} onClick={() => void put('remove', { api_key: null }, t('common.saved'))}>
                      {t('ai.settings.keyRemove')}
                    </Button>
                  </div>
                )}
                {test && (
                  <p role="status" className={`text-xs ${test.ok ? 'text-ok' : 'text-crit'}`}>
                    {test.ok ? fill(t('ai.settings.testOk'), { model: test.model, ms: test.latency_ms }) : fill(t('ai.settings.testFail'), { error: test.error ?? test.error_code ?? '' })}
                  </p>
                )}
              </section>

              <section className="space-y-2 rounded-[var(--radius-control)] border border-line bg-sunken px-3 py-3">
                <h3 className="text-[13px] font-semibold">{t('ai.disclosure.title')}</h3>
                <p className="text-xs leading-relaxed text-muted">{t('ai.disclosure.body1')}</p>
                <p className="text-xs leading-relaxed text-muted">{t('ai.disclosure.body2')}</p>
                {disclosureOutdated && <p className="text-xs text-warn">{t('ai.disclosure.outdated')}</p>}
                {st.disclosure.accepted ? (
                  <p className="text-xs text-ok">{fill(t('ai.disclosure.accepted'), { name: st.disclosure.accepted_by_name ?? '—', when: absoluteTime(st.disclosure.accepted_at, locale) })}</p>
                ) : (
                  <Button size="sm" variant="primary" busy={busy === 'disclosure'} onClick={() => void put('disclosure', { disclosure_accepted: true }, t('common.saved'))}>
                    {t('ai.disclosure.confirm')}
                  </Button>
                )}
              </section>

              {form && (
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void put('settings', form, t('common.saved'));
                  }}
                >
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label={t('ai.settings.model')}>
                      {(id) => (
                        <Select id={id} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })}>
                          {st.models.map((m, i) => (
                            <option key={m} value={m}>
                              {i === 0 ? fill(t('ai.settings.modelDefault'), { model: m }) : m}
                            </option>
                          ))}
                        </Select>
                      )}
                    </Field>
                    <Field label={t('ai.settings.budget')}>
                      {(id) => <Input id={id} type="number" min={1} max={10000} value={form.daily_request_budget} onChange={(e) => setForm({ ...form, daily_request_budget: Number(e.target.value) })} />}
                    </Field>
                    <Field label={t('ai.settings.perUser')}>
                      {(id) => <Input id={id} type="number" min={1} max={600} value={form.user_requests_per_hour} onChange={(e) => setForm({ ...form, user_requests_per_hour: Number(e.target.value) })} />}
                    </Field>
                  </div>
                  <div className="flex items-start gap-3">
                    <Switch id="ai-transcripts" checked={form.keep_transcripts} onChange={(v) => setForm({ ...form, keep_transcripts: v })} />
                    <div>
                      <label htmlFor="ai-transcripts" className="text-[13px] font-medium">
                        {t('ai.settings.transcripts')}
                      </label>
                      <p className="text-xs text-muted">{t('ai.settings.transcriptsHint')}</p>
                    </div>
                  </div>
                  <div className="flex justify-end">
                    <Button type="submit" variant="primary" busy={busy === 'settings'}>
                      {t('ai.settings.save')}
                    </Button>
                  </div>
                </form>
              )}
            </div>
          );
        }}
      </Async>
    </Card>
  );
}
