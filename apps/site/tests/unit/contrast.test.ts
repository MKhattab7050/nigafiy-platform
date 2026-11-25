// WCAG 2.2 AA contrast of the site's colour tokens (app/globals.css) in both themes, and of white
// text on every filled button (the program accents).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { PROGRAMS_BRAND } from '@nigafiy/brand';

const css = readFileSync(path.resolve(import.meta.dirname, '../../app/globals.css'), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, selector);
  const body = css.slice(start, css.indexOf('}', start));
  return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));
}

function lum(hex: string): number {
  const c = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}

const light = block(':root');
const dark = { ...light, ...block(":root[data-theme='dark']") };

describe('contrast (AA: 4.5:1 for text)', () => {
  for (const [name, t] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    it(`${name}: text, muted text, links and badges on every background`, () => {
      for (const bg of ['bg', 'panel', 'card']) {
        for (const fg of ['fg', 'fg2', 'link']) assert.ok(contrast(t[fg]!, t[bg]!) >= 4.5, `${name} ${fg} on ${bg}: ${contrast(t[fg]!, t[bg]!).toFixed(2)}`);
      }
      assert.ok(contrast(t.warn!, t['warn-bg']!) >= 4.5, `${name} warn`);
      assert.ok(contrast(t.unknown!, t['unknown-bg']!) >= 4.5, `${name} unknown badge`);
      assert.ok(contrast(t.fg!, t['code-bg']!) >= 4.5, `${name} code`);
      // Focus ring against the page (non-text: 3:1).
      assert.ok(contrast(t.focus!, t.bg!) >= 3, `${name} focus ring`);
    });
  }

  it('white text on every filled button', () => {
    const fills: Record<string, string> = { watch: '#a0650a' };
    for (const [id, p] of Object.entries(PROGRAMS_BRAND)) {
      const fill = fills[id] ?? p.accentButton ?? p.accent;
      assert.ok(contrast('#ffffff', fill.toLowerCase()) >= 4.5, `${id} ${fill}: ${contrast('#ffffff', fill.toLowerCase()).toFixed(2)}`);
    }
  });
});
