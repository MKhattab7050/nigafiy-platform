// The changelog page's data: content/changelog.json, written by scripts/changelog.ts from git.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { SITE_DIR } from './paths.ts';

export const ChangelogSchema = z.object({
  source: z.object({ kind: z.string(), branch: z.string(), head: z.string(), generated_at: z.string() }),
  entries: z.array(z.object({ hash: z.string().regex(/^[0-9a-f]{7,40}$/), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), subject: z.string() })),
});
export type Changelog = z.infer<typeof ChangelogSchema>;

export function loadChangelog(file = path.join(SITE_DIR, 'content', 'changelog.json')): Changelog {
  return ChangelogSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

/** Entries grouped by day, newest first (git log order is kept inside a day). */
export function byDay(entries: Changelog['entries']): { date: string; items: Changelog['entries'] }[] {
  const days: { date: string; items: Changelog['entries'] }[] = [];
  for (const e of entries) {
    const last = days[days.length - 1];
    if (last?.date === e.date) last.items.push(e);
    else days.push({ date: e.date, items: [e] });
  }
  return days;
}
