// The in-app user guide: the shape of its content. One content file per language
// (content/en.ts, content/ar.ts) holds every section in this shape. This file has no runtime
// imports, so `node --test` runs the unit tests (guide.test.ts) against the content directly.
import type { ProgramId } from '@nigafiy/shared-types/programs';

/** Every section, in reading order. Both languages hold exactly these ids in this order (guide.test.ts). */
export const GUIDE_SECTION_IDS = [
  'getting-started',
  'programs',
  'first-scan',
  'devices',
  'fleet-enroll',
  'routers',
  'hub',
  'radar',
  'watch',
  'guard',
  'fleet',
  'fleet-pro',
  'mind',
  'toolbox',
  'troubleshooting',
] as const;
export type GuideSectionId = (typeof GUIDE_SECTION_IDS)[number];

/** Where a section is listed on the guide's front page. */
export type GuideGroup = 'start' | 'tasks' | 'programs' | 'help';

/**
 * One block of a section. Text is plain: `backticks` mark a technical value (an address, a command,
 * a file name), which the page shows in a left-to-right isolate so it reads correctly in Arabic.
 */
export type GuideBlock =
  /** A sub-heading; `id` is the anchor (`/guide/<section>#<id>`) and is the same in both languages. */
  | { kind: 'h'; id: string; text: string }
  | { kind: 'p'; text: string }
  /** Numbered steps. */
  | { kind: 'steps'; items: readonly string[] }
  /** Bullet points. */
  | { kind: 'list'; items: readonly string[] }
  /** A highlighted note: `info` for tips, `warn` for safety and for what has not been tried on real hardware. */
  | { kind: 'note'; tone: 'info' | 'warn'; text: string }
  | { kind: 'table'; head: readonly string[]; rows: readonly (readonly string[])[] };

export interface GuideSection {
  id: GuideSectionId;
  group: GuideGroup;
  /** The program this section is about, so it can be marked "Not installed" (null: about Nigafiy as a whole). */
  program: ProgramId | null;
  title: string;
  /** One sentence under the title and on the front page. */
  summary: string;
  blocks: readonly GuideBlock[];
  /** Pages of the app this section talks about ("Open" links at the end). */
  links?: readonly { href: string; label: string }[];
}

export type GuideContent = readonly GuideSection[];
