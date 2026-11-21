'use client';

import { devicePath } from '@lan-detective/shared-types/routes';
import Link from 'next/link';
import type { ComponentProps } from 'react';
import { useProgramId } from '@/lib/programs-context';

/**
 * A link to the shared device card that stays in the program it was clicked from
 * (`/guard/devices/<id>` inside Guard, `/radar/devices/<id>` from Radar or Hub). Spec §5.
 */
export function DeviceLink({ id, ...props }: { id: string } & Omit<ComponentProps<typeof Link>, 'href'>) {
  const program = useProgramId();
  return <Link href={devicePath(id, program)} {...props} />;
}
