/**
 * Spot illustrations for empty, setup and sign-in states. Original line drawings on a network
 * theme: hairline strokes in the current ink, the accent only on the one node that matters.
 * Decorative (aria-hidden): the text next to them always says what they show.
 */

const ink = { stroke: 'currentColor', fill: 'none', strokeWidth: 1.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
const faint = { ...ink, strokeOpacity: 0.45 };

/** A collector box inside a small LAN, its links not yet live (dashed): "connect your network". */
export function SetupArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 120" className={className ?? 'h-24 w-40'} aria-hidden>
      <g {...faint} strokeDasharray="3 4">
        <path d="M100 62 L40 30" />
        <path d="M100 62 L40 92" />
        <path d="M100 62 L160 30" />
        <path d="M100 62 L160 92" />
      </g>
      <g {...ink}>
        <rect x="26" y="20" width="28" height="20" rx="3" />
        <path d="M33 44h14" />
        <rect x="146" y="20" width="28" height="20" rx="3" />
        <path d="M153 44h14" />
        <rect x="28" y="82" width="24" height="18" rx="3" />
        <circle cx="160" cy="92" r="9" />
        <path d="M156 92h8M160 88v8" strokeOpacity="0.6" />
      </g>
      <rect x="80" y="48" width="40" height="28" rx="5" fill="var(--color-surface)" stroke="var(--color-accent)" strokeWidth="1.75" />
      <g stroke="var(--color-accent)" strokeWidth="1.5" strokeLinecap="round">
        <path d="M88 56h12" />
        <path d="M88 62h18" strokeOpacity="0.6" />
      </g>
      <circle cx="111" cy="68" r="2.2" fill="var(--color-accent)" />
    </svg>
  );
}

/** A flat pulse with a resolved node: "nothing is wrong right now". */
export function AllClearArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 96" className={className ?? 'h-20 w-40'} aria-hidden>
      <path d="M8 60 H62 L70 46 L78 72 L86 60 H192" {...faint} />
      <path d="M8 76 H192" {...faint} strokeDasharray="2 5" />
      <circle cx="132" cy="44" r="16" fill="var(--color-surface)" stroke="var(--color-ok)" strokeWidth="1.75" />
      <path d="M124.5 44.5 L130 50 L140 39" stroke="var(--color-ok)" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />    </svg>
  );
}

/** An empty patch panel: rows of unused ports, one highlighted. "Nothing listed yet." */
export function EmptyPortsArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 96" className={className ?? 'h-20 w-40'} aria-hidden>
      <rect x="20" y="22" width="160" height="52" rx="6" {...ink} />
      <g {...faint}>
        {Array.from({ length: 8 }, (_, i) => (
          <rect key={`a${i}`} x={32 + i * 18} y={33} width={12} height={10} rx={2} />
        ))}
        {Array.from({ length: 8 }, (_, i) => (i === 5 ? null : <rect key={`b${i}`} x={32 + i * 18} y={51} width={12} height={10} rx={2} />))}
      </g>
      <rect x={122} y={51} width={12} height={10} rx={2} fill="none" stroke="var(--color-accent)" strokeWidth="1.75" />
      <path d="M128 61 V82 H150" stroke="var(--color-accent)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeDasharray="3 3" />
      <circle cx="154" cy="82" r="3" fill="var(--color-accent)" />
    </svg>
  );
}

/** A lens over a grid of nodes: "no match for this filter / search". */
export function SearchArt({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 200 96" className={className ?? 'h-20 w-40'} aria-hidden>
      <g fill="currentColor" fillOpacity="0.35">
        {Array.from({ length: 5 }, (_, r) => Array.from({ length: 9 }, (_, c) => <circle key={`${r}-${c}`} cx={28 + c * 18} cy={16 + r * 16} r={1.6} />))}
      </g>
      <circle cx="104" cy="46" r="20" fill="var(--color-surface)" stroke="currentColor" strokeWidth="1.75" />
      <path d="M118.5 60.5 L132 74" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <path d="M96 46 h16" stroke="var(--color-accent)" strokeWidth="1.75" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Sign-in side art: a site's topology drawn as a quiet constellation — internet, gateway, two
 * switches and their endpoints — with one measured path traced in the accent.
 */
export function TopologyArt({ className }: { className?: string }) {
  const leaves: [number, number, number, number][] = [
    [118, 168, 70, 222],
    [118, 168, 112, 236],
    [118, 168, 154, 226],
    [262, 168, 230, 228],
    [262, 168, 272, 240],
    [262, 168, 314, 222],
  ];
  return (
    <svg viewBox="0 0 380 280" className={className ?? 'w-full'} aria-hidden>
      <g {...faint}>
        <path d="M190 44 V96" />
        <path d="M190 96 L118 168" />
        <path d="M190 96 L262 168" />
        {leaves.map(([x1, y1, x2, y2], i) => (
          <path key={i} d={`M${x1} ${y1} L${x2} ${y2}`} strokeDasharray={i === 2 ? '3 4' : undefined} />
        ))}
        <path d="M118 168 H262" strokeDasharray="2 5" />
      </g>
      {/* the measured path: internet → gateway → switch → one computer */}
      <path d="M190 44 V96 L262 168 L314 222" fill="none" stroke="var(--color-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      <g {...ink}>
        <circle cx="190" cy="34" r="12" />
        <path d="M178 34 h24 M190 22 c-6 7 -6 17 0 24 c6 -7 6 -17 0 -24" strokeOpacity="0.6" />
        <rect x="172" y="88" width="36" height="18" rx="4" fill="var(--color-surface)" />
        <rect x="98" y="160" width="40" height="16" rx="3" fill="var(--color-surface)" />
        <rect x="242" y="160" width="40" height="16" rx="3" fill="var(--color-surface)" />
        {leaves.map(([, , x, y], i) => (
          <rect key={i} x={x - 10} y={y - 7} width={20} height={14} rx={2.5} fill="var(--color-surface)" strokeOpacity={i === 2 ? 0.45 : 1} />
        ))}
      </g>
      <g fill="currentColor" fillOpacity="0.5">
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={104 + i * 8} y={166} width={4} height={4} rx={1} />
        ))}
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={248 + i * 8} y={166} width={4} height={4} rx={1} />
        ))}
      </g>
      <circle cx="314" cy="222" r="4" fill="var(--color-accent)" />
      <circle cx="199" cy="97" r="2.4" fill="var(--color-ok)" />
    </svg>
  );
}
