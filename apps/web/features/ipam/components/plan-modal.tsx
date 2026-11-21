'use client';

import type { IpamSubnetDetail } from '@lan-detective/shared-types';
import { useState } from 'react';
import { Button, ErrorNote, Field, Input, Modal, Textarea } from '@/components/ui';
import { type ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { ipamText } from '../text';

// ── subnet plan (documentation of the subnet itself) ────────────────────────

export function PlanModal({ subnet, onClose, onSaved }: { subnet: IpamSubnetDetail; onClose: () => void; onSaved: () => void }) {
  const { locale } = useI18n();
  const tx = ipamText(locale);
  const [vlan, setVlan] = useState(subnet.vlan_id?.toString() ?? '');
  const [gateway, setGateway] = useState(subnet.gateway?.source === 'documented' ? subnet.gateway.ip : '');
  const [start, setStart] = useState(subnet.dhcp?.start ?? '');
  const [end, setEnd] = useState(subnet.dhcp?.end ?? '');
  const [dns, setDns] = useState(subnet.dns_servers.join(', '));
  const [notes, setNotes] = useState(subnet.notes ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/ipam/subnets/${subnet.id}`, {
        method: 'PUT',
        body: {
          vlan_id: vlan.trim() ? Number(vlan) : null,
          gateway: gateway.trim() || null,
          dns_servers: dns.split(/[\s,،]+/).filter(Boolean),
          dhcp_start: start.trim() || null,
          dhcp_end: end.trim() || null,
          notes: notes.trim() || null,
        },
      });
      onSaved();
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={`${tx.edit} · ${subnet.cidr}`} onClose={onClose} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={tx.formGateway} hint={tx.formGatewayHint}>
          {(id) => <Input id={id} dir="ltr" value={gateway} onChange={(e) => setGateway(e.target.value)} placeholder={subnet.first_host} maxLength={15} />}
        </Field>
        <Field label={tx.formVlan}>{(id) => <Input id={id} dir="ltr" inputMode="numeric" value={vlan} onChange={(e) => setVlan(e.target.value.replace(/\D/g, ''))} maxLength={4} />}</Field>
        <Field label={tx.formDhcpStart}>{(id) => <Input id={id} dir="ltr" value={start} onChange={(e) => setStart(e.target.value)} maxLength={15} />}</Field>
        <Field label={tx.formDhcpEnd} hint={tx.dhcpNote}>
          {(id) => <Input id={id} dir="ltr" value={end} onChange={(e) => setEnd(e.target.value)} maxLength={15} />}
        </Field>
        <div className="sm:col-span-2">
          <Field label={tx.formDns} hint={tx.formDnsHint}>
            {(id) => <Input id={id} dir="ltr" value={dns} onChange={(e) => setDns(e.target.value)} maxLength={80} />}
          </Field>
        </div>
        <div className="sm:col-span-2">
          <Field label={tx.notes}>{(id) => <Textarea id={id} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />}</Field>
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorNote error={error} />
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <Button variant="primary" busy={busy} onClick={save}>
          {tx.save}
        </Button>
        <Button variant="ghost" onClick={onClose}>
          {tx.cancel}
        </Button>
      </div>
    </Modal>
  );
}
