'use client';

import { FeatureError } from '@/components/error-boundary';

/** A crash on a page outside the signed-in shell (sign-in, registration, invitations). */
export default function PageError({ error, retry, reset }: { error: unknown; retry?: () => void; reset?: () => void }) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-xl items-center px-4">
      <div className="w-full">
        <FeatureError error={error} retry={retry ?? reset} />
      </div>
    </main>
  );
}
