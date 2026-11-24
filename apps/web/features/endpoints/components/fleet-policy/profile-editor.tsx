'use client';

import { useState } from 'react';
import { FLEET_PERMISSION_KEYS, type FleetPermissionProfile, type FleetPermissions } from '@nigafiy/shared-types';
import { Button, Field, Input, Modal, Switch, Textarea } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { codeMessage, policyText } from './policy-text';

const EMPTY: FleetPermissions = Object.fromEntries(FLEET_PERMISSION_KEYS.map((k) => [k, k === 'view'])) as FleetPermissions;

/** Create or edit a custom permission profile (admins). Built-ins are read-only. */
export function ProfileEditor({ profile, onClose, onSaved }: { profile: FleetPermissionProfile | null; onClose: () => void; onSaved: () => void }) {
  const { locale } = useI18n();
  const tx = policyText(locale);
  const [name, setName] = useState(profile?.name ?? '');
  const [description, setDescription] = useState(profile?.description ?? '');
  const [perms, setPerms] = useState<FleetPermissions>(() => (profile ? (Object.fromEntries(FLEET_PERMISSION_KEYS.map((k) => [k, profile[k]])) as FleetPermissions) : EMPTY));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { name: name.trim(), description: description.trim() || null, ...perms };
      await api(profile ? `/fleet/profiles/${profile.id}` : '/fleet/profiles', { method: profile ? 'PATCH' : 'POST', body });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'error', String(err)));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={profile ? tx.editProfile : tx.newProfile} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={tx.name}>{(id) => <Input id={id} value={name} maxLength={80} required onChange={(e) => setName(e.target.value)} dir="auto" />}</Field>
        <Field label={tx.description}>{(id) => <Textarea id={id} value={description} maxLength={300} rows={2} onChange={(e) => setDescription(e.target.value)} dir="auto" />}</Field>
        <ul className="divide-y divide-line rounded-md border border-line">
          {FLEET_PERMISSION_KEYS.map((k) => (
            <li key={k} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
              <span>{tx.perm[k]}</span>
              <Switch checked={perms[k]} label={tx.perm[k]} onChange={(v) => setPerms((p) => ({ ...p, [k]: v }))} />
            </li>
          ))}
        </ul>
        {error && (
          <p role="alert" className="text-sm text-crit">
            {codeMessage(tx, error)}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            {tx.cancel}
          </Button>
          <Button type="submit" variant="primary" busy={busy} disabled={!name.trim() || !perms.view}>
            {tx.save}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
