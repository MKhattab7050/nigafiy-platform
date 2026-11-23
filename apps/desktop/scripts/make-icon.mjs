// Copies the Nigafiy app icon from @nigafiy/brand into assets/: icon.png (256×256, windows and the
// tray) and icon.ico (all Windows sizes, the installer and the .exe). The brand package generates
// both from its vectors (pnpm --filter @nigafiy/brand build); this script only copies them.
import { copyFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const brand = path.resolve(import.meta.dirname, '../../../packages/brand');
const assets = path.resolve(import.meta.dirname, '../assets');
mkdirSync(assets, { recursive: true });
for (const [from, to] of [
  ['png/app-256.png', 'icon.png'],
  ['ico/app.ico', 'icon.ico'],
]) {
  copyFileSync(path.join(brand, from), path.join(assets, to));
  console.log(`wrote ${path.join(assets, to)} (from @nigafiy/brand ${from})`);
}
