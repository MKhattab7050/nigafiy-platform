// Generates the README artwork (docs/assets/readme/*.svg) from the brand files and tokens.
// Run: node scripts/make-readme-art.mjs   (rewrites docs/assets/readme/*.svg; animations are CSS keyframes,
// switched off under prefers-reduced-motion; no fonts, scripts or external references)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs/assets/readme');
mkdirSync(out, { recursive: true });

// Values copied from packages/brand/src/tokens.ts (read below to fail loudly if they drift).
const tokens = readFileSync(path.join(root, 'packages/brand/src/tokens.ts'), 'utf8');
const P = {
  hub: { accent: '#1466E6', glyph: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z', name: 'Hub' },
  radar: { accent: '#0099BC', glyph: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 12m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M12 12l5.5-5.5', name: 'Radar' },
  watch: { accent: '#C27C0E', glyph: 'M3 12h4l2-5 4 10 2-5h6', name: 'Watch' },
  guard: { accent: '#D13438', glyph: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z', name: 'Guard' },
  fleet: { accent: '#7A4FD6', glyph: 'M3 5h12v9H3zM6 18h6M9 14v4M17 8h4v9h-6', name: 'Fleet' },
  mind: { accent: '#C239B3', glyph: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18', name: 'Mind' },
  toolbox: { accent: '#2E8540', glyph: 'M14.5 5.5a4 4 0 0 0-5 5l-6 6 2 2 6-6a4 4 0 0 0 5-5l-2.5 2.5-2-2z', name: 'Toolbox' },
  sensor: { accent: '#3D6E7A', glyph: 'M12 18v3M8 21h8M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8.5 10.5a5 5 0 0 1 7 0M5.5 7.5a9 9 0 0 1 13 0', name: 'Sensor' },
};
for (const [id, p] of Object.entries(P)) {
  if (!tokens.includes(p.accent) || !tokens.includes(p.glyph)) throw new Error(`brand token drift for ${id}`);
}
const BELL = 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0';

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";
const THEMES = {
  light: { bg1: '#F7FAFF', bg2: '#E6EEFF', ink: '#0B1F5C', muted: '#44507A', line: '#9DB4E8', chip: '#FFFFFF', chipStroke: '#D5E0F7', logo: 'logo.svg' },
  dark: { bg1: '#0E2366', bg2: '#061233', ink: '#FFFFFF', muted: '#B9C6EA', line: '#3A5BB0', chip: '#10275F', chipStroke: '#25438F', logo: 'logo-light.svg' },
};

const reduced = `@media (prefers-reduced-motion: reduce){.a,.a *{animation:none!important}}`;

function logoInner(file) {
  const svg = readFileSync(path.join(root, 'packages/brand/svg', file), 'utf8');
  const m = svg.match(/^<svg[^>]*viewBox="([^"]+)"[^>]*>(.*)<\/svg>\s*$/s);
  if (!m) throw new Error('unexpected logo file');
  return { viewBox: m[1], body: m[2].replace(/<title>.*?<\/title>/, '') };
}

function glyph(id, cx, cy, size) {
  const s = size / 24;
  return `<path d="${P[id].glyph}" transform="translate(${(cx - 12 * s).toFixed(2)} ${(cy - 12 * s).toFixed(2)}) scale(${s.toFixed(4)})" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function hero(themeName) {
  const t = THEMES[themeName];
  const logo = logoInner(t.logo);
  const cx = 950, cy = 170, R = 118;
  const ring = ['radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'];
  const nodes = ring.map((id, i) => {
    const ang = (-90 + i * 60) * Math.PI / 180;
    return { id, x: +(cx + R * Math.cos(ang)).toFixed(1), y: +(cy + R * Math.sin(ang)).toFixed(1) };
  });
  // Small device dots on an outer ring, linked to their nearest program node.
  const devices = [];
  for (let i = 0; i < 12; i++) {
    const ang = (-75 + i * 30) * Math.PI / 180;
    const r = 175 + (i % 2) * 14;
    devices.push({ x: +(cx + r * Math.cos(ang)).toFixed(1), y: +(cy + r * 0.78 * Math.sin(ang)).toFixed(1), n: nodes[Math.floor(((i + 0.5) / 2)) % 6] });
  }
  const links = nodes.map((n, i) => `<line class="flow" style="animation-delay:-${(i * 0.35).toFixed(2)}s" x1="${cx}" y1="${cy}" x2="${n.x}" y2="${n.y}"/>`).join('');
  const ringLinks = nodes.map((n, i) => { const m = nodes[(i + 1) % 6]; return `<line x1="${n.x}" y1="${n.y}" x2="${m.x}" y2="${m.y}"/>`; }).join('');
  const devLinks = devices.map((d) => `<line x1="${d.n.x}" y1="${d.n.y}" x2="${d.x}" y2="${d.y}"/>`).join('');
  const devDots = devices.map((d, i) => `<circle class="blink" style="animation-delay:${(i * 0.45).toFixed(2)}s" cx="${d.x}" cy="${d.y}" r="4"/>`).join('');
  const nodeEls = nodes.map((n, i) => `<g><circle class="pulse" style="animation-delay:${(i * 0.5).toFixed(1)}s" cx="${n.x}" cy="${n.y}" r="22" fill="none" stroke="${P[n.id].accent}" stroke-width="2"/><circle cx="${n.x}" cy="${n.y}" r="22" fill="${P[n.id].accent}"/>${glyph(n.id, n.x, n.y, 22)}</g>`).join('');
  const chips = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'];
  // Chip = left padding, dot, gap, label, right padding. The label is centred in its own slot, so a
  // system font that is a little wider or narrower than the estimate still leaves even padding.
  const CHIP = { h: 32, y: 250, padL: 14, dot: 5, gap: 9, padR: 16, space: 12, charW: 8.4 };
  // Label widths measured in the browser (Segoe UI, 14 px, weight 600, getComputedTextLength), so every
  // chip gets the same padding; a name not listed falls back to the per-character estimate.
  const LABEL_W = { Hub: 26.9, Radar: 37, Watch: 40, Guard: 38.7, Fleet: 30.6, Mind: 33.2, Toolbox: 50.3 };
  let x = 64;
  const chipEls = chips.map((id) => {
    const tw = LABEL_W[P[id].name] ?? P[id].name.length * CHIP.charW;
    const w = CHIP.padL + CHIP.dot * 2 + CHIP.gap + tw + CHIP.padR;
    const cy = CHIP.y + CHIP.h / 2;
    const dotX = x + CHIP.padL + CHIP.dot;
    const textX = x + CHIP.padL + CHIP.dot * 2 + CHIP.gap + tw / 2;
    const el = `<g><rect x="${x.toFixed(1)}" y="${CHIP.y}" width="${w.toFixed(1)}" height="${CHIP.h}" rx="${CHIP.h / 2}" fill="${t.chip}" stroke="${t.chipStroke}"/><circle cx="${dotX.toFixed(1)}" cy="${cy}" r="${CHIP.dot}" fill="${P[id].accent}"/><text x="${textX.toFixed(1)}" y="${cy + 5}" text-anchor="middle" font-size="14" font-weight="600" fill="${t.ink}">${P[id].name}</text></g>`;
    x += w + CHIP.space;
    return el;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 340" width="1200" height="340" role="img" aria-labelledby="t d">
<title id="t">Nigafiy</title>
<desc id="d">Nigafiy: seven programs on one local engine. A network of program nodes around the engine, with data flowing along the links.</desc>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/></linearGradient>
<radialGradient id="glow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#1A73FF" stop-opacity="0.35"/><stop offset="1" stop-color="#1A73FF" stop-opacity="0"/></radialGradient>
<style>
text{font-family:${FONT}}
.flow{stroke:#1A73FF;stroke-width:2.5;stroke-dasharray:6 10;animation:flow 1.6s linear infinite}
.pulse{transform-box:fill-box;transform-origin:center;animation:pulse 3s ease-out infinite;opacity:0}
.blink{fill:${t.line};animation:blink 5.4s ease-in-out infinite}
.halo{transform-box:fill-box;transform-origin:center;animation:breathe 4s ease-in-out infinite}
.sweep{transform-origin:${cx}px ${cy}px;animation:spin 9s linear infinite}
@keyframes flow{to{stroke-dashoffset:-32}}
@keyframes pulse{0%{transform:scale(1);opacity:.7}100%{transform:scale(2.1);opacity:0}}
@keyframes blink{0%,100%{opacity:.45}50%{opacity:1}}
@keyframes breathe{0%,100%{transform:scale(.92);opacity:.7}50%{transform:scale(1.08);opacity:1}}
@keyframes spin{to{transform:rotate(360deg)}}
${reduced}
</style>
</defs>
<rect width="1200" height="340" rx="24" fill="url(#bg)"/>
<svg x="64" y="62" width="330" height="${(330 * 110.99 / 486.86).toFixed(1)}" viewBox="${logo.viewBox}">${logo.body}</svg>
<text x="64" y="186" font-size="27" font-weight="700" fill="${t.ink}">Know your network. Understand every incident.</text>
<text x="64" y="221" font-size="17" fill="${t.muted}">Seven programs on one local engine · Windows-first · English + العربية</text>
${chipEls}
<g class="a">
<circle class="halo" cx="${cx}" cy="${cy}" r="150" fill="url(#glow)"/>
<g class="sweep"><path d="M${cx} ${cy}L${cx} ${cy - 150}A150 150 0 0 1 ${(cx + 150 * Math.sin(Math.PI / 6)).toFixed(1)} ${(cy - 150 * Math.cos(Math.PI / 6)).toFixed(1)}Z" fill="#1A73FF" opacity="0.08"/></g>
<g stroke="${t.line}" stroke-width="1.2" opacity="0.8">${devLinks}${ringLinks}</g>
<g>${links}</g>
${devDots}
${nodeEls}
<circle class="pulse" cx="${cx}" cy="${cy}" r="30" fill="none" stroke="#1A73FF" stroke-width="2.5"/>
<circle cx="${cx}" cy="${cy}" r="30" fill="${themeName === 'dark' ? '#FFFFFF' : '#0B1F5C'}"/>
<svg x="${cx - 19}" y="${cy - 19}" width="38" height="38" viewBox="0 0 32 32"><path d="M5 9.2a4 4 0 0 1 6-3.5l14 8A5 5 0 0 1 27.5 18v5a3.5 3.5 0 0 1-3.5 3.5h-1a3.5 3.5 0 0 1-3.5-3.5v-5.8L12.5 13v10a3.5 3.5 0 0 1-3.5 3.5h-.5A3.5 3.5 0 0 1 5 23z" fill="#1A73FF"/><path d="M12.5 13l5.7-3.3 6.8 3.9A5 5 0 0 1 27.5 18v5a3.5 3.5 0 0 1-3.5 3.5h-1a3.5 3.5 0 0 1-3.5-3.5v-5.8z" fill="${themeName === 'dark' ? '#0B2A7A' : '#7FB0FF'}"/></svg>
</g>
</svg>
`;
}

function howItWorks(themeName) {
  const t = THEMES[themeName];
  const steps = [
    { id: 'radar', icon: P.radar.glyph, color: P.radar.accent, title: 'Discover', sub: 'Sensor finds every device' },
    { id: 'watch', icon: P.watch.glyph, color: P.watch.accent, title: 'Watch', sub: 'Checks, events, incidents' },
    { id: 'alert', icon: BELL, color: '#D13438', title: 'Alert', sub: 'Email, webhooks, chat apps' },
    { id: 'act', icon: P.guard.glyph, color: P.fleet.accent, title: 'Act', sub: 'Router, switch, DNS, Fleet' },
  ];
  const W = 1200, step = 300;
  const items = steps.map((s, i) => {
    const cx = 150 + i * step;
    const sc = 26 / 24;
    return `<g class="step" style="animation-delay:${i}s">
<circle class="ring" style="animation-delay:${i}s" cx="${cx}" cy="70" r="34" fill="none" stroke="${s.color}" stroke-width="2"/>
<circle cx="${cx}" cy="70" r="34" fill="${s.color}"/>
<path d="${s.icon}" transform="translate(${(cx - 13).toFixed(1)} 57) scale(${sc.toFixed(4)})" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
<text x="${cx}" y="134" text-anchor="middle" font-size="19" font-weight="700" fill="${t.ink}">${i + 1}. ${s.title}</text>
<text x="${cx}" y="158" text-anchor="middle" font-size="14" fill="${t.muted}">${s.sub}</text>
</g>`;
  }).join('');
  const arrows = [0, 1, 2].map((i) => {
    const x1 = 150 + i * step + 46, x2 = 150 + (i + 1) * step - 46;
    return `<line x1="${x1}" y1="70" x2="${x2}" y2="70" stroke="${t.line}" stroke-width="2" stroke-dasharray="4 6"/><path d="M${x2 - 8} 64L${x2} 70L${x2 - 8} 76" fill="none" stroke="${t.line}" stroke-width="2" stroke-linecap="round"/><circle class="dot" style="animation-delay:${i}s" cx="${x1}" cy="70" r="5" fill="#1A73FF"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 180" width="${W}" height="180" role="img" aria-labelledby="t d">
<title id="t">How Nigafiy works</title>
<desc id="d">Four steps: discover devices, watch them, alert on changes, act on the network or the computer.</desc>
<style>
text{font-family:${FONT}}
.step{animation:hi 4s ease-in-out infinite;opacity:.55}
.ring{transform-box:fill-box;transform-origin:center;animation:ring 4s ease-out infinite;opacity:0}
.dot{animation:move 4s ease-in-out infinite;opacity:0}
@keyframes hi{0%,30%{opacity:1}45%,100%{opacity:.55}}
@keyframes ring{0%{transform:scale(1);opacity:.7}30%{transform:scale(1.5);opacity:0}100%{opacity:0}}
@keyframes move{0%{transform:translateX(0);opacity:0}5%{opacity:1}25%{transform:translateX(${step - 92 - 10}px);opacity:1}30%,100%{transform:translateX(${step - 92 - 10}px);opacity:0}}
@media (prefers-reduced-motion: reduce){.step,.ring,.dot{animation:none!important}.step{opacity:1}}
</style>
${arrows}
${items}
</svg>
`;
}

function divider(themeName) {
  const t = THEMES[themeName];
  const colors = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'].map((id) => P[id].accent);
  const stops = colors.map((c, i) => `<stop offset="${(i / (colors.length - 1)).toFixed(3)}" stop-color="${c}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 20" width="1200" height="20" role="img" aria-label="Section divider">
<defs><linearGradient id="g" x1="0" x2="1">${stops}</linearGradient>
<linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".15" stop-color="#fff" stop-opacity="1"/><stop offset=".85" stop-color="#fff" stop-opacity="1"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<mask id="m"><rect width="1200" height="20" fill="url(#fade)"/></mask></defs>
<style>.spark{animation:run 6s ease-in-out infinite}@keyframes run{0%{transform:translateX(0)}50%{transform:translateX(1080px)}100%{transform:translateX(0)}}@media (prefers-reduced-motion: reduce){.spark{animation:none!important}}</style>
<g mask="url(#m)"><rect x="0" y="9" width="1200" height="2" rx="1" fill="url(#g)" opacity="${themeName === 'dark' ? 0.9 : 0.75}"/>
<circle class="spark" cx="60" cy="10" r="4" fill="${t.ink}" opacity="0.85"/></g>
</svg>
`;
}

const files = {
  'hero.svg': hero('light'),
  'hero-dark.svg': hero('dark'),
  'how-it-works.svg': howItWorks('light'),
  'how-it-works-dark.svg': howItWorks('dark'),
  'divider.svg': divider('light'),
  'divider-dark.svg': divider('dark'),
};
for (const [name, body] of Object.entries(files)) {
  writeFileSync(path.join(out, name), body);
  console.log(name, Buffer.byteLength(body), 'bytes');
}
