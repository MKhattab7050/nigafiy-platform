'use client';

import { use } from 'react';
import { DeviceDetailScreen } from '@/features/devices';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <DeviceDetailScreen id={id} />;
}
