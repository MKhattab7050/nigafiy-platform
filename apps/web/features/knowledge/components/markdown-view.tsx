'use client';

import Link from 'next/link';
import { type Block, type Inline, parseMarkdown } from '@lan-detective/shared-types/markdown';

/**
 * Renders the safe markdown subset as React elements. The parser never produces HTML and React
 * escapes every text node, so nothing a person typed can inject markup or script.
 */
function InlineView({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((n, i) => {
        switch (n.type) {
          case 'text':
            return <span key={i}>{n.text}</span>;
          case 'strong':
            return (
              <strong key={i} className="font-semibold">
                <InlineView nodes={n.children} />
              </strong>
            );
          case 'em':
            return (
              <em key={i}>
                <InlineView nodes={n.children} />
              </em>
            );
          case 'code':
            return (
              <code key={i} className="mono rounded-[4px] bg-raised px-1 py-0.5 text-[12px]" dir="ltr">
                {n.text}
              </code>
            );
          case 'link':
            return n.external ? (
              <a key={i} href={n.href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent-hover underline">
                <InlineView nodes={n.children} />
              </a>
            ) : (
              <Link key={i} href={n.href} className="text-accent-hover underline">
                <InlineView nodes={n.children} />
              </Link>
            );
          default:
            return null;
        }
      })}
    </>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.type) {
    case 'heading': {
      const cls = block.level === 1 ? 'text-[15px] font-semibold' : block.level === 2 ? 'text-[14px] font-semibold' : 'text-[13px] font-semibold';
      return (
        <p role="heading" aria-level={block.level + 2} className={cls}>
          <InlineView nodes={block.children} />
        </p>
      );
    }
    case 'paragraph':
      return (
        <p>
          <InlineView nodes={block.children} />
        </p>
      );
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>
          <InlineView nodes={item} />
        </li>
      ));
      return block.ordered ? <ol className="list-decimal space-y-1 ps-5">{items}</ol> : <ul className="list-disc space-y-1 ps-5">{items}</ul>;
    }
    case 'quote':
      return (
        <blockquote className="border-s-2 border-line-strong ps-3 text-muted">
          <InlineView nodes={block.children} />
        </blockquote>
      );
    case 'code':
      return (
        <pre className="mono overflow-x-auto rounded-[var(--radius-control)] border border-line bg-sunken px-3 py-2 text-[12px]" dir="ltr">
          {block.text}
        </pre>
      );
  }
}

export function MarkdownView({ source, empty }: { source: string; empty?: string }) {
  const blocks = parseMarkdown(source);
  if (!blocks.length) return <p className="text-[13px] text-faint">{empty ?? '—'}</p>;
  return (
    <div className="space-y-2 text-[13px] leading-relaxed text-fg" dir="auto">
      {blocks.map((b, i) => (
        <BlockView key={i} block={b} />
      ))}
    </div>
  );
}
