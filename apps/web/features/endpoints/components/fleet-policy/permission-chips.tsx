'use client';

import clsx from 'clsx';
import { Check, Minus } from 'lucide-react';
import { FLEET_PERMISSION_KEYS, type FleetPermissions } from '@nigafiy/shared-types';
import { useI18n } from '@/lib/i18n';
import { policyText } from './policy-text';

/**
 * What a session (or a profile) allows, as chips: the operator sees the same list the user sees on
 * the session bar. `all` also lists what is not allowed (struck through).
 */
export function PermissionChips({ permissions, all = false, className }: { permissions: FleetPermissions; all?: boolean; className?: string }) {
  const { locale } = useI18n();
  const tx = policyText(locale);
  const keys = FLEET_PERMISSION_KEYS.filter((k) => all || permissions[k]);
  return (
    <ul className={clsx('flex flex-wrap gap-1', className)} aria-label={tx.allowed}>
      {keys.map((k) => (
        <li
          key={k}
          className={clsx(
            'inline-flex h-5 items-center gap-1 rounded-[4px] border px-1.5 text-[11px] leading-none',
            permissions[k] ? 'border-ok/30 bg-ok/[0.08] text-fg' : 'border-line bg-raised text-faint line-through',
          )}
          title={permissions[k] ? tx.allowed : tx.notAllowed}
        >
          {permissions[k] ? <Check className="size-3 text-ok" aria-hidden /> : <Minus className="size-3" aria-hidden />}
          {tx.perm[k]}
        </li>
      ))}
    </ul>
  );
}
