// Copies the brand's app icon into the site before a build, so the favicon and icon are always the
// brand's current files. `pnpm build` regenerates packages/brand/ico (sharp's PNG encoding can differ
// by version and platform with the same pixels), so a committed copy would drift from it.
import { copyFileSync } from 'node:fs';
import path from 'node:path';

const site = path.resolve(import.meta.dirname, '..');
const brand = path.resolve(site, '..', '..', 'packages', 'brand');
const files: Array<[string, string]> = [
  [path.join(brand, 'svg', 'app-icon.svg'), path.join(site, 'public', 'icon.svg')],
  [path.join(brand, 'ico', 'app.ico'), path.join(site, 'public', 'favicon.ico')],
];
for (const [from, to] of files) copyFileSync(from, to);
console.log(`[site] brand icons copied (${files.length})`);
