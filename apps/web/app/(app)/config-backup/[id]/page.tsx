'use client';

import { use } from 'react';
import { ConfigTargetScreen } from '@/features/config-backup';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <ConfigTargetScreen id={id} />;
}
