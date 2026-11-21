'use client';

import { use } from 'react';
import { IncidentDetailScreen } from '@/features/incidents';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <IncidentDetailScreen id={id} />;
}
