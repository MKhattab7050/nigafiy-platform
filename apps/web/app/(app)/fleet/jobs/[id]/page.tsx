'use client';

import { use } from 'react';
import { FleetJobDetailScreen } from '@/features/endpoints';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <FleetJobDetailScreen id={id} />;
}
