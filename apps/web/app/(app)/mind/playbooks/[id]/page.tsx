'use client';

import { use } from 'react';
import { PlaybookEditorScreen } from '@/features/playbooks';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <PlaybookEditorScreen id={id} />;
}
