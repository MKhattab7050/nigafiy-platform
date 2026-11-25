// Plural forms for count sentences, chosen with the language's own CLDR rules (`Intl.PluralRules`).
//
// A plural string lists one form per category, separated by " | ", each starting with the category:
//   en: 'one: {n} device | other: {n} devices'
//   ar: 'zero: لا أجهزة | one: جهاز واحد | two: جهازان | few: {n} أجهزة | many: {n} جهازًا | other: {n} جهاز'
// English needs `one` and `other`; Arabic needs all six (zero, one, two, few, many, other). The
// dictionary test checks that every plural key carries exactly the forms its language needs.
// Leaf module (no imports), so `node --test` can load it.

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
export type PluralCategory = (typeof PLURAL_CATEGORIES)[number];

const FORM = /^(zero|one|two|few|many|other): ([\s\S]*)$/;

/** The forms of a plural string, or null when the string is an ordinary sentence. */
export function parsePlural(text: string): Partial<Record<PluralCategory, string>> | null {
  const parts = text.split(' | ');
  const out: Partial<Record<PluralCategory, string>> = {};
  for (const part of parts) {
    const m = FORM.exec(part);
    if (!m) return null;
    out[m[1] as PluralCategory] = m[2] as string;
  }
  return 'other' in out ? out : null;
}

const rules = new Map<string, Intl.PluralRules>();
function rulesFor(locale: string): Intl.PluralRules {
  let r = rules.get(locale);
  if (!r) {
    r = new Intl.PluralRules(locale);
    rules.set(locale, r);
  }
  return r;
}

/** The categories a language uses for cardinal numbers (en: one, other; ar: all six). */
export function pluralCategoriesFor(locale: string): PluralCategory[] {
  const used = new Set(rulesFor(locale).resolvedOptions().pluralCategories as string[]);
  return PLURAL_CATEGORIES.filter((c) => used.has(c));
}

/**
 * The form of `text` for `count` in `locale`. An ordinary (non-plural) string comes back unchanged,
 * so converting a key to plural forms never breaks a caller. `{placeholders}` are left for `fill`.
 */
export function selectPlural(text: string, count: number, locale: string): string {
  const forms = parsePlural(text);
  if (!forms) return text;
  const category = rulesFor(locale).select(count) as PluralCategory;
  return forms[category] ?? forms.other ?? text;
}
