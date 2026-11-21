'use client';

import { use } from 'react';
import { RouterDetailScreen } from '@/features/routers';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RouterDetailScreen id={id} />;
}

