'use client';

import { ShieldAlert, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Card } from '@/components/ui';
import { qs } from '@/lib/api';
import { useQuery } from '@/lib/app';
import { type Key, fill, useI18n } from '@/lib/i18n';
import { type AssistantGateway, type AssistantView, type DriverMaturity, RESET_STEPS, confidenceKey, guideSteps, resetStepsVisible, wizardVendor } from '../assistant';
import { ROUTER_VENDORS } from '../types';

/** "Beta" or "Tested" next to a router driver: only the Zyxel driver ran on a real router (VMG3625-T50B). */
export function DriverMaturityBadge({ maturity }: { maturity: DriverMaturity }) {
  const { t } = useI18n();
  return (
    <span title={t(maturity === 'beta' ? 'routers.assist.betaHint' : 'routers.assist.testedHint')}>
      <Badge tone={maturity === 'beta' ? 'warn' : 'ok'}>{t(maturity === 'beta' ? 'routers.assist.beta' : 'routers.assist.tested')}</Badge>
    </span>
  );
}

const vendorLabel = (v: string | null): string => (v ? (ROUTER_VENDORS.find((x) => x.value === v)?.label.split(' (')[0] ?? v) : '');

/**
 * Router connection assistant (UX review item 13): which router the gateway is — only from what was
 * observed, with how strong that is — where the login label is, and a warning before anything that
 * could erase the internet (PPPoE) login.
 */
export function RouterAssistant({ siteId, canAdd, onAdd }: { siteId: string; canAdd: boolean; onAdd: (vendor: string | null, address: string | null) => void }) {
  const { t } = useI18n();
  const q = useQuery<AssistantView>(`/router-assistant${qs({ site_id: siteId })}`, ['collectors', 'devices'], 60_000);
  const gateways = q.data?.gateways ?? [];
  const pending = gateways.filter((g) => !g.router);
  // Hide once every reported gateway is added; show the "no gateway yet" line only when nothing is added at all.
  if (!q.data || (gateways.length > 0 && pending.length === 0)) return null;

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Wand2 className="size-4 text-accent" aria-hidden />
          {t('routers.assist.title')}
        </span>
      }
      description={t('routers.assist.intro')}
    >
      {pending.length === 0 ? (
        <div className="space-y-3">
          <p className="text-[13px] text-muted">{t('routers.assist.noGateway')}</p>
          <GuideSteps guide="other" canAdd={canAdd} onAdd={() => onAdd(null, null)} />
        </div>
      ) : (
        <div className="space-y-6">
          {pending.map((g) => (
            <GatewayGuide key={g.address} gateway={g} canAdd={canAdd} onAdd={onAdd} />
          ))}
        </div>
      )}
    </Card>
  );
}

function GatewayGuide({ gateway: g, canAdd, onAdd }: { gateway: AssistantGateway; canAdd: boolean; onAdd: (vendor: string | null, address: string | null) => void }) {
  const { t } = useI18n();
  const d = g.detection;
  const headline =
    d.confidence === 'none'
      ? t('routers.assist.notDetected')
      : d.model && d.confidence === 'high'
        ? fill(t('routers.assist.detected'), { model: d.model })
        : fill(t('routers.assist.detectedVendor'), { vendor: vendorLabel(d.vendor) });

  return (
    <section className="space-y-3">
      <div className="text-[13px]">
        <span className="font-medium text-fg">{t('routers.assist.gateway')}: </span>
        <span className="mono text-accent-hover" dir="ltr">{g.address}</span>
        <span className="ms-1.5 text-xs text-muted">({fill(t('routers.assist.reportedBy'), { collector: g.collector.name })})</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-fg">{headline}</span>
        {g.maturity && d.confidence !== 'none' && <DriverMaturityBadge maturity={g.maturity} />}
      </div>
      <p className="text-xs text-muted">{t(confidenceKey(d.confidence) as Key)}</p>
      {d.evidence.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">{t('routers.assist.evidence')}</summary>
          <ul className="mt-1 space-y-0.5 ps-4">
            {d.evidence.map((e) => (
              <li key={`${e.field}:${e.value}`} className="list-disc">
                {e.field}: <span className="mono" dir="ltr">“{e.value}”</span>
              </li>
            ))}
          </ul>
        </details>
      )}
      <GuideSteps guide={d.guide} canAdd={canAdd} onAdd={() => onAdd(wizardVendor(d), g.address)} />
    </section>
  );
}

function GuideSteps({ guide, canAdd, onAdd }: { guide: AssistantGateway['detection']['guide']; canAdd: boolean; onAdd: () => void }) {
  const { t } = useI18n();
  const [hasPppoe, setHasPppoe] = useState(false);
  const steps = guideSteps(guide);
  const last = steps[steps.length - 1];

  return (
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-faint">{t('routers.assist.steps')}</p>
      <ol className="list-decimal space-y-1.5 ps-5 text-[13px] leading-relaxed text-fg">
        {steps.slice(0, -1).map((k) => (
          <li key={k}>{t(k as Key)}</li>
        ))}
        <li>
          {canAdd ? (
            <Button size="sm" variant="primary" onClick={onAdd}>
              {t(last as Key)}
            </Button>
          ) : (
            t(last as Key)
          )}
        </li>
      </ol>

      <details className="rounded-[var(--radius-control)] border border-line bg-sunken px-3 py-2 text-[13px]">
        <summary className="cursor-pointer font-medium text-fg">{t('routers.assist.labelFails')}</summary>
        <div className="mt-2 space-y-3">
          <p className="text-muted">{t('routers.assist.labelFailsBody')}</p>
          <div role="alert" className="flex items-start gap-2.5 rounded-[var(--radius-control)] border border-crit/40 bg-crit/10 p-3 text-xs text-fg">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-crit" aria-hidden />
            <div className="space-y-1">
              <p className="font-semibold">{t('routers.assist.reset.warnTitle')}</p>
              <p>{t('routers.assist.reset.warnBody')}</p>
            </div>
          </div>
          <label className="flex items-start gap-2 text-xs text-fg">
            <input type="checkbox" className="mt-0.5" checked={hasPppoe} onChange={(e) => setHasPppoe(e.target.checked)} />
            <span>{t('routers.assist.reset.ack')}</span>
          </label>
          {resetStepsVisible(hasPppoe) && (
            <ol className="list-decimal space-y-1 ps-5 text-xs text-fg">
              {RESET_STEPS.map((k) => (
                <li key={k}>{t(k as Key)}</li>
              ))}
            </ol>
          )}
          <p className="text-xs text-muted">{t('routers.assist.restartNote')}</p>
        </div>
      </details>
    </div>
  );
}
