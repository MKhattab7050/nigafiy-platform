'use client';

import { useEffect } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keeps keyboard focus inside `ref` while `active` (for overlays that are not a native <dialog>):
 * moves focus into it, wraps Tab / Shift+Tab at the ends, calls `onEscape` on Escape, and gives
 * focus back to whatever had it before when the overlay closes.
 */
export function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void) {
  useEffect(() => {
    const root = ref.current;
    if (!active || !root) return;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const items = () => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
    (items()[0] ?? root).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && onEscape) {
        e.preventDefault();
        onEscape();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = items();
      const first = list[0];
      const last = list[list.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const current = document.activeElement;
      if (e.shiftKey && (current === first || !root.contains(current))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (current === last || !root.contains(current))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (before?.isConnected) before.focus();
    };
  }, [ref, active, onEscape]);
}
