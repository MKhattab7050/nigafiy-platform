'use client';

import { RotateCcw, ServerOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LogoMark } from '@/components/logo';
import { Shell } from '@/components/shell';
import { Button } from '@/components/ui';
import { AppProvider, type Unreachable } from '@/lib/app';
import { fill, useI18n } from '@/lib/i18n';
import { ProgramsProvider } from '@/lib/programs-context';

function Boot() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4" role="status">
      <LogoMark className="size-10 animate-shimmer" />
      <p className="text-[13px] text-muted">{t('boot.loading')}</p>
    </div>
  );
}

/** The server cannot be reached while opening: say so, count down to the next attempt, offer one now. */
function ServerUnreachable({ error, retryAt, retryNow }: Unreachable) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (retryAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const seconds = retryAt === null ? null : Math.max(0, Math.ceil((retryAt - now) / 1000));
  return (
    <div className="flex min-h-dvh items-center justify-center px-4">
      <div role="alert" className="w-full max-w-md rounded-[12px] border border-line-strong bg-surface p-6 text-center shadow-[var(--shadow-overlay)]">
        <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full border border-warn/40 bg-warn/10 text-warn">
          <ServerOff className="size-6" aria-hidden />
        </div>
        <h1 className="text-[15px] font-semibold text-fg">{t('boot.unreachable.title')}</h1>
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted">{t('boot.unreachable.body')}</p>
        {error.status !== 0 && (
          <p className="mono mt-2 text-[11px] text-faint" dir="ltr">
            {error.status} {error.code}
          </p>
        )}
        <p className="mt-3 text-[12.5px] text-muted" aria-live="polite">
          {seconds === null ? t('boot.unreachable.noAuto') : seconds > 0 ? fill(t('boot.unreachable.retryIn'), { seconds }) : t('boot.unreachable.retrying')}
        </p>
        <div className="mt-4 flex justify-center">
          <Button onClick={retryNow}>
            <RotateCcw className="size-3.5" aria-hidden />
            {t('boot.unreachable.retryNow')}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider fallback={<Boot />} unreachable={(state) => <ServerUnreachable {...state} />}>
      <ProgramsProvider>
        <Shell>{children}</Shell>
      </ProgramsProvider>
    </AppProvider>
  );
}
