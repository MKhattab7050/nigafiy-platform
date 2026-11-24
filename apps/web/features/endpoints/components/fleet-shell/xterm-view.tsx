'use client';

import '@xterm/xterm/css/xterm.css';
import type { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';

/**
 * xterm.js in a box that fits its container. `onReady` gets the terminal (and a fit function that
 * returns the new size); the terminal is disposed with the component.
 */
export function XtermView({
  onReady,
  readOnly,
  label,
  className,
}: {
  onReady: (term: Terminal, fit: () => { cols: number; rows: number }) => (() => void) | void;
  readOnly?: boolean;
  label: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const ready = useRef(onReady);
  ready.current = onReady;

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | void;
    let term: Terminal | null = null;
    let observer: ResizeObserver | null = null;
    void (async () => {
      const [{ Terminal: Xterm }, { FitAddon }] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
      if (disposed || !box.current) return;
      term = new Xterm({
        cursorBlink: !readOnly,
        disableStdin: Boolean(readOnly),
        convertEol: Boolean(readOnly),
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        scrollback: 5000,
        theme: { background: '#0b0f14', foreground: '#d8dee9' },
      });
      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(box.current);
      const fit = () => {
        try {
          fitAddon.fit();
        } catch {
          /* not visible yet */
        }
        return { cols: term!.cols, rows: term!.rows };
      };
      fit();
      cleanup = ready.current(term, fit);
      observer = new ResizeObserver(() => fit());
      observer.observe(box.current);
      if (!readOnly) term.focus();
    })();
    return () => {
      disposed = true;
      observer?.disconnect();
      if (cleanup) cleanup();
      term?.dispose();
    };
  }, [readOnly]);

  return <div ref={box} role="region" aria-label={label} dir="ltr" className={className ?? 'h-[28rem] w-full overflow-hidden rounded-md border border-line bg-[#0b0f14] p-1'} />;
}
