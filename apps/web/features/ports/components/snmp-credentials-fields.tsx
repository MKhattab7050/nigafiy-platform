'use client';

import { Field, Input, Select } from '@/components/ui';
import type { PortsDict } from '../text';

export interface SnmpCredentialsDraft {
  version: '2c' | '3';
  community: string;
  username: string;
  authProto: string;
  authPass: string;
  privProto: string;
  privPass: string;
}

export function initialCredentialsDraft(version: '2c' | '3' = '2c'): SnmpCredentialsDraft {
  return { version, community: '', username: '', authProto: '', authPass: '', privProto: '', privPass: '' };
}

export function snmpCredentialsReady(d: SnmpCredentialsDraft): boolean {
  if (d.version === '2c') return Boolean(d.community);
  return Boolean(d.username && (!d.authProto || d.authPass.length >= 8) && (!d.privProto || d.privPass.length >= 8));
}

export function buildSnmpCredentials(d: SnmpCredentialsDraft) {
  return d.version === '2c'
    ? { version: d.version, community: d.community }
    : {
        version: d.version,
        username: d.username,
        ...(d.authProto ? { auth_protocol: d.authProto, auth_password: d.authPass } : {}),
        ...(d.authProto && d.privProto ? { priv_protocol: d.privProto, priv_password: d.privPass } : {}),
      };
}

const SECRET_INPUT = { type: 'password', autoComplete: 'new-password', spellCheck: false } as const;

/** SNMP v2c / v3 credential inputs shared between adding a switch and rotating credentials. */
export function SnmpCredentialsFields({
  value,
  onChange,
  tx,
}: {
  value: SnmpCredentialsDraft;
  onChange: (next: SnmpCredentialsDraft) => void;
  tx: PortsDict;
}) {
  const set = <K extends keyof SnmpCredentialsDraft>(k: K, v: SnmpCredentialsDraft[K]) => onChange({ ...value, [k]: v });

  return (
    <>
      <Field label={tx.version}>
        {(id) => (
          <Select id={id} value={value.version} onChange={(e) => set('version', e.target.value as '2c' | '3')}>
            <option value="2c">SNMP v2c</option>
            <option value="3">SNMP v3</option>
          </Select>
        )}
      </Field>
      {value.version === '2c' ? (
        <Field label={tx.community} hint={tx.communityHint}>
          {(id) => <Input id={id} dir="ltr" {...SECRET_INPUT} value={value.community} onChange={(e) => set('community', e.target.value)} maxLength={128} />}
        </Field>
      ) : (
        <>
          <Field label={tx.username}>
            {(id) => <Input id={id} dir="ltr" autoComplete="off" value={value.username} onChange={(e) => set('username', e.target.value)} maxLength={64} />}
          </Field>
          <Field label={tx.authProtocol}>
            {(id) => (
              <Select id={id} value={value.authProto} onChange={(e) => set('authProto', e.target.value)}>
                <option value="">{tx.none}</option>
                <option value="sha256">SHA-256</option>
                <option value="sha">SHA-1</option>
                <option value="md5">MD5</option>
              </Select>
            )}
          </Field>
          {value.authProto && (
            <>
              <Field label={tx.authPassword} hint={tx.communityHint}>
                {(id) => <Input id={id} dir="ltr" {...SECRET_INPUT} value={value.authPass} onChange={(e) => set('authPass', e.target.value)} maxLength={128} />}
              </Field>
              <Field label={tx.privProtocol}>
                {(id) => (
                  <Select id={id} value={value.privProto} onChange={(e) => set('privProto', e.target.value)}>
                    <option value="">{tx.none}</option>
                    <option value="aes">AES</option>
                    <option value="des">DES</option>
                  </Select>
                )}
              </Field>
              {value.privProto && (
                <Field label={tx.privPassword}>
                  {(id) => <Input id={id} dir="ltr" {...SECRET_INPUT} value={value.privPass} onChange={(e) => set('privPass', e.target.value)} maxLength={128} />}
                </Field>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}
