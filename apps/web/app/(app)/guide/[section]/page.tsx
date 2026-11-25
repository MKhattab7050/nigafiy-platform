'use client';

import { use } from 'react';
import { GuideSectionScreen } from '@/features/guide';

export default function Page({ params }: { params: Promise<{ section: string }> }) {
  const { section } = use(params);
  return <GuideSectionScreen id={section} />;
}
