'use client';

import { use } from 'react';
import { RecordingPlayerScreen } from '@/features/endpoints';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <RecordingPlayerScreen id={id} />;
}
