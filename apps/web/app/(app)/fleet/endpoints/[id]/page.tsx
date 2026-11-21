'use client';

import { use } from 'react';
import { EndpointDetailScreen } from '@/features/endpoints';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <EndpointDetailScreen id={id} />;
}
