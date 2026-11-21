/**
 * Nigafiy brand tokens: the logo colours and one accent per program.
 * Values are the owner-approved ones in docs/design/mockups/README.md (2026-11-21).
 * The SVG and .ico files in this package are generated from these by scripts/make-icons.mjs.
 */
export type ProgramId = 'hub' | 'radar' | 'watch' | 'guard' | 'fleet' | 'mind' | 'toolbox' | 'agent' | 'sensor';

export const PROGRAM_IDS: readonly ProgramId[] = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox', 'agent', 'sensor'];

/** Logo colours (logo only; UI uses the program accents). */
export const BRAND = {
  blue: '#1A73FF',
  navy: '#0B2A7A',
  wordmark: '#0B1F5C',
  iconGround: '#0B1F5C',
  /** The darker blue of the n's right leg on the app icon. */
  iconShade: '#0F4FD1',
  hub: '#1466E6',
} as const;

export interface ProgramBrand {
  /** English display name ("Nigafiy Radar"). The brand stays in Latin letters in Arabic text too. */
  readonly name: string;
  /** Accent for the program's UI and icon ground. */
  readonly accent: string;
  /** A darker accent for filled buttons where the accent itself misses AA contrast with white text. */
  readonly accentButton?: string;
  /** 24×24 stroke path (stroke #fff, round caps and joins). */
  readonly glyph: string;
}

export const PROGRAMS_BRAND: Readonly<Record<ProgramId, ProgramBrand>> = {
  hub: { name: 'Nigafiy Hub', accent: '#1466E6', glyph: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z' },
  radar: {
    name: 'Nigafiy Radar',
    accent: '#0099BC',
    accentButton: '#00809D',
    glyph: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 12m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M12 12l5.5-5.5',
  },
  watch: { name: 'Nigafiy Watch', accent: '#C27C0E', glyph: 'M3 12h4l2-5 4 10 2-5h6' },
  guard: { name: 'Nigafiy Guard', accent: '#D13438', glyph: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z' },
  fleet: { name: 'Nigafiy Fleet', accent: '#7A4FD6', glyph: 'M3 5h12v9H3zM6 18h6M9 14v4M17 8h4v9h-6' },
  mind: {
    name: 'Nigafiy Mind',
    accent: '#C239B3',
    glyph: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18',
  },
  toolbox: { name: 'Nigafiy Toolbox', accent: '#2E8540', glyph: 'M14.5 5.5a4 4 0 0 0-5 5l-6 6 2 2 6-6a4 4 0 0 0 5-5l-2.5 2.5-2-2z' },
  agent: { name: 'Nigafiy Agent', accent: '#4B5563', glyph: 'M4 5h16v11H4zM9 20h6M12 16v4M9 10l2 2 4-4' },
  sensor: {
    name: 'Nigafiy Sensor',
    accent: '#3D6E7A',
    glyph: 'M12 18v3M8 21h8M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8.5 10.5a5 5 0 0 1 7 0M5.5 7.5a9 9 0 0 1 13 0',
  },
};

/** Status colours (light theme). Always shown with an icon and a word, never colour alone. */
export const STATUS = { ok: '#0E7A0D', warning: '#9D5300', critical: '#B3261E', unknown: '#5C5C5C' } as const;

/** The two-tone lowercase n on a 32×32 grid (logo D): left stroke in logo blue, right leg in navy. */
export const MARK_PATHS = {
  blue: 'M5 9.2a4 4 0 0 1 6-3.5l14 8A5 5 0 0 1 27.5 18v5a3.5 3.5 0 0 1-3.5 3.5h-1a3.5 3.5 0 0 1-3.5-3.5v-5.8L12.5 13v10a3.5 3.5 0 0 1-3.5 3.5h-.5A3.5 3.5 0 0 1 5 23z',
  navy: 'M12.5 13l5.7-3.3 6.8 3.9A5 5 0 0 1 27.5 18v5a3.5 3.5 0 0 1-3.5 3.5h-1a3.5 3.5 0 0 1-3.5-3.5v-5.8z',
} as const;

/** The n as it sits on the app icon's navy square (32×32 grid). */
export const APP_ICON_PATHS = {
  blue: 'M8 11a3 3 0 0 1 4.5-2.6l9.5 5.5a4 4 0 0 1 2 3.4V22a2 2 0 0 1-2 2h-1.5a2 2 0 0 1-2-2v-4.3L13.3 15v7a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2z',
  shade: 'M13.3 15l3.9-2.3 4.8 2.8a4 4 0 0 1 2 3.4V22a2 2 0 0 1-2 2h-1.5a2 2 0 0 1-2-2v-4.3z',
} as const;
