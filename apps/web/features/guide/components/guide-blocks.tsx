'use client';

import clsx from 'clsx';
import { Info, TriangleAlert } from 'lucide-react';
import { Fragment } from 'react';
import type { GuideBlock } from '../types';

/**
 * Guide text: plain words, with `backticks` around technical values (addresses, commands, file
 * names). Those are shown in a left-to-right isolate (as lib/localize/bidi.ts does for values in
 * other screens) so `192.168.1.0/24` or a command line reads correctly inside Arabic text.
 */
export function GuideText({ text }: { text: string }) {
  // Keyed by the character offset of each part, which is unique and stable for a given text.
  let offset = 0;
  const parts = text.split('`').map((part, n) => {
    const at = offset;
    offset += part.length + 1;
    return { at, part, code: n % 2 === 1 };
  });
  return (
    <>
      {parts.map(({ at, part, code }) =>
        code ? (
          <bdi key={at} dir="ltr" className="mono break-all rounded-[4px] bg-raised px-1 py-px text-[0.92em] text-fg">
            {part}
          </bdi>
        ) : (
          <Fragment key={at}>{part}</Fragment>
        ),
      )}
    </>
  );
}

function Block({ block }: { block: GuideBlock }) {
  switch (block.kind) {
    case 'h':
      return (
        <h2 id={block.id} className="scroll-mt-20 pt-4 text-[16px] font-semibold text-fg first:pt-0">
          {block.text}
        </h2>
      );
    case 'p':
      return (
        <p className="text-[14px] leading-7 text-fg">
          <GuideText text={block.text} />
        </p>
      );
    case 'steps':
      return (
        <ol className="list-decimal space-y-1.5 ps-6 text-[14px] leading-7 text-fg marker:font-semibold marker:text-muted">
          {block.items.map((item) => (
            <li key={item}>
              <GuideText text={item} />
            </li>
          ))}
        </ol>
      );
    case 'list':
      return (
        <ul className="list-disc space-y-1.5 ps-6 text-[14px] leading-7 text-fg marker:text-faint">
          {block.items.map((item) => (
            <li key={item}>
              <GuideText text={item} />
            </li>
          ))}
        </ul>
      );
    case 'note': {
      const Icon = block.tone === 'warn' ? TriangleAlert : Info;
      return (
        <aside
          className={clsx(
            'flex gap-2.5 rounded-[var(--radius-control)] border px-3 py-2.5 text-[13.5px] leading-6 text-fg',
            block.tone === 'warn' ? 'border-warn/40 bg-warn/[0.08]' : 'border-accent/30 bg-accent/[0.06]',
          )}
        >
          <Icon className={clsx('mt-1 size-4 shrink-0', block.tone === 'warn' ? 'text-warn' : 'text-accent-hover')} aria-hidden />
          <p>
            <GuideText text={block.text} />
          </p>
        </aside>
      );
    }
    case 'table':
      return (
        <div className="overflow-x-auto rounded-[var(--radius-control)] border border-line">
          <table className="w-full min-w-[28rem] border-collapse text-[13px]">
            <thead className="bg-raised/60">
              <tr>
                {block.head.map((h) => (
                  <th key={h} scope="col" className="border-b border-line px-3 py-2 text-start font-semibold text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row) => (
                <tr key={row.join('|')} className="border-b border-line last:border-b-0">
                  {row.map((cell, col) => {
                    const Cell = col === 0 ? 'th' : 'td';
                    return (
                      // A row's cells are keyed by their column heading (unique within a table).
                      <Cell key={block.head[col]} scope={col === 0 ? 'row' : undefined} className={clsx('px-3 py-2 text-start align-top', col === 0 ? 'font-medium text-fg' : 'text-fg')}>
                        <GuideText text={cell} />
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
  }
}

/** Blocks of one section differ in content, so the content keys them. */
const blockKey = (b: GuideBlock): string => {
  switch (b.kind) {
    case 'h':
      return `h:${b.id}`;
    case 'p':
    case 'note':
      return `${b.kind}:${b.text}`;
    case 'steps':
    case 'list':
      return `${b.kind}:${b.items[0] ?? ''}`;
    case 'table':
      return `table:${b.head.join('|')}:${b.rows[0]?.[0] ?? ''}`;
  }
};

export function GuideBlocks({ blocks }: { blocks: readonly GuideBlock[] }) {
  return (
    <div className="space-y-4">
      {blocks.map((b) => (
        <Block key={blockKey(b)} block={b} />
      ))}
    </div>
  );
}
