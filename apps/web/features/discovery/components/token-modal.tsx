'use client';

import type { CollectorCreated } from '@lan-detective/shared-types';
import { Button, CopyBlock, Modal } from '@/components/ui';
import { useI18n } from '@/lib/i18n';

export function TokenModal({ created, onClose }: { created: CollectorCreated; onClose: () => void }) {
  const { t } = useI18n();
  const server = (created.server_url || (typeof window === 'undefined' ? '' : window.location.origin)).replace(/\/+$/, '');
  const pin = created.tls_pin_sha256;
  const dockerPin = pin ? ` \\\n  -e LAN_COLLECTOR_TLS_PIN_SHA256=${pin}` : '';
  const binaryPin = pin ? ` \\\nLAN_COLLECTOR_TLS_PIN_SHA256=${pin}` : '';
  const binaryFlag = pin ? ` --tls-pin-sha256 ${pin}` : '';
  const docker = `docker run -d --name lan-collector --restart unless-stopped \\\n  --network host --cap-add NET_RAW \\\n  -v lan-collector:/var/lib/lan-collector \\\n  -e LAN_COLLECTOR_SERVER_URL=${server} \\\n  -e LAN_COLLECTOR_ENROLLMENT_TOKEN=${created.enrollment_token}${dockerPin} \\\n  lan-detective/lan-collector`;
  const binary = `LAN_COLLECTOR_SERVER_URL=${server} \\\nLAN_COLLECTOR_ENROLLMENT_TOKEN=${created.enrollment_token}${binaryPin} \\\n./lan-collector -config collector.yaml${binaryFlag}`;
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
