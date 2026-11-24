'use client';

import { use } from 'react';
import { ShellTranscriptScreen } from '@/features/endpoints';

export default function Page({ params }: { params: Promise<{ id: string; shellId: string }> }) {
  const { id, shellId } = use(params);
  return <ShellTranscriptScreen endpointId={id} shellId={shellId} />;
}
