'use client';

import { useI18n } from '@/lib/i18n';

/**
 * The text alternative every chart carries: the same numbers as a table, folded away by default.
 * Screen-reader users and anyone who wants exact values open it; it is never a second source of truth.
 */
export function ChartTable({ caption, columns, rows }: { caption: string; columns: string[]; rows: (string | number)[][] }) {
  const { t } = useI18n();
  if (!rows.length) return null;
  return (
    <details className="group mt-2 text-xs">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-faint hover:text-fg [&::-webkit-details-marker]:hidden">
        <span className="group-open:hidden">{t('chart.showTable')}</span>
        <span className="hidden group-open:inline">{t('chart.hideTable')}</span>
      </summary>
      <div className="mt-2 max-h-64 overflow-auto rounded-[6px] border border-line">
        <table className="w-full text-start">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 bg-surface">
            <tr>
              {columns.map((c) => (
                <th key={c} scope="col" className="border-b border-line px-2.5 py-1.5 text-start font-medium text-muted">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="tnum">
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                {r.map((cell, j) => (
                  <td key={j} className="px-2.5 py-1 text-fg">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
