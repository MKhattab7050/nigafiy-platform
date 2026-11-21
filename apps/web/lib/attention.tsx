'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

/**
 * "Needs your attention": every dashboard widget turns the data it already fetched into zero or more
 * one-sentence items with one button that leads to the page that resolves it. Nothing here fetches or
 * acts on its own; items are shortcuts, the full controls stay on each feature's page.
 */
export interface AttentionItem {
  id: string;
  tone: 'crit' | 'warn' | 'info';
  text: string;
  action: { label: string; href: string };
}

export type AttentionReport = { state: 'loading' } | { state: 'error' } | { state: 'ready'; items: AttentionItem[] };

interface AttentionCtx {
  reports: Record<string, AttentionReport>;
  report: (source: string, value: AttentionReport | null) => void;
}

const Ctx = createContext<AttentionCtx | null>(null);

export function AttentionProvider({ children }: { children: React.ReactNode }) {
  const [reports, setReports] = useState<Record<string, AttentionReport>>({});
  const report = useCallback((source: string, value: AttentionReport | null) => {
    setReports((prev) => {
      if (value === null) {
        if (!(source in prev)) return prev;
        const { [source]: _gone, ...rest } = prev;
        return rest;
      }
      if (JSON.stringify(prev[source]) === JSON.stringify(value)) return prev;
      return { ...prev, [source]: value };
    });
  }, []);
  const value = useMemo(() => ({ reports, report }), [reports, report]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAttentionReports(): Record<string, AttentionReport> {
  return useContext(Ctx)?.reports ?? {};
}

/**
 * Called by a widget with its derived items (or its loading / error state). Outside the dashboard
 * there is no provider and this does nothing.
 */
export function useReportAttention(source: string, value: AttentionReport) {
  const report = useContext(Ctx)?.report;
  const key = JSON.stringify(value);
  useEffect(() => {
    report?.(source, JSON.parse(key) as AttentionReport);
  }, [report, source, key]);
  useEffect(() => () => report?.(source, null), [report, source]);
}
