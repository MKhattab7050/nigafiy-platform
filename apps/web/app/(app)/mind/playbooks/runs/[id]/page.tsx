'use client';

import { use } from 'react';
import { RunDetailScreen } from '@/features/playbooks';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RunDetailScreen id={id} />;
}
