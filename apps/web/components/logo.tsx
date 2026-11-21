/**
 * The LAN Detective mark: a lens whose glass holds a three-node network. Drawn with the accent and
 * the current ink, so it follows the theme. The wordmark is set in the UI face, one weight.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 28 28" className={className ?? 'size-7 shrink-0'} aria-hidden>
      <rect x="0.5" y="0.5" width="27" height="27" rx="7.5" className="fill-accent" />
      <circle cx="12.2" cy="12.2" r="6.6" fill="none" stroke="var(--color-on-accent)" strokeWidth="1.9" />
      <path d="M17 17l5 5" stroke="var(--color-on-accent)" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M9.6 13.9 12.2 9.4 14.8 13.9Z" fill="none" stroke="var(--color-on-accent)" strokeOpacity="0.7" strokeWidth="1" strokeLinejoin="round" />
      <circle cx="12.2" cy="9.4" r="1.45" fill="var(--color-on-accent)" />
      <circle cx="9.6" cy="13.9" r="1.45" fill="var(--color-on-accent)" />
      <circle cx="14.8" cy="13.9" r="1.45" fill="var(--color-on-accent)" />
    </svg>
  );
}

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <LogoMark />
      {!compact && (
        <span className="whitespace-nowrap text-[15px] font-semibold tracking-[-0.01em] text-fg" dir="ltr">
          LAN Detective
        </span>
      )}
    </span>
  );
}
