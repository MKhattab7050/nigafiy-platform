'use client';

import type { CollectorCreated } from '@nigafiy/shared-types';
import { Button, CopyBlock, Modal } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

export function TokenModal({ created, onClose }: { created: CollectorCreated; onClose: () => void }) {
  const { t } = useI18n();
  const server = (created.server_url || (typeof window === 'undefined' ? '' : window.location.origin)).replace(/\/+$/, '');
  const pin = created.tls_pin_sha256;
  const dockerPin = pin ? ` \\\n  -e NIGAFIY_SENSOR_TLS_PIN_SHA256=${pin}` : '';
  const binaryPin = pin ? ` \\\nNIGAFIY_SENSOR_TLS_PIN_SHA256=${pin}` : '';
  const docker = `docker run -d --name nigafiy-sensor --restart unless-stopped \\\n  --network host --cap-add NET_RAW \\\n  -v lan-collector:/var/lib/lan-collector \\\n  -e NIGAFIY_SENSOR_SERVER_URL=${server} \\\n  -e NIGAFIY_SENSOR_ENROLLMENT_TOKEN=${created.enrollment_token}${dockerPin} \\\n  nigafiy/sensor`;
  const binary = `NIGAFIY_SENSOR_SERVER_URL=${server} \\\nNIGAFIY_SENSOR_ENROLLMENT_TOKEN=${created.enrollment_token}${binaryPin} \\\n./nigafiy-engine sensor -config collector.yaml`;
  const local = /^(localhost|127.0.0.1|[::1])$/.test(typeof window === 'undefined' ? '' : window.location.hostname);
  return (
    <Modal title={`${t('discovery.tokenTitle')} — ${created.collector.name}`} onClose={onClose} wide>
      <div className="space-y-4">
        <p className="rounded-md border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-fg">{t('discovery.tokenOnce')}</p>
        <CopyBlock label={t('discovery.tokenLabel')} value={created.enrollment_token} />
        {local && <CopyBlock label={t('discovery.installLocal')} value={`pnpm local --token ${created.enrollment_token}`} />}
        <CopyBlock label={t('discovery.installDocker')} value={docker} multiline />
        <CopyBlock label={t('discovery.installBinary')} value={binary} multiline />
        <div className="flex justify-end">
          <Button variant="primary" onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
