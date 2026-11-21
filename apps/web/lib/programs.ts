import { PROGRAMS, type ProgramId } from '@lan-detective/shared-types/programs';
import { PROGRAM_HOME, PROGRAM_PREFIX } from '@lan-detective/shared-types/routes';
import { PROGRAMS_BRAND } from '@nigafiy/brand';
import { FEATURES, type Feature } from '@/features/registry';

/**
 * The program registry (spec §5, §6.2): each program's id, names (EN + AR), job, accent, glyph, URL
 * namespace, home and sidebar sections. Names, jobs and pages come from the shared program table
 * (also served by GET /platform/programs), accents and glyphs from @nigafiy/brand, and each section
 * is the feature registry entry for one of the program's pages, in the program's page order.
 */
export interface ProgramEntry {
  id: ProgramId;
  name: { en: string; ar: string };
  /** The program's own name without the family name ("Radar"), for tight spots. */
  shortName: string;
  job: { en: string; ar: string };
  accent: string;
  /** Fill colour for primary buttons (white text at AA). */
  accentButton: string;
  /** 24×24 stroke path for the glyph. */
  glyph: string;
  /** URL namespace ('' for Hub, which owns the root). */
  prefix: string;
  home: string;
  pages: readonly string[];
  /** Sidebar items. */
  sections: Feature[];
}

/** Watch's approved accent misses AA with white text; its buttons use a darker shade (README tokens, Milestone 4 plan). */
const BUTTON_FILL: Partial<Record<ProgramId, string>> = { watch: '#A0650A' };

export const PROGRAM_REGISTRY: readonly ProgramEntry[] = PROGRAMS.map((p) => {
  const brand = PROGRAMS_BRAND[p.id];
  const sections = p.pages.map((page) => FEATURES.find((f) => f.route === page)).filter((f): f is Feature => Boolean(f));
  return {
    id: p.id,
    name: p.name,
    shortName: p.name.en.replace(/^Nigafiy\s+/, ''),
    job: p.job,
    accent: brand.accent,
    accentButton: BUTTON_FILL[p.id] ?? brand.accentButton ?? brand.accent,
    glyph: brand.glyph,
    prefix: PROGRAM_PREFIX[p.id],
    home: PROGRAM_HOME[p.id],
    pages: p.pages,
    sections,
  };
});

export const programById = (id: ProgramId): ProgramEntry => PROGRAM_REGISTRY.find((p) => p.id === id)!;

/** The program that owns a feature, by the feature registry. */
export const programOfFeature = (featureId: string): ProgramId => FEATURES.find((f) => f.id === featureId)?.program ?? 'hub';

/** Where "install" leads for a program that is not installed: the Hub's programs page. */
export const installHref = (id: ProgramId): string => `/programs#${id}`;
