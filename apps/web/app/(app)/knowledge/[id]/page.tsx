'use client';

import { use } from 'react';
import { KnowledgeDetailScreen } from '@/features/knowledge';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <KnowledgeDetailScreen id={id} />;
}
