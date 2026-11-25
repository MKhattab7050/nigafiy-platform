'use client';

import { FeatureError } from '@/components/error-boundary';

/** A crash inside any screen stays inside the main area: the sidebar and top bar keep working. */
export default function ScreenError({ error, retry, reset }: { error: unknown; retry?: () => void; reset?: () => void }) {
  return <FeatureError error={error} retry={retry ?? reset} />;
}
