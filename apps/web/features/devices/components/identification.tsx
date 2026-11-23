'use client';

import type { DeviceDetail } from '@nigafiy/shared-types';
import { Fact, Tag } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

/** What the device announced about itself, and the rule that turned it into a type. */
export function Identification({ device: d, typeLabel }: { device: DeviceDetail; typeLabel: string }) {
  const { t } = useI18n();
  const fp = d.fingerprint ?? {};
  const model = fp.hints?.model ?? fp.hints?.product ?? fp.ssdp?.model;
  const manufacturer = fp.hints?.manufacturer ?? fp.ssdp?.manufacturer;
  const announced = Boolean(fp.names?.length || fp.services?.length || model || manufacturer || fp.ssdp);
  return (
    <div className="space-y-3">
      {d.type_source === 'inferred' && d.type_evidence && (
        <div className="rounded-md border border-line-strong bg-raised px-3 py-2.5">
          <p className="text-xs font-semibold text-muted">
            {t('device.identRule')}: {typeLabel}
          </p>
          <ul className="mt-1.5 list-disc space-y-1 ps-5 text-[13px] leading-relaxed text-fg" dir="auto">
            {d.type_evidence.split(' · ').map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          {d.type_confidence === 'low' && <p className="mt-2 text-xs text-warn">{t('device.identLowHint')}</p>}
        </div>
      )}
      {!announced ? (
        <p className="text-[13px] leading-relaxed text-muted">{t('device.identNone')}</p>
      ) : (
        <dl>
          {fp.names && fp.names.length > 0 && (
            <Fact label={t('device.identNames')}>
              {fp.names.map((n) => (
                <span key={n.source + n.name} className="block" dir="auto">
                  {n.name} <span className="text-[11px] text-faint">· {n.source}</span>
                </span>
              ))}
            </Fact>
          )}
          {model && <Fact label={t('device.identModel')}>{model}</Fact>}
          {manufacturer && <Fact label={t('device.identManufacturer')}>{manufacturer}</Fact>}
          {fp.ssdp?.device_types && fp.ssdp.device_types.length > 0 && <Fact label={t('device.identUpnp')}>{fp.ssdp.device_types.join(', ')}</Fact>}
          {fp.ssdp?.server && (
            <Fact label={t('device.identSoftware')}>
              <span className="mono text-xs">{fp.ssdp.server}</span>
            </Fact>
          )}
          {fp.services && fp.services.length > 0 && (
            <Fact label={t('device.identServices')}>
              <span className="flex flex-wrap gap-1">
                {fp.services.map((s) => (
                  <Tag key={s}>{s}</Tag>
                ))}
              </span>
            </Fact>
          )}
        </dl>
      )}
    </div>
  );
}
