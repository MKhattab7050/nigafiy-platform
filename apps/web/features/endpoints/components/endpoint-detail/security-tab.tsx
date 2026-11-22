'use client';

import { useState } from 'react';
import type { EndpointDetail } from '@lan-detective/shared-types';
import { Badge, Button, Card, ErrorNote, Fact, Field, Input, Select } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { absoluteTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { localizeComplianceReason } from '@/lib/localize';
import { ComplianceEvidence } from './compliance-evidence';
import { capStateTone } from './helpers';
import { endpointsText } from '../../text';

export function SecurityAndCapabilitiesTab({
  ep,
  canAdmin,
  onReload,
}: {
  ep: EndpointDetail;
  canAdmin: boolean;
  onReload: () => void;
}) {
  const { locale } = useI18n();
  const isAr = locale === 'ar';
  const tx = endpointsText(locale);

  const [rootsText, setRootsText] = useState((ep.policy?.allowed_fs_roots ?? []).join(', '));
  const [rdConsent, setRdConsent] = useState<'unattended' | 'prompt'>(ep.policy?.remote_desktop_consent ?? 'unattended');
  const [busy, setBusy] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');
  const [saveError, setSaveError] = useState<ApiError | null>(null);

  async function savePolicy(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setSavedNotice('');
    setSaveError(null);
    try {
      const allowed_fs_roots = rootsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await api(`/endpoints/${ep.id}/policy`, {
        method: 'PATCH',
        body: {
          allowed_fs_roots,
          remote_desktop_consent: rdConsent,
        },
      });
      setSavedNotice(isAr ? 'تم حفظ سياسة الجهاز.' : 'Endpoint policy saved.');
      onReload();
    } catch (err) {
      setSaveError(err as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={isAr ? 'حالة الأمان والامتثال (Security & Compliance)' : 'Security & Compliance Posture'}>
          <dl>
            <Fact label={isAr ? 'حالة الامتثال' : 'Compliance status'}>
              <Badge
                tone={
                  ep.compliance_status === 'compliant'
                    ? 'ok'
                    : ep.compliance_status === 'non_compliant'
                      ? 'crit'
                      : 'warn'
                }
              >
                {tx.complianceStatus[ep.compliance_status]}
              </Badge>
            </Fact>
            {ep.compliance_reasons.length > 0 && (
              <Fact label={isAr ? 'ملاحظات الامتثال' : 'Findings'}>
                <ul className="space-y-0.5 text-warn">
                  {ep.compliance_reasons.map((r) => (
                    <li key={r}>{localizeComplianceReason(r, locale)}</li>
                  ))}
                </ul>
              </Fact>
            )}
            <Fact label={isAr ? 'آخر قياس' : 'Last measured'}>
              {ep.security?.measured_at ? absoluteTime(ep.security.measured_at, locale) : <span className="text-muted">{isAr ? 'لم يرسل الوكيل أدلة بعد' : 'The agent has not sent evidence yet'}</span>}
            </Fact>
            {typeof ep.security?.pending_updates === 'number' && (
              <Fact label={isAr ? 'التحديثات المعلّقة' : 'Pending updates'}>
                <span className="mono">{ep.security.pending_updates}</span>
              </Fact>
            )}
            <Fact label={isAr ? 'آخر تحديث أمني' : 'Last OS / Security Patch'}>
              <span className="mono">{ep.security?.last_update_date ?? '—'}</span>
            </Fact>
          </dl>
        </Card>

        <Card title={isAr ? 'سياسة الجهاز' : 'Endpoint Policy'}>
          <form onSubmit={savePolicy} className="space-y-3">
            <Field label={isAr ? 'تقييد مجلدات مدير الملفات (مفصولة بفاصلة)' : 'Allowed File Manager Roots (comma-separated, empty = full authorized access)'}>
              {(fid) => (
                <Input
                  id={fid}
                  dir="ltr"
                  className="mono"
                  disabled={!canAdmin}
                  value={rootsText}
                  onChange={(e) => setRootsText(e.target.value)}
                  placeholder="C:\Users\Public, D:\DepartmentShares"
                />
              )}
            </Field>
            <Field label={isAr ? 'سياسة موافقة سطح المكتب البعيد' : 'Remote Desktop Access Policy'}>
              {(fid) => (
                <Select
                  id={fid}
                  disabled={!canAdmin}
                  value={rdConsent}
                  onChange={(e) => setRdConsent(e.target.value as 'unattended' | 'prompt')}
                >
                  <option value="unattended">
                    {isAr
                      ? 'بدون انتظار موافقة (يظهر إشعار على الشاشة ويُسجَّل كل شيء)'
                      : 'No approval needed (on-screen notice, every session logged)'}
                  </option>
                  <option value="prompt">
                    {isAr
                      ? 'يتطلب موافقة المستخدم (غير مدعوم في الوكيل بعد: الجلسات تُرفض)'
                      : 'Require user approval (agent cannot ask yet: sessions are refused)'}
                  </option>
                </Select>
              )}
            </Field>
            {savedNotice && <p className="text-xs text-ok">{savedNotice}</p>}
            {saveError && <ErrorNote error={saveError} />}
            {canAdmin && (
              <Button type="submit" variant="primary" busy={busy}>
                {isAr ? 'حفظ السياسة' : 'Save policy'}
              </Button>
            )}
          </form>
        </Card>
      </div>

      <ComplianceEvidence items={ep.compliance_items ?? []} locale={locale} />

      {/* Dynamic Capability Matrix */}
      <Card
        title={
          isAr
            ? `ما يستطيع الوكيل فعله على ${tx.platforms[ep.platform]}`
            : `What the agent can do on ${tx.platforms[ep.platform]}`
        }
        padded={false}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-start text-xs">
            <thead className="border-b border-line bg-raised/60 text-muted">
              <tr>
                <th className="px-4 py-2.5 text-start font-medium">{isAr ? 'القدرة / الميزة' : 'Capability'}</th>
                <th className="w-52 px-4 py-2.5 text-start font-medium">{isAr ? 'الحالة' : 'Status'}</th>
                <th className="w-28 px-4 py-2.5 text-start font-medium">{isAr ? 'متاح بالواجهة' : 'Available'}</th>
                <th className="px-4 py-2.5 text-start font-medium">
                  {isAr ? 'التفاصيل التقنية ومتطلبات نظام التشغيل' : 'Platform Technical Details & Prerequisites'}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {ep.capabilities.map((cap) => (
                <tr key={cap.key} className="hover:bg-raised/40">
                  <td className="px-4 py-2.5 font-medium text-fg">{isAr ? cap.label_ar : cap.label_en}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={capStateTone(cap.state)}>{tx.capabilityStates[cap.state] ?? cap.state}</Badge>
                  </td>
                  <td className="px-4 py-2.5">
                    {cap.enabled ? (
                      <Badge tone="ok">{isAr ? 'مفعّل' : 'Enabled'}</Badge>
                    ) : (
                      <Badge tone="idle">{isAr ? 'محجوب' : 'Disabled'}</Badge>
                    )}
                  </td>
                  <td className="px-4 py-2.5 text-muted">{isAr ? cap.reason_ar : cap.reason_en}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
