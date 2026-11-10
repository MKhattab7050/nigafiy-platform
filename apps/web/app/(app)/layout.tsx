'use client';

import { Shell } from '@/components/shell';
import { Spinner } from '@/components/ui';
import { AppProvider } from '@/lib/app';

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider
      fallback={
        <div className="flex min-h-dvh items-center justify-center">
          <Spinner />
        </div>
      }
    >
      <Shell>{children}</Shell>
    </AppProvider>
  );
}
