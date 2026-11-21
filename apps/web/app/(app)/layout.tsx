'use client';

import { LogoMark } from '@/components/logo';
import { Shell } from '@/components/shell';
import { AppProvider } from '@/lib/app';
import { useI18n } from '@/lib/i18n';

function Boot() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4" role="status">
      <LogoMark className="size-10 animate-shimmer" />
      <p className="text-[13px] text-muted">{t('boot.loading')}</p>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider fallback={<Boot />}>
      <Shell>{children}</Shell>
    </AppProvider>
  );
}
