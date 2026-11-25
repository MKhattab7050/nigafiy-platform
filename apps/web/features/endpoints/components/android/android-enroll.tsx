'use client';

import type { AndroidProvisioningInfo, EndpointCreated } from '@nigafiy/shared-types';
import { CopyBlock, ErrorNote, SkeletonBlock } from '@/components/ui';
import { useQuery } from '@/lib/app';
import { useI18n } from '@/lib/i18n';
import { androidText } from './android-text';
import { ADB_DEVICE_OWNER, enrollLink, normalisePin, phoneRefusesServer, provisioningPayload } from './enroll-codes';
import { QrCode } from './qr-code';

/** Shown after an Android endpoint is created or its token re-issued: both enrollment codes. */
export function AndroidEnrollment({ issued }: { issued: EndpointCreated }) {
  const { locale } = useI18n();
  const ax = androidText(locale);
  const info = useQuery<AndroidProvisioningInfo>('/fleet/android/provisioning', [], 0);
  const server = issued.server_url.replace(/\/+$/, '');
  const pin = issued.tls_pin_sha256;
  const link = enrollLink(server, issued.enrollment_token, pin);
  const httpRefused = phoneRefusesServer(server);

  return (
    <div className="space-y-5" data-testid="android-enroll">
      {httpRefused && <p className="text-xs text-warn">{ax.httpRefused}</p>}
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{ax.appLinkTitle}</h3>
        <p className="text-[13px] text-muted">{ax.appLinkBody}</p>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
          <QrCode value={link} label={ax.qrAlt(ax.appLinkCopy)} size={200} />
          <div className="min-w-0 flex-1 space-y-2">
            <CopyBlock label={ax.serverLabel} value={server} />
            <CopyBlock label={ax.tokenLabel} value={issued.enrollment_token} />
            {pin ? <CopyBlock label={ax.pinLabel} value={normalisePin(pin)!} /> : <p className="text-xs text-muted">{ax.noPin}</p>}
          </div>
        </div>
        <CopyBlock label={ax.appLinkCopy} multiline value={link} />
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold">{ax.ownerTitle}</h3>
        {info.error ? (
          <ErrorNote error={info.error} onRetry={info.reload} />
        ) : !info.data ? (
          <SkeletonBlock lines={3} />
        ) : (
          (() => {
            const payload = provisioningPayload(info.data, server, issued.enrollment_token, pin);
            if (!payload) {
              return (
                <>
                  <p className="text-[13px] text-muted">{ax.ownerApkMissing}</p>
                  <CopyBlock multiline value={ADB_DEVICE_OWNER} />
                </>
              );
            }
            return (
              <>
                <p className="text-[13px] text-muted">{ax.ownerBody}</p>
                <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                  <QrCode value={payload} label={ax.qrAlt(ax.ownerTitle)} size={240} />
                  <div className="min-w-0 flex-1 space-y-2">
                    <CopyBlock label={ax.apkChecksum} value={info.data.apk!.sha256} />
                    <p className="text-xs text-muted">{ax.ownerAdbTitle}</p>
                    <CopyBlock multiline value={ADB_DEVICE_OWNER} />
                  </div>
                </div>
                <CopyBlock label={ax.ownerJson} multiline value={payload} />
              </>
            );
          })()
        )}
      </section>
    </div>
  );
}
