'use client';

import { Download, FileBarChart2, Printer } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { SummaryReport } from '@lan-detective/shared-types';
import { type ApiError, api, qs } from '@/lib/api';
import { useApp } from '@/lib/app';
import { ms, pct } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import { Button, Card, ErrorNote, Fact, PageHeader, Select, SkeletonBlock } from './ui';

/**
 * The executive summary report (GET /reports/summary) for a period and the site picked in the top
 * bar: devices, checks, incidents, managed computers and IP use, with JSON download and print.
 * Shown by the top bar's report button on every page and as Watch, Reports.
 */
export function SummaryReportView() {
  const { t } = useI18n();
  const { siteId } = useApp();
  const [reportDays, setReportDays] = useState<number>(7);
  const [report, setReport] = useState<SummaryReport | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState<ApiError | null>(null);

  // Fetch the report when shown and whenever the period or the site changes.
  useEffect(() => {
    let active = true;
    setReportLoading(true);
    setReportError(null);
    api<SummaryReport>(`/reports/summary${qs({ days: reportDays, site_id: siteId })}`)
      .then((res) => {
        if (active) setReport(res);
      })
      .catch((err) => {
        if (active) setReportError(err as ApiError);
      })
      .finally(() => {
        if (active) setReportLoading(false);
      });
    return () => {
      active = false;
    };
  }, [reportDays, siteId]);

  function downloadReportJson() {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lan-detective-summary-${report.days}d.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted">{t('top.reportDays')}:</span>
          <Select aria-label={t('top.reportDays')} value={String(reportDays)} onChange={(e) => setReportDays(Number(e.target.value))} className="h-8 w-28">
            <option value="7">7d</option>
            <option value="14">14d</option>
            <option value="30">30d</option>
            <option value="90">90d</option>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" disabled={!report} onClick={downloadReportJson}>
            <Download className="size-3.5" aria-hidden />
            {t('top.reportJson')}
          </Button>
          <Button size="sm" variant="secondary" disabled={!report} onClick={() => window.print()}>
            <Printer className="size-3.5" aria-hidden />
            {t('top.reportPrint')}
          </Button>
        </div>
      </div>

      {reportError && <ErrorNote error={reportError} />}
      {reportLoading || !report ? (
        <SkeletonBlock lines={6} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <Card title={t('nav.devices')}>
            <dl>
              <Fact label={t('status.online')}>
                {report.devices.online} / {report.devices.total}
              </Fact>
              <Fact label={t('status.offline')}>{report.devices.offline}</Fact>
              <Fact label={t('severity.critical')}>{report.devices.critical}</Fact>
            </dl>
          </Card>

          <Card title={t('nav.monitoring')}>
            <dl>
              <Fact label={t('top.reportAvailability')}>{pct(report.checks.availability_pct)}</Fact>
              <Fact label={t('top.reportAvgLatency')}>{ms(report.checks.avg_latency_ms)}</Fact>
              <Fact label={t('state.ok')}>
                {report.checks.ok} / {report.checks.total}
              </Fact>
            </dl>
          </Card>

          <Card title={t('nav.incidents')}>
            <dl>
              <Fact label={t('nav.openIncidents')}>{report.incidents.active}</Fact>
              <Fact label={t('chart.count')}>{report.incidents.total_in_window}</Fact>
              <Fact label={t('top.reportMttr')}>{report.incidents.mttr_minutes !== null ? `${report.incidents.mttr_minutes} min` : '—'}</Fact>
            </dl>
          </Card>

          <Card title={t('nav.endpoints')}>
            <dl>
              <Fact label={t('status.online')}>
                {report.endpoints.online} / {report.endpoints.total}
              </Fact>
              <Fact label={t('dash.compliance')}>{report.endpoints.compliant}</Fact>
              <Fact label={t('top.reportIpamUtil')}>{pct(report.ipam.utilization_pct)}</Fact>
            </dl>
          </Card>
        </div>
      )}
    </div>
  );
}

/** Watch, Reports (spec §5): the summary report as a page. The top bar's report button stays on every page. */
export function ReportsScreen() {
  const { t } = useI18n();
  return (
    <>
      <PageHeader icon={<FileBarChart2 className="size-[18px]" aria-hidden />} title={t('platform.nav.reports')} description={t('platform.reports.intro')} />
      <SummaryReportView />
    </>
  );
}
