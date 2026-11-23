import { BRAND, MARK_PATHS } from '@nigafiy/brand';
import { WORDMARK } from '@nigafiy/brand/wordmark';

/**
 * The Nigafiy mark (logo D, @nigafiy/brand): the two-tone rounded lowercase n. Logo colours are
 * fixed (they are the brand, not the theme); the program UI uses the program accents.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className ?? 'size-7 shrink-0'} aria-hidden>
      <path d={MARK_PATHS.blue} fill={BRAND.blue} />
      <path d={MARK_PATHS.navy} fill={BRAND.navy} />
    </svg>
  );
}

/** The lowercase wordmark as outlines (Poppins 600, no font needed), in the current ink: wordmark navy on light, white on dark. */
export function Wordmark({ className }: { className?: string }) {
  return (
    <svg viewBox={WORDMARK.viewBox} className={className ?? 'h-[15px] w-auto text-wordmark'} role="img" aria-label="Nigafiy">
      <path d={WORDMARK.d} fill="currentColor" />
    </svg>
  );
}

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2" dir="ltr">
      <LogoMark />
      {!compact && <Wordmark />}
      {compact && <span className="sr-only">Nigafiy</span>}
    </span>
  );
}
