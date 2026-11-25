'use client';

import { AlertTriangle, RotateCcw } from 'lucide-react';
import { type ErrorInfo, catchError } from 'next/error';
import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n';

function PartError({ part, error, retry }: { part: 'sidebar' | 'topBar'; error: unknown; retry: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div role="alert" className={`flex items-center gap-2 border-crit/30 bg-crit/5 px-3 py-2 text-[12.5px] text-fg ${part === 'topBar' ? 'border-b' : 'h-full flex-col justify-center text-center'}`}>
      <AlertTriangle className="size-4 shrink-0 text-crit" aria-hidden />
      <span className="min-w-0 flex-1">{t(part === 'topBar' ? 'shell.topBarError' : 'shell.sidebarError')}</span>
      <button type="button" onClick={retry} className="inline-flex h-7 items-center gap-1.5 rounded-[6px] border border-line-strong bg-surface px-2 text-xs hover:bg-raised">
        <RotateCcw className="size-3.5" aria-hidden />
        {t('common.retry')}
      </button>
    </div>
  );
}

/** Keeps one crashing shell part (sidebar, top bar) from blanking the page: the rest keeps working. */
export const ShellPartBoundary = catchError((props: { part: 'sidebar' | 'topBar' }, { error, retry }: ErrorInfo) => <PartError part={props.part} error={error} retry={retry} />);
