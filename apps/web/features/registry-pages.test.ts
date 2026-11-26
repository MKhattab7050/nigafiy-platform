import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { PROGRAMS } from '../../../packages/shared-types/src/programs.ts';

// The sidebar shows a program's `pages` (lib/programs.ts); a feature registered for a program but missing
// from that list has no link anywhere (UX review 2026-11-26, item 4). registry.tsx imports React
// components, so its routes are read from the source text.
const source = readFileSync(new URL('./registry.tsx', import.meta.url), 'utf8');
const registered = [...source.matchAll(/program: '(\w+)',\s*route: '([^']+)'/g)].map((m) => ({ program: m[1]!, route: m[2]! }));

describe('sidebar pages', () => {
  it('reads the registry', () => {
    assert.ok(registered.length > 30, `only ${registered.length} features found`);
  });

  it('every registered page is in its program’s sidebar list', () => {
    const missing = registered.filter((f) => !PROGRAMS.find((p) => p.id === f.program)?.pages.includes(f.route));
    assert.deepEqual(missing, []);
  });
});
