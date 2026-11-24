'use client';

import type { EndpointComplianceItem, EndpointComplianceStatus, EndpointEvidenceState } from '@nigafiy/shared-types';
import { Badge, Card, type Tone } from '@/components/ui';
import { absoluteTime } from '@/lib/format';
import type { Locale } from '@/lib/i18n';
import { localizeComplianceReason, localizeEvidenceReason } from '@/lib/localize';

const VERDICT_TONE: Record<EndpointComplianceStatus, Tone> = { compliant: 'ok', attention: 'warn', non_compliant: 'crit', unknown: 'idle' };
const STATE_TONE: Record<EndpointEvidenceState, Tone> = { pass: 'ok', warn: 'warn', fail: 'crit', unknown: 'idle', info: 'info' };

const STATE_LABEL: Record<EndpointEvidenceState, { en: string; ar: string }> = {
  pass: { en: 'Pass', ar: 'ناجح' },
  fail: { en: 'Fail', ar: 'فاشل' },
  warn: { en: 'Warning', ar: 'تحذير' },
  unknown: { en: 'Not measured', ar: 'لم يُقَس' },
  info: { en: 'Context', ar: 'معلومة' },
};

const VERDICT_LABEL: Record<EndpointComplianceStatus, { en: string; ar: string }> = {
  compliant: { en: 'Verified', ar: 'تم التحقق' },
  attention: { en: 'Needs attention', ar: 'يحتاج متابعة' },
  non_compliant: { en: 'Non-compliant', ar: 'غير ممتثل' },
  unknown: { en: 'Not measured', ar: 'لم يُقَس' },
};

/** The Arabic reason: the web's fuller translation (it also translates the agent's explanation), else the API's. */
function arabicReason(item: EndpointComplianceItem): string {
  const localized = localizeComplianceReason(item.reason_en, 'ar');
  return localized !== item.reason_en ? localized : item.reason_ar;
}

/**
 * Every compliance item with the API's verdict and the evidence behind it: the subject, what the
 * command reported, which command, and when. Nothing here is inferred in the browser.
 */
export function ComplianceEvidence({ items, locale }: { items: EndpointComplianceItem[]; locale: Locale }) {
  const isAr = locale === 'ar';
  return (
    <Card title={isAr ? 'أدلة الامتثال (ما قاسه الوكيل فعلاً)' : 'Compliance evidence (what the agent actually measured)'} padded={false}>
      <p className="border-b border-line px-4 py-2.5 text-xs text-muted">
        {isAr
          ? 'لا يُعتبر الجهاز ممتثلاً إلا إذا قيس كل بند مطلوب ونجح. البند الذي لم يُقَس يظهر "لم يُقَس" مع السبب.'
          : 'An endpoint is compliant only when every required item was measured and passed. An item that could not be measured shows "Not measured" with the reason.'}
      </p>
      <ul className="divide-y divide-line">
        {items.map((item) => (
          <li key={item.key} className="px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-medium text-fg">{isAr ? item.label_ar : item.label_en}</span>
              {item.judged === false && item.verdict !== 'unknown' ? (
                // Local administrators with no allowed list: shown, not part of the verdict.
                <Badge tone="info">{isAr ? 'للعرض فقط' : 'Shown only'}</Badge>
              ) : (
                <Badge tone={VERDICT_TONE[item.verdict]}>{VERDICT_LABEL[item.verdict][isAr ? 'ar' : 'en']}</Badge>
              )}
            </div>
            <p className="mt-1 text-xs text-muted" dir="auto">
              {isAr ? arabicReason(item) : item.reason_en}
            </p>
            {item.evidence.length > 0 && (
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[640px] text-start text-[11.5px]">
                  <thead className="text-faint">
                    <tr>
                      <th className="py-1 pe-3 text-start font-medium">{isAr ? 'العنصر' : 'Subject'}</th>
                      <th className="py-1 pe-3 text-start font-medium">{isAr ? 'النتيجة' : 'Result'}</th>
                      <th className="py-1 pe-3 text-start font-medium">{isAr ? 'القيمة المرصودة' : 'Observed value'}</th>
                      <th className="py-1 pe-3 text-start font-medium">{isAr ? 'المصدر (الأمر)' : 'Source command'}</th>
                      <th className="py-1 text-start font-medium">{isAr ? 'وقت القياس' : 'Measured'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.evidence.map((e) => (
                      <tr key={`${e.subject}|${e.source}|${e.state}`} className="align-top">
                        <td className="mono py-1 pe-3 text-fg" dir="ltr">
                          {e.subject}
                        </td>
                        <td className="py-1 pe-3">
                          <Badge tone={STATE_TONE[e.state]}>{STATE_LABEL[e.state][isAr ? 'ar' : 'en']}</Badge>
                        </td>
                        <td className="py-1 pe-3">
                          <span className="mono break-all text-fg" dir="ltr">
                            {e.value || '—'}
                          </span>
                          {e.reason && (
                            <span className="mt-0.5 block text-muted" dir={isAr ? 'rtl' : 'ltr'}>
                              {localizeEvidenceReason(e.reason, locale)}
                            </span>
                          )}
                        </td>
                        <td className="mono py-1 pe-3 break-all text-muted" dir="ltr">
                          {e.source}
                        </td>
                        <td className="py-1 whitespace-nowrap text-muted">{e.measured_at ? absoluteTime(e.measured_at, locale) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
