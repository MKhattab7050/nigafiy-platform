// Generates the README artwork (docs/assets/readme/*.svg) from the brand files and tokens.
//
//   node scripts/make-readme-art.mjs
//
// Every figure is written in a light and a dark variant (README <picture> swaps them), and the ones
// with words also in Arabic (`-ar`, laid out right to left). Motion is CSS keyframes inside the SVG,
// slow and looping, and switched off under prefers-reduced-motion. No fonts, scripts or external
// references: text uses the system font stack, so each file renders the same in GitHub's <img>.
// The program cards (docs/assets/readme/programs/) are static: one equal-size card per program.
// docs/assets/readme/social-preview.svg is the source of social-preview.png (1280×640), rendered by
// `node scripts/capture-readme-screenshots.mjs --social`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs/assets/readme');
mkdirSync(out, { recursive: true });

// ── Brand ────────────────────────────────────────────────────────────────────────────────────────
// Values copied from packages/brand/src/tokens.ts (checked below, so a drift fails loudly).
const tokens = readFileSync(path.join(root, 'packages/brand/src/tokens.ts'), 'utf8');
const P = {
  hub: { accent: '#1466E6', glyph: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z', name: 'Hub' },
  radar: { accent: '#0099BC', glyph: 'M12 12m-8 0a8 8 0 1 0 16 0a8 8 0 1 0-16 0M12 12m-3.5 0a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0-7 0M12 12l5.5-5.5', name: 'Radar' },
  watch: { accent: '#C27C0E', glyph: 'M3 12h4l2-5 4 10 2-5h6', name: 'Watch' },
  guard: { accent: '#D13438', glyph: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z', name: 'Guard' },
  fleet: { accent: '#7A4FD6', glyph: 'M3 5h12v9H3zM6 18h6M9 14v4M17 8h4v9h-6', name: 'Fleet' },
  mind: { accent: '#C239B3', glyph: 'M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M18 6l-2.5 2.5M8.5 15.5L6 18', name: 'Mind' },
  toolbox: { accent: '#2E8540', glyph: 'M14.5 5.5a4 4 0 0 0-5 5l-6 6 2 2 6-6a4 4 0 0 0 5-5l-2.5 2.5-2-2z', name: 'Toolbox' },
  agent: { accent: '#4B5563', glyph: 'M4 5h16v11H4zM9 20h6M12 16v4M9 10l2 2 4-4', name: 'Agent' },
  sensor: { accent: '#3D6E7A', glyph: 'M12 18v3M8 21h8M12 14m-2 0a2 2 0 1 0 4 0a2 2 0 1 0-4 0M8.5 10.5a5 5 0 0 1 7 0M5.5 7.5a9 9 0 0 1 13 0', name: 'Sensor' },
};
for (const [id, p] of Object.entries(P)) {
  if (!tokens.includes(p.accent) || !tokens.includes(p.glyph)) throw new Error(`brand token drift for ${id}`);
}
const MARK = {
  blue: 'M5 9.2a4 4 0 0 1 6-3.5l14 8A5 5 0 0 1 27.5 18v5a3.5 3.5 0 0 1-3.5 3.5h-1a3.5 3.5 0 0 1-3.5-3.5v-5.8L12.5 13v10a3.5 3.5 0 0 1-3.5 3.5h-.5A3.5 3.5 0 0 1 5 23z',
  navy: 'M12.5 13l5.7-3.3 6.8 3.9A5 5 0 0 1 27.5 18v5a3.5 3.5 0 0 1-3.5 3.5h-1a3.5 3.5 0 0 1-3.5-3.5v-5.8z',
};
if (!tokens.includes(MARK.blue) || !tokens.includes(MARK.navy)) throw new Error('brand token drift for the mark');
const BLUE = '#1A73FF';
const NAVY = '#0B2A7A';
const OK = '#2E8540';
const WARN = '#C27C0E';
const CRIT = '#D13438';

// 24×24 stroke glyphs (stroke #fff, round caps) for things that are not programs.
const G = {
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  db: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  browser: 'M3 5h18v14H3zM3 9h18M6 7h.01M9 7h.01',
  monitor: 'M3 4h18v12H3zM8 20h8M12 16v4',
  engine: 'M7 7h10v10H7zM10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4',
  network: 'M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  key: 'M14.5 9.5m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M11.6 12.4L4 20M7 17l2 2M5 19l1.5 1.5',
  user: 'M12 8m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M4 21a8 8 0 0 1 16 0',
  list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  shieldCheck: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4',
  play: 'M3 5h18v14H3zM10 9l5 3-5 3z',
  zap: 'M13 3L5 14h6l-1 7 8-11h-6z',
};

// ── Themes and type ──────────────────────────────────────────────────────────────────────────────
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', 'Noto Sans Arabic', Tahoma, Helvetica, Arial, sans-serif";
const MONO = "ui-monospace, SFMono-Regular, 'Cascadia Mono', Consolas, 'Liberation Mono', monospace";
const THEMES = {
  light: {
    bg1: '#FFFFFF', bg2: '#F2F6FD', panelStroke: '#E1E7F2', dot: '#C9D5EC',
    card: '#FFFFFF', cardStroke: '#DCE3F0', sunken: '#F4F7FC', ink: '#0B1F5C', body: '#33415F', muted: '#64708F',
    line: '#AFBEDA', zoneStroke: '#B9C7E2', zoneFill: '#F7F9FE', engineFill: '#EEF4FF', engineStroke: '#A9C4F5',
    accent: BLUE, shadow: '#0B1F5C', shadowOp: 0.09, markGround: '#FFFFFF', markShade: NAVY, chipText: '#0B1F5C',
  },
  dark: {
    bg1: '#0F1830', bg2: '#0A1122', panelStroke: '#1E2A45', dot: '#22325A',
    card: '#131D36', cardStroke: '#26365C', sunken: '#0E1630', ink: '#EEF3FF', body: '#C3CDE5', muted: '#8E9BBD',
    line: '#3D5285', zoneStroke: '#34477A', zoneFill: '#0D1529', engineFill: '#112042', engineStroke: '#2F4E95',
    accent: '#4C8DFF', shadow: '#000000', shadowOp: 0.4, markGround: '#0B1F5C', markShade: '#7FB0FF', chipText: '#EEF3FF',
  },
};

/** The colour halfway between the two panel stops: label pills use it to sit quietly on the panel. */
function mix(a, b) {
  const h = (c, i) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  return `#${[0, 1, 2].map((i) => Math.round((h(a, i) + h(b, i)) / 2).toString(16).padStart(2, '0')).join('')}`;
}
for (const t of Object.values(THEMES)) t.mid = mix(t.bg1, t.bg2);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const f1 = (n) => +n.toFixed(1);

/** Text. In RTL the inline direction flips, so `start` anchors at the right-hand x. */
function T(x, y, str, o = {}) {
  const a = [`x="${f1(x)}"`, `y="${f1(y)}"`];
  if (o.anchor && o.anchor !== 'start') a.push(`text-anchor="${o.anchor}"`);
  a.push(`font-size="${o.size ?? 15}"`);
  if (o.weight) a.push(`font-weight="${o.weight}"`);
  a.push(`fill="${o.fill}"`);
  if (o.mono) a.push(`font-family="${MONO}"`);
  if (o.ls) a.push(`letter-spacing="${o.ls}"`);
  if (o.rtl) a.push('direction="rtl"');
  if (o.cls) a.push(`class="${o.cls}"`);
  if (o.op) a.push(`opacity="${o.op}"`);
  return `<text ${a.join(' ')}>${esc(str)}</text>`;
}

function glyphPath(d, cx, cy, size, stroke = '#fff', sw = 2) {
  const s = size / 24;
  return `<path d="${d}" transform="translate(${f1(cx - 12 * s)} ${f1(cy - 12 * s)}) scale(${+s.toFixed(4)})" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

/** A rounded icon tile in a program accent, with a soft top light. */
function tile(glyph, color, x, y, s = 40) {
  const r = Math.round(s * 0.26);
  return `<g><rect x="${f1(x)}" y="${f1(y)}" width="${s}" height="${s}" rx="${r}" fill="${color}"/><rect x="${f1(x)}" y="${f1(y)}" width="${s}" height="${s}" rx="${r}" fill="url(#tileLight)"/>${glyphPath(glyph, x + s / 2, y + s / 2, s * 0.55)}</g>`;
}

/** Rounded orthogonal path through points. */
function route(pts, r = 14) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const l1 = Math.hypot(x1 - x0, y1 - y0);
    const l2 = Math.hypot(x2 - x1, y2 - y1);
    const rr = Math.min(r, l1 / 2, l2 / 2);
    const ax = x1 - ((x1 - x0) / l1) * rr;
    const ay = y1 - ((y1 - y0) / l1) * rr;
    const bx = x1 + ((x2 - x1) / l2) * rr;
    const by = y1 + ((y2 - y1) / l2) * rr;
    d += `L${f1(ax)} ${f1(ay)}Q${x1} ${y1} ${f1(bx)} ${f1(by)}`;
  }
  const last = pts[pts.length - 1];
  return `${d}L${last[0]} ${last[1]}`;
}

/** A connection: the line, an arrowhead at the end, and an optional travelling packet. */
function link(d, t, o = {}) {
  const color = o.color ?? t.line;
  const parts = [`<path d="${d}" fill="none" stroke="${color}" stroke-width="${o.width ?? 1.6}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''} stroke-linecap="round" stroke-linejoin="round"${o.arrow === false ? '' : ` marker-end="url(#${o.marker ?? 'arrow'})"`}/>`];
  if (o.packet) {
    const pc = o.packetColor ?? t.accent;
    const style = `animation-duration:${o.dur ?? 3.2}s;animation-delay:${o.delay ?? 0}s`;
    parts.push(`<path class="pk glow" style="${style}" d="${d}" pathLength="100" fill="none" stroke="${pc}" stroke-width="7" stroke-linecap="round" stroke-dasharray="7 300" stroke-dashoffset="8" opacity=".22"/>`);
    parts.push(`<path class="pk" style="${style}" d="${d}" pathLength="100" fill="none" stroke="${pc}" stroke-width="3" stroke-linecap="round" stroke-dasharray="7 300" stroke-dashoffset="8"/>`);
  }
  return parts.join('');
}

/** Shared <defs> and base CSS for every figure. */
function defs(t, extraCss = '', extraDefs = '') {
  return `<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${t.bg1}"/><stop offset="1" stop-color="${t.bg2}"/></linearGradient>
<linearGradient id="tileLight" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>
<pattern id="dots" width="22" height="22" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1.1" fill="${t.dot}"/></pattern>
<filter id="sh" x="-10%" y="-20%" width="120%" height="150%"><feDropShadow dx="0" dy="3" stdDeviation="5" flood-color="${t.shadow}" flood-opacity="${t.shadowOp}"/></filter>
<marker id="arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1.5 1.5L8.5 5L1.5 8.5" fill="none" stroke="${t.line}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="arrowA" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1.5 1.5L8.5 5L1.5 8.5" fill="none" stroke="${t.accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="arrowP" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1.5 1.5L8.5 5L1.5 8.5" fill="none" stroke="${P.fleet.accent}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>
<marker id="arrowR" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1.5 1.5L8.5 5L1.5 8.5" fill="none" stroke="${CRIT}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></marker>
${extraDefs}
<style>
text{font-family:${FONT}}
.pk{animation-name:pk;animation-iteration-count:infinite;animation-timing-function:cubic-bezier(.45,0,.4,1)}
@keyframes pk{0%{stroke-dashoffset:8}62%,100%{stroke-dashoffset:-101}}
${extraCss}
@media (prefers-reduced-motion: reduce){*{animation:none!important}.pk{display:none}.rm-show{opacity:1!important}}
</style>
</defs>`;
}

/** The figure: rounded panel with a faint dot grid, title and description for screen readers. */
function figure(W, H, t, { title, desc, lang = 'en', css = '', extraDefs = '', dots = true }, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d"${lang === 'ar' ? ' xml:lang="ar"' : ''}>
<title id="t">${esc(title)}</title>
<desc id="d">${esc(desc)}</desc>
${defs(t, css, extraDefs)}
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="20" fill="url(#bg)" stroke="${t.panelStroke}"/>
${dots ? `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="20" fill="url(#dots)" opacity=".55"/>` : ''}
${body}
</svg>
`;
}

/**
 * A component card: icon tile on top, title, one or two muted lines, an optional port pill.
 * In RTL everything inside the card is mirrored (tile and text on the right).
 */
function card(t, { x, y, w, h, glyph, color, title, lines = [], port, rtl = false, cls = '' }) {
  const pad = 16;
  const tx = rtl ? x + w - pad : x + pad;
  const tileX = rtl ? x + w - pad - 36 : x + pad;
  const portEl = port
    ? (() => {
        const pw = port.length * 7.6 + 14;
        const px = rtl ? x + pad : x + w - pad - pw;
        return `<rect x="${f1(px)}" y="${y + pad + 6}" width="${f1(pw)}" height="22" rx="11" fill="${t.sunken}" stroke="${t.cardStroke}"/>${T(px + pw / 2, y + pad + 21.5, port, { anchor: 'middle', size: 12.5, fill: t.muted, mono: true })}`;
      })()
    : '';
  const text = [T(tx, y + 76, title, { size: 16, weight: 700, fill: t.ink, rtl }), ...lines.map((l, i) => T(tx, y + 97 + i * 19, l, { size: 13.5, fill: t.muted, rtl }))].join('');
  return `<g${cls ? ` class="${cls}"` : ''}><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${t.card}" stroke="${t.cardStroke}" filter="url(#sh)"/>${tile(glyph, color, tileX, y + pad, 36)}${portEl}${text}</g>`;
}

/** A dashed boundary with a small caps tab label sitting on its top edge. */
function zone(t, { x, y, w, h, label, rtl = false, dashed = true, fill, stroke, labelColor }) {
  const lw = label.length * (rtl ? 6.6 : 7.4) + 22;
  const lx = rtl ? x + w - 18 - lw : x + 18;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${fill ?? t.zoneFill}" fill-opacity=".7" stroke="${stroke ?? t.zoneStroke}" stroke-width="1.3"${dashed ? ' stroke-dasharray="5 5"' : ''}/>
<rect x="${f1(lx)}" y="${y - 11}" width="${f1(lw)}" height="22" rx="11" fill="${t.bg1}" stroke="${stroke ?? t.zoneStroke}"/>${T(lx + lw / 2, y + 4.5, label, { anchor: 'middle', size: 11.5, weight: 700, fill: labelColor ?? t.muted, ls: rtl ? 0 : 1.1, rtl })}`;
}

/** A small label on a line, on a pill of the panel colour so it reads over lines. */
function tag(t, x, y, str, { anchor = 'middle', rtl = false, color, size = 12.5, bg } = {}) {
  const w = str.length * (size * (rtl ? 0.5 : 0.56)) + 14;
  const rx = anchor === 'middle' ? x - w / 2 : (anchor === 'start') !== rtl ? x - 7 : x - w + 7;
  return `<rect x="${f1(rx)}" y="${y - 13}" width="${f1(w)}" height="20" rx="10" fill="${bg ?? t.mid}" opacity=".96"/>${T(anchor === 'middle' ? x : x, y + 1, str, { anchor, size, fill: color ?? t.muted, weight: 600, rtl })}`;
}

// ── Hero ─────────────────────────────────────────────────────────────────────────────────────────
const HERO_TEXT = {
  en: {
    line1: 'Know your network.',
    line2: 'Understand every incident.',
    sub1: 'Seven programs on one local engine: discover, monitor,',
    sub2: 'protect and support. Windows-first, English and Arabic.',
    tags: { erp: 'ERP web · down', fresh: 'New device', sw: 'core-switch' },
    title: 'Nigafiy',
    desc: 'Nigafiy: know your network, understand every incident. A radar sweeps a network; devices light up as it passes, one is down and one is new.',
  },
  ar: {
    line1: 'اعرف شبكتك.',
    line2: 'وافهم كل عطل.',
    sub1: 'سبعة برامج على محرك محلي واحد: اكتشاف ومراقبة',
    sub2: 'وحماية ودعم. مبني لنظام Windows، بالعربية والإنجليزية.',
    tags: { erp: 'ERP · متوقف', fresh: 'جهاز جديد', sw: 'core-switch' },
    title: 'Nigafiy',
    desc: 'Nigafiy: اعرف شبكتك وافهم كل عطل. رادار يمسح الشبكة وتضيء الأجهزة عند مروره؛ جهاز متوقف وجهاز جديد.',
  },
};

function logoInner(file) {
  const svg = readFileSync(path.join(root, 'packages/brand/svg', file), 'utf8');
  const m = svg.match(/^<svg[^>]*viewBox="([^"]+)"[^>]*>(.*)<\/svg>\s*$/s);
  if (!m) throw new Error('unexpected logo file');
  return { viewBox: m[1], body: m[2].replace(/<title>.*?<\/title>/, '') };
}

function markSvg(x, y, s, shade) {
  return `<svg x="${f1(x)}" y="${f1(y)}" width="${s}" height="${s}" viewBox="0 0 32 32"><path d="${MARK.blue}" fill="${BLUE}"/><path d="${MARK.navy}" fill="${shade}"/></svg>`;
}

function hero(themeName, lang) {
  const t = THEMES[themeName];
  const L = HERO_TEXT[lang];
  const rtl = lang === 'ar';
  const W = 1200;
  const H = 440;
  const mx = (x) => (rtl ? W - x : x);
  const logo = logoInner(themeName === 'dark' ? 'logo-light.svg' : 'logo.svg');
  const logoW = 250;
  const logoH = (logoW * 110.99) / 486.86;
  const cx = mx(930);
  const cy = 220;
  const R = 164;
  const T_SWEEP = 9;

  // Left column (right column in Arabic).
  const tx = mx(72);
  const logoX = rtl ? W - 72 - logoW : 72;
  const textCol = [
    `<svg x="${logoX}" y="58" width="${logoW}" height="${f1(logoH)}" viewBox="${logo.viewBox}">${logo.body}</svg>`,
    T(tx, 178, L.line1, { size: rtl ? 44 : 42, weight: 700, fill: t.ink, ls: rtl ? 0 : -0.8, rtl }),
    T(tx, 230, L.line2, { size: rtl ? 44 : 42, weight: 700, fill: 'url(#headGrad)', ls: rtl ? 0 : -0.8, rtl }),
    T(tx, 274, L.sub1, { size: 17.5, fill: t.body, rtl }),
    T(tx, 300, L.sub2, { size: 17.5, fill: t.body, rtl }),
  ].join('\n');

  // Program chips. Label widths measured in the browser (Segoe UI 14 px, weight 600) so the padding
  // is even; a name not listed falls back to an estimate.
  const LABEL_W = { Hub: 26.9, Radar: 37, Watch: 40, Guard: 38.7, Fleet: 30.6, Mind: 33.2, Toolbox: 50.3 };
  const CH = { h: 32, y: 336, padL: 12, dot: 4.5, gap: 8, padR: 14, space: 9 };
  let cxp = 72;
  const chips = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox']
    .map((id) => {
      const tw = LABEL_W[P[id].name] ?? P[id].name.length * 8.4;
      const w = CH.padL + CH.dot * 2 + CH.gap + tw + CH.padR;
      const x0 = rtl ? W - cxp - w : cxp;
      const dotX = rtl ? x0 + w - CH.padL - CH.dot : x0 + CH.padL + CH.dot;
      const labelX = rtl ? x0 + CH.padR + tw / 2 : x0 + CH.padL + CH.dot * 2 + CH.gap + tw / 2;
      const midY = CH.y + CH.h / 2;
      cxp += w + CH.space;
      return `<g><rect x="${f1(x0)}" y="${CH.y}" width="${f1(w)}" height="${CH.h}" rx="${CH.h / 2}" fill="${t.card}" stroke="${t.cardStroke}"/><circle cx="${f1(dotX)}" cy="${midY}" r="${CH.dot}" fill="${P[id].accent}"/>${T(labelX, midY + 5, P[id].name, { anchor: 'middle', size: 14, weight: 600, fill: t.chipText })}</g>`;
    })
    .join('');

  // Radar: rings, ticks, a sweep with a fading tail, devices that flare as the sweep passes them.
  const rings = [0.36, 0.68, 1].map((k, i) => `<circle cx="${cx}" cy="${cy}" r="${f1(R * k)}" fill="none" stroke="${t.line}" stroke-opacity="${i === 2 ? 0.9 : 0.55}" stroke-width="${i === 2 ? 1.4 : 1}"${i === 2 ? '' : ' stroke-dasharray="2 5"'}/>`).join('');
  const ticks = Array.from({ length: 72 }, (_, i) => {
    const a = (i * 5 * Math.PI) / 180;
    const r1 = R + 6;
    const r2 = R + (i % 6 === 0 ? 14 : 10);
    return `<line x1="${f1(cx + r1 * Math.sin(a))}" y1="${f1(cy - r1 * Math.cos(a))}" x2="${f1(cx + r2 * Math.sin(a))}" y2="${f1(cy - r2 * Math.cos(a))}"/>`;
  }).join('');
  const wedge = (a0, a1, r) => {
    const p = (a) => [f1(cx + r * Math.sin((a * Math.PI) / 180)), f1(cy - r * Math.cos((a * Math.PI) / 180))];
    const [x0, y0] = p(a0);
    const [x1, y1] = p(a1);
    return `M${cx} ${cy}L${x0} ${y0}A${r} ${r} 0 0 1 ${x1} ${y1}Z`;
  };
  const tail = Array.from({ length: 9 }, (_, i) => `<path d="${wedge(-(i + 1) * 7, -i * 7, R)}" fill="${t.accent}" opacity="${(0.2 * (1 - i / 9) ** 1.6).toFixed(3)}"/>`).join('');
  const sweep = `<g class="sweep">${tail}<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - R}" stroke="${t.accent}" stroke-width="2" stroke-linecap="round" opacity=".85"/></g>`;
  // Device positions: angle from north, clockwise in English (the sweep turns the other way in Arabic).
  const devs = [
    { a: 18, r: 0.55, k: 'ok' }, { a: 52, r: 0.86, k: 'ok' }, { a: 78, r: 0.42, k: 'ok', tag: 'sw' },
    { a: 122, r: 0.66, k: 'crit', tag: 'erp' }, { a: 146, r: 0.6, k: 'ok' }, { a: 171, r: 0.9, k: 'ok' },
    { a: 205, r: 0.5, k: 'ok' }, { a: 232, r: 0.82, k: 'new', tag: 'fresh' }, { a: 262, r: 0.32, k: 'ok' },
    { a: 290, r: 0.7, k: 'ok' }, { a: 318, r: 0.9, k: 'ok' }, { a: 342, r: 0.46, k: 'ok' },
  ];
  const kc = { ok: t.accent, crit: CRIT, new: OK };
  const dirSign = rtl ? -1 : 1;
  const blips = devs
    .map((d) => {
      const a = (d.a * Math.PI) / 180;
      const x = f1(cx + dirSign * d.r * R * Math.sin(a));
      const y = f1(cy - d.r * R * Math.cos(a));
      const delay = -(T_SWEEP - (d.a / 360) * T_SWEEP).toFixed(2);
      const c = kc[d.k];
      const core = d.k === 'ok' ? 4 : 5.5;
      return { ...d, x, y, el: `<g><circle class="ping" style="animation-delay:${delay}s" cx="${x}" cy="${y}" r="${core}" fill="none" stroke="${c}" stroke-width="1.6"/><circle class="blip rm-show" style="animation-delay:${delay}s" cx="${x}" cy="${y}" r="${core}" fill="${c}"/>${d.k !== 'ok' ? `<circle cx="${x}" cy="${y}" r="${core + 4}" fill="none" stroke="${c}" stroke-opacity=".35"/>` : ''}</g>` };
    });
  const tags = blips
    .filter((b) => b.tag)
    .map((b) => {
      const label = L.tags[b.tag];
      const c = kc[b.k];
      const w = label.length * 7.3 + 34;
      // Put the tag outward, unless that would leave the panel.
      const right = b.x > cx ? b.x + 16 + w < W - 24 : b.x - 16 - w < 24;
      const x0 = right ? b.x + 16 : b.x - 16 - w;
      const y0 = b.y - 14;
      const tdx = rtl ? x0 + w - 12 : x0 + 12;
      const dotX = rtl ? x0 + w - 12 : x0 + 12;
      return `<g filter="url(#sh)"><rect x="${f1(x0)}" y="${f1(y0)}" width="${f1(w)}" height="28" rx="14" fill="${t.card}" stroke="${t.cardStroke}"/></g><circle cx="${f1(dotX)}" cy="${f1(y0 + 14)}" r="4" fill="${c}"/>${T(rtl ? tdx - 12 : tdx + 12, y0 + 19, label, { size: 13, weight: 600, fill: t.ink, rtl })}<line x1="${f1(right ? b.x + 7 : b.x - 7)}" y1="${b.y}" x2="${f1(right ? x0 : x0 + w)}" y2="${b.y}" stroke="${c}" stroke-opacity=".6"/>`;
    })
    .join('');

  const css = `
.sweep{transform-origin:${cx}px ${cy}px;animation:spin ${T_SWEEP}s linear infinite${rtl ? ' reverse' : ''}}
.blip{animation:blip ${T_SWEEP}s ease-out infinite;opacity:.5}
.ping{transform-box:fill-box;transform-origin:center;animation:ping ${T_SWEEP}s ease-out infinite;opacity:0}
.core{transform-box:fill-box;transform-origin:center;animation:breathe 4.5s ease-in-out infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes blip{0%{opacity:1}55%,100%{opacity:.42}}
@keyframes ping{0%{transform:scale(1);opacity:.85}22%{transform:scale(4.2);opacity:0}100%{opacity:0}}
@keyframes breathe{0%,100%{transform:scale(1);opacity:.14}50%{transform:scale(1.25);opacity:.3}}`;
  const extraDefs = `<linearGradient id="headGrad" x1="${rtl ? 1 : 0}" y1="0" x2="${rtl ? 0 : 1}" y2="0"><stop offset="0" stop-color="${BLUE}"/><stop offset="1" stop-color="${themeName === 'dark' ? '#3FC8E4' : P.radar.accent}"/></linearGradient>
<radialGradient id="scope" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${t.accent}" stop-opacity="${themeName === 'dark' ? 0.16 : 0.09}"/><stop offset="1" stop-color="${t.accent}" stop-opacity="0"/></radialGradient>
<radialGradient id="fadeDots" cx="${rtl ? 0.21 : 0.79}" cy="0.5" r="0.45"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<mask id="dotMask"><rect width="${W}" height="${H}" fill="url(#fadeDots)"/></mask>`;
  const body = `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="20" fill="url(#dots)" mask="url(#dotMask)"/>
${textCol}
${chips}
<circle cx="${cx}" cy="${cy}" r="${R + 40}" fill="url(#scope)"/>
<circle cx="${cx}" cy="${cy}" r="${R}" fill="${t.card}" fill-opacity="${themeName === 'dark' ? 0.35 : 0.6}"/>
${rings}
<g stroke="${t.line}" stroke-width="1" stroke-opacity=".7">${ticks}</g>
<g stroke="${t.line}" stroke-opacity=".35"><line x1="${cx - R}" y1="${cy}" x2="${cx + R}" y2="${cy}"/><line x1="${cx}" y1="${cy - R}" x2="${cx}" y2="${cy + R}"/></g>
${sweep}
${blips.map((b) => b.el).join('')}
${tags}
<circle class="core" cx="${cx}" cy="${cy}" r="40" fill="${t.accent}" opacity=".18"/>
<circle cx="${cx}" cy="${cy}" r="30" fill="${t.markGround}" stroke="${t.cardStroke}" filter="url(#sh)"/>
${markSvg(cx - 18, cy - 18, 36, t.markShade)}`;
  return figure(W, H, t, { title: L.title, desc: L.desc, lang, css, extraDefs, dots: false }, body);
}

// ── How it works ─────────────────────────────────────────────────────────────────────────────────
const HOW_TEXT = {
  en: {
    title: 'How Nigafiy works',
    desc: 'Four steps: discover every device, watch it and explain incidents with evidence, alert the right people, act on the router, switch, DNS or computer.',
    steps: [
      { t: 'Discover', d: ['The Sensor finds and', 'names every device'] },
      { t: 'Watch', d: ['Checks turn evidence', 'into clear incidents'] },
      { t: 'Alert', d: ['Email, chat apps and', 'signed webhooks'] },
      { t: 'Act', d: ['Fix it from Guard or', 'Fleet, every step audited'] },
    ],
    w: { devices: '21 devices', fresh: '2 new', refused: 'refused', read: 'read back', dns: 'DNS block' },
  },
  ar: {
    title: 'طريقة عمل Nigafiy',
    desc: 'أربع خطوات: اكتشاف كل جهاز، ومراقبته وشرح الأعطال بالأدلة، وتنبيه الأشخاص المعنيين، والتصرف على الراوتر أو السويتش أو DNS أو الحاسوب.',
    steps: [
      { t: 'الاكتشاف', d: ['الـ Sensor يجد كل جهاز', 'ويتعرّف عليه'] },
      { t: 'المراقبة', d: ['الفحوص تحوّل الأدلة', 'إلى حوادث واضحة'] },
      { t: 'التنبيه', d: ['البريد وتطبيقات الدردشة', 'وWebhooks موقّعة'] },
      { t: 'التصرف', d: ['أصلِح من Guard أو Fleet', 'وكل خطوة مسجّلة'] },
    ],
    w: { devices: '21 جهازاً', fresh: '2 جديد', refused: 'مرفوض', read: 'تم التحقق', dns: 'حظر DNS' },
  },
};

function howItWorks(themeName, lang) {
  const t = THEMES[themeName];
  const L = HOW_TEXT[lang];
  const rtl = lang === 'ar';
  const W = 1000;
  const H = 288;
  const cw = 208;
  const gap = 40;
  const y = 26;
  const h = 236;
  const PERIOD = 10;
  const step = PERIOD / 4;
  const meta = [
    { glyph: P.radar.glyph, color: P.radar.accent },
    { glyph: P.watch.glyph, color: P.watch.accent },
    { glyph: G.bell, color: CRIT },
    { glyph: G.shieldCheck, color: P.fleet.accent },
  ];
  const xs = [0, 1, 2, 3].map((i) => (rtl ? W - 24 - cw - i * (cw + gap) : 24 + i * (cw + gap)));
  const cards = meta
    .map((m, i) => {
      const x = xs[i];
      const s = L.steps[i];
      const tx = rtl ? x + cw - 20 : x + 20;
      const numX = rtl ? x + 20 : x + cw - 20;
      // A small piece of real-looking UI that shows what the step produces.
      const wy = y + 168;
      const wx = x + 16;
      const ww = cw - 32;
      let widget = `<rect x="${wx}" y="${wy}" width="${ww}" height="48" rx="10" fill="${t.sunken}" stroke="${t.cardStroke}"/>`;
      if (i === 0) {
        const dots = Array.from({ length: 9 }, (_, k) => {
          const dx = rtl ? wx + ww - 16 - k * 14 : wx + 16 + k * 14;
          const isNew = k >= 7;
          return `<rect x="${dx - 4.5}" y="${wy + 10}" width="9" height="9" rx="2.5" fill="${isNew ? OK : t.accent}" opacity="${isNew ? 1 : 0.55}"${isNew ? ` class="newdev" style="animation-delay:${(k - 7) * 0.3}s"` : ''}/>`;
        }).join('');
        widget += `${dots}${T(rtl ? wx + ww - 12 : wx + 12, wy + 39, L.w.devices, { size: 13, weight: 600, fill: t.ink, rtl })}${T(rtl ? wx + 12 : wx + ww - 12, wy + 39, L.w.fresh, { anchor: 'end', size: 12.5, weight: 700, fill: OK, rtl })}`;
      } else if (i === 1) {
        const pts = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.78, 0.86, 1].map((k, j) => [wx + 12 + k * (ww - 84), wy + 30 - [4, 7, 5, 9, 6, 8, 5, 7, 6, 4, 6][j] * 1.2]);
        const sp = pts.map((p, j) => `${j ? 'L' : 'M'}${f1(rtl ? 2 * wx + ww - p[0] : p[0])} ${f1(p[1])}`).join('');
        const endX = rtl ? wx + 12 + 0 : wx + ww - 12;
        const lastX = rtl ? 2 * wx + ww - pts[10][0] : pts[10][0];
        widget += `<path d="${sp}" fill="none" stroke="${P.watch.accent}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/><circle cx="${f1(lastX)}" cy="${f1(pts[10][1])}" r="4.5" fill="${CRIT}" class="alarm"/>${T(endX, wy + 30, L.w.refused, { anchor: rtl ? 'start' : 'end', size: 12, weight: 700, fill: CRIT })}`;
      } else if (i === 2) {
        const labels = ['Email', 'Slack', 'ntfy'];
        let px = rtl ? wx + ww - 10 : wx + 10;
        widget += labels
          .map((lb) => {
            const pw = lb.length * 6.8 + 16;
            const x0 = rtl ? px - pw : px;
            px = rtl ? px - pw - 8 : px + pw + 8;
            return `<rect x="${f1(x0)}" y="${wy + 12}" width="${f1(pw)}" height="24" rx="12" fill="${t.card}" stroke="${t.cardStroke}"/>${T(x0 + pw / 2, wy + 28.5, lb, { anchor: 'middle', size: 12.5, weight: 600, fill: t.body })}`;
          })
          .join('');
      } else {
        const pillW = rtl ? 82 : 86;
        const pillX = rtl ? wx + 10 : wx + ww - 10 - pillW;
        widget += `${T(rtl ? wx + ww - 12 : wx + 12, wy + 29, L.w.dns, { size: 13, weight: 700, fill: t.ink, rtl })}<rect x="${pillX}" y="${wy + 12}" width="${pillW}" height="24" rx="12" fill="${OK}" fill-opacity=".14" stroke="${OK}" stroke-opacity=".5"/>${glyphPath(G.check, rtl ? pillX + pillW - 14 : pillX + 14, wy + 24, 13, OK, 3)}${T(rtl ? pillX + pillW - 26 : pillX + 26, wy + 28.5, L.w.read, { size: 12, weight: 700, fill: OK, rtl })}`;
      }
      return `<g>
<rect x="${x}" y="${y}" width="${cw}" height="${h}" rx="16" fill="${t.card}" stroke="${t.cardStroke}" filter="url(#sh)"/>
<rect class="hl" style="animation-delay:${(i * step).toFixed(2)}s" x="${x}" y="${y}" width="${cw}" height="${h}" rx="16" fill="none" stroke="${m.color}" stroke-width="2"/>
${tile(m.glyph, m.color, rtl ? x + cw - 20 - 44 : x + 20, y + 20, 44)}
${T(numX, y + 47, `0${i + 1}`, { anchor: 'end', size: 15, weight: 700, fill: t.muted, mono: true, ls: 1, rtl })}
${T(tx, y + 98, s.t, { size: 21, weight: 700, fill: t.ink, rtl })}
${T(tx, y + 125, s.d[0], { size: 14.5, fill: t.body, rtl })}
${T(tx, y + 146, s.d[1], { size: 14.5, fill: t.body, rtl })}
${widget}
</g>`;
    })
    .join('\n');
  const conns = [0, 1, 2]
    .map((i) => {
      const yy = y + 42;
      const x1 = rtl ? xs[i] - 8 : xs[i] + cw + 8;
      const x2 = rtl ? xs[i + 1] + cw + 8 : xs[i + 1] - 8;
      return link(`M${x1} ${yy}H${x2}`, t, { packet: true, packetColor: meta[i + 1].color, dur: PERIOD, delay: f1((i + 1) * step - 0.75 - PERIOD) });
    })
    .join('');
  const css = `
.hl{animation:hl ${PERIOD}s ease-in-out infinite;opacity:0}
@keyframes hl{0%{opacity:0}4%,22%{opacity:1}30%,100%{opacity:0}}
.pk{animation-name:pk4}
@keyframes pk4{0%{stroke-dashoffset:8}7.5%,100%{stroke-dashoffset:-101}}
.alarm{animation:alarm 2.4s ease-in-out infinite}
@keyframes alarm{0%,100%{opacity:1}50%{opacity:.35}}
.newdev{animation:alarm 3s ease-in-out infinite}`;
  return figure(W, H, t, { title: L.title, desc: L.desc, lang, css }, `${conns}\n${cards}`);
}

// ── Architecture ─────────────────────────────────────────────────────────────────────────────────
const ARCH_TEXT = {
  en: {
    title: 'Nigafiy architecture',
    desc: "Everything runs on the admin's Windows PC on loopback: the engine supervises PostgreSQL, the API, the web console and the local Sensor. Sensors at other sites and Agents on managed computers and phones dial out to the API over HTTPS; the Sensor reaches the LAN with ICMP, ARP, SNMP, SSH and router APIs.",
    pc: "ADMIN'S WINDOWS PC · LOOPBACK ONLY",
    engine: 'nigafiy-engine',
    engineSub: 'supervises every process · Windows service · control API',
    desktop: ['Desktop app', 'Electron', 'program windows'],
    web: ['Web console', 'Next.js · React', 'English + العربية'],
    api: ['API', 'Node · Express', 'Zod · jobs'],
    db: ['PostgreSQL', 'Row Level Security', 'per organization'],
    sensor: ['Local Sensor', 'discovery · checks', 'router drivers'],
    remote: ['Sensor', 'at another site'],
    lan: ['Your network', 'devices · routers'],
    agent: ['Agent', 'Windows · Linux', 'macOS · Android'],
    zOther: 'OTHER SITE',
    zLan: 'LAN',
    zManaged: 'MANAGED COMPUTERS',
    l: { open: 'opens', api: '/api', sql: 'SQL', out: 'outbound HTTPS', ws: 'HTTPS + WebSocket', probe: 'ICMP · ARP · SNMP · SSH', loop: 'loopback' },
    legend: 'LEGEND',
    lg: ['connection, arrow = who dials', 'live traffic', 'boundary'],
  },
  ar: {
    title: 'بنية Nigafiy',
    desc: 'كل شيء يعمل على حاسوب المسؤول بنظام Windows على عنوان loopback: المحرك يشرف على PostgreSQL والـ API ولوحة الويب والـ Sensor المحلي. الـ Sensor في المواقع الأخرى والـ Agent على الأجهزة المُدارة يتصلون للخارج بالـ API عبر HTTPS.',
    pc: 'حاسوب المسؤول (Windows) · loopback فقط',
    engine: 'nigafiy-engine',
    engineSub: 'يشرف على كل العمليات · خدمة Windows · واجهة تحكم',
    desktop: ['تطبيق سطح المكتب', 'Electron', 'نوافذ البرامج'],
    web: ['لوحة الويب', 'Next.js · React', 'العربية + English'],
    api: ['API', 'Node · Express', 'Zod · مهام'],
    db: ['PostgreSQL', 'أمان على مستوى الصف', 'لكل جهة'],
    sensor: ['Sensor المحلي', 'اكتشاف · فحوص', 'تعريفات الراوترات'],
    remote: ['Sensor', 'في موقع آخر'],
    lan: ['شبكتك', 'أجهزة · راوترات'],
    agent: ['Agent', 'Windows · Linux', 'macOS · Android'],
    zOther: 'موقع آخر',
    zLan: 'الشبكة المحلية',
    zManaged: 'الأجهزة المُدارة',
    l: { open: 'يفتح', api: '/api', sql: 'SQL', out: 'HTTPS للخارج', ws: 'HTTPS + WebSocket', probe: 'ICMP · ARP · SNMP · SSH', loop: 'loopback' },
    legend: 'مفتاح الرسم',
    lg: ['اتصال، السهم = من يبدأ', 'حركة مباشرة', 'حدود'],
  },
};

function architecture(themeName, lang) {
  const t = THEMES[themeName];
  const L = ARCH_TEXT[lang];
  const rtl = lang === 'ar';
  const W = 1000;
  const H = 760;
  const cw = 192;
  const ch = 132;
  const r1 = 150; // row 1 top
  const r2 = 338; // row 2 top
  const xW = 260;
  const xA = 504;
  const xD = 748;
  const apiC = xA + cw / 2;
  const bottomY = 588;
  const bw = 192;
  const bh = 132;
  const xR = 268;
  const xL = 504;
  const xG = 740;

  const c = (o) => card(t, { ...o, rtl });
  const body = [];
  body.push(zone(t, { x: 16, y: 44, w: 968, h: 456, label: L.pc, rtl }));
  // Engine container.
  body.push(`<rect x="240" y="74" width="720" height="410" rx="16" fill="${t.engineFill}" fill-opacity=".75" stroke="${t.engineStroke}" stroke-width="1.3"/>`);
  const eX = rtl ? 940 - 28 : 260;
  body.push(tile(G.engine, NAVY, eX, 92, 28));
  body.push(T(rtl ? eX - 10 : eX + 38, 111, L.engine, { size: 15, weight: 700, fill: t.ink, mono: true, rtl }));
  body.push(T(rtl ? eX - 150 : eX + 168, 111, L.engineSub, { size: 13, fill: t.muted, rtl }));
  body.push(T(rtl ? 260 : 940, 111, ':47140', { size: 12.5, fill: t.muted, mono: true, anchor: rtl ? 'start' : 'end' }));

  // Links first so cards sit on top of them.
  const yMid = r1 + ch / 2;
  const between = (r2 + r1 + ch) / 2; // horizontal lane between the rows
  const links = [];
  links.push(link(`M216 ${yMid}H${xW - 4}`, t, { packet: true, dur: 4.2, delay: -1 }));
  links.push(link(`M${xW + cw + 4} ${yMid}H${xA - 4}`, t, { packet: true, dur: 3.4, delay: -0.4 }));
  links.push(link(`M${xA + cw + 4} ${yMid}H${xD - 4}`, t, { packet: true, dur: 3.4, delay: -2.1 }));
  links.push(link(`M${apiC} ${r2 - 4}V${r1 + ch + 4}`, t, { packet: true, dur: 3, delay: -1.6, packetColor: P.sensor.accent }));
  links.push(link(route([[xR + bw / 2, bottomY - 4], [xR + bw / 2, between], [apiC - 40, between], [apiC - 40, r1 + ch + 4]]), t, { packet: true, dur: 4.6, delay: -0.3, packetColor: P.sensor.accent }));
  links.push(link(route([[xG + bw / 2, bottomY - 4], [xG + bw / 2, between], [apiC + 40, between], [apiC + 40, r1 + ch + 4]]), t, { packet: true, dur: 4.6, delay: -2.6, packetColor: P.fleet.accent }));
  links.push(link(`M${apiC} ${r2 + 124 + 4}V${bottomY - 4}`, t, { packet: true, dur: 3.6, delay: -0.8, packetColor: P.radar.accent }));
  body.push(links.join(''));
  body.push(tag(t, 238, yMid - 14, L.l.open, { bg: t.zoneFill }));
  body.push(tag(t, (xW + cw + xA) / 2, yMid - 14, L.l.api, { bg: t.engineFill }));
  body.push(tag(t, (xA + cw + xD) / 2, yMid - 14, L.l.sql, { bg: t.engineFill }));
  body.push(tag(t, xR + bw / 2, 530, L.l.out, { rtl }));
  body.push(tag(t, xG + bw / 2, 530, L.l.ws, { rtl }));
  body.push(tag(t, apiC, 530, L.l.probe, { rtl }));

  body.push(c({ x: 40, y: r1, w: 176, h: ch, glyph: G.monitor, color: P.hub.accent, title: L.desktop[0], lines: L.desktop.slice(1) }));
  body.push(c({ x: xW, y: r1, w: cw, h: ch, glyph: G.browser, color: P.hub.accent, title: L.web[0], lines: L.web.slice(1), port: ':47130' }));
  body.push(c({ x: xA, y: r1, w: cw, h: ch, glyph: G.server, color: BLUE, title: L.api[0], lines: L.api.slice(1), port: ':47100' }));
  body.push(c({ x: xD, y: r1, w: cw, h: ch, glyph: G.db, color: NAVY, title: L.db[0], lines: L.db.slice(1), port: ':47133' }));
  body.push(c({ x: xA, y: r2, w: cw, h: 124, glyph: P.sensor.glyph, color: P.sensor.accent, title: L.sensor[0], lines: L.sensor.slice(1) }));

  // Outside the PC.
  body.push(zone(t, { x: xR - 14, y: bottomY - 22, w: bw + 28, h: bh + 40, label: L.zOther, rtl }));
  body.push(zone(t, { x: xL - 14, y: bottomY - 22, w: bw + 28, h: bh + 40, label: L.zLan, rtl }));
  body.push(zone(t, { x: xG - 14, y: bottomY - 22, w: bw + 28, h: bh + 40, label: L.zManaged, rtl }));
  body.push(c({ x: xR, y: bottomY, w: bw, h: bh, glyph: P.sensor.glyph, color: P.sensor.accent, title: L.remote[0], lines: L.remote.slice(1) }));
  body.push(c({ x: xL, y: bottomY, w: bw, h: bh, glyph: G.network, color: P.radar.accent, title: L.lan[0], lines: L.lan.slice(1) }));
  body.push(c({ x: xG, y: bottomY, w: bw, h: bh, glyph: P.agent.glyph, color: P.fleet.accent, title: L.agent[0], lines: L.agent.slice(1) }));

  // Live dot on the API: the one process everything talks to.
  body.push(`<circle class="live" cx="${rtl ? xA + 24 : xA + cw - 24}" cy="${r1 + ch - 22}" r="4.5" fill="${OK}"/><circle class="liveRing" cx="${rtl ? xA + 24 : xA + cw - 24}" cy="${r1 + ch - 22}" r="4.5" fill="none" stroke="${OK}" stroke-width="1.5"/>`);

  // Legend.
  const lgx = 16;
  const lx = (dx) => (rtl ? lgx + 200 - dx : lgx + dx);
  body.push(`<g>${T(lx(16), 602, L.legend, { size: 11.5, weight: 700, fill: t.muted, ls: rtl ? 0 : 1.1, rtl })}
<path d="M${lx(16)} 630H${lx(52)}" stroke="${t.line}" stroke-width="1.6" marker-end="url(#arrow)"/>${T(lx(64), 634.5, L.lg[0], { size: 12.5, fill: t.body, rtl })}
<path d="M${lx(16)} 660H${lx(52)}" stroke="${t.line}" stroke-width="1.6"/><circle cx="${lx(34)}" cy="660" r="4" fill="${t.accent}"/>${T(lx(64), 664.5, L.lg[1], { size: 12.5, fill: t.body, rtl })}
<rect x="${rtl ? lx(52) : lx(16)}" y="681" width="36" height="16" rx="5" fill="none" stroke="${t.zoneStroke}" stroke-dasharray="4 4"/>${T(lx(64), 693.5, L.lg[2], { size: 12.5, fill: t.body, rtl })}</g>`);

  const css = `
.live{animation:blink 2.4s ease-in-out infinite}
.liveRing{transform-box:fill-box;transform-origin:center;animation:ring 2.4s ease-out infinite;opacity:0}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.55}}
@keyframes ring{0%{transform:scale(1);opacity:.8}70%,100%{transform:scale(3);opacity:0}}`;
  return figure(W, H, t, { title: L.title, desc: L.desc, lang, css }, body.join('\n'));
}

// ── Remote desktop (Fleet) ───────────────────────────────────────────────────────────────────────
const FLEET_TEXT = {
  en: {
    title: 'Fleet remote desktop flow',
    desc: 'A technician starts a session with a reason; the API checks the access policy; the Agent, which only ever dials out, picks up the command; the user consents and a banner stays on screen; frames flow as WebSocket JPEG tiles relayed in memory, or as WebRTC H.264 directly on the LAN for Windows agents; every session is audited and can be recorded.',
    lanes: [['Technician', 'Fleet console, any browser'], ['Nigafiy API', 'policy · relay · audit'], ['Agent', 'on the managed computer']],
    s: [
      'Start session: reason, profile, MFA if asked',
      'Access policy: role · IP · hours · approval',
      'Agent polls out and picks up the command',
      'User consents · banner stays on screen',
      'Screen as WebSocket JPEG tiles, relayed in memory',
      'Or WebRTC H.264, direct on the LAN (Windows)',
      'Audit log · optional recording (server path)',
    ],
  },
  ar: {
    title: 'مسار سطح المكتب البعيد في Fleet',
    desc: 'الفني يبدأ جلسة مع ذكر السبب؛ الـ API يتحقق من سياسة الوصول؛ الـ Agent، الذي يتصل للخارج فقط، يستلم الأمر؛ المستخدم يوافق ويبقى شريط التنبيه ظاهراً؛ الصورة تمر كمربعات JPEG عبر WebSocket في الذاكرة، أو WebRTC H.264 مباشرة على الشبكة المحلية لأجهزة Windows؛ كل جلسة مسجّلة ويمكن تسجيلها.',
    lanes: [['الفني', 'لوحة Fleet في أي متصفح'], ['Nigafiy API', 'سياسة · تمرير · تدقيق'], ['Agent', 'على الجهاز المُدار']],
    s: [
      'بدء الجلسة: السبب والملف والتحقق الثنائي عند الطلب',
      'سياسة الوصول: الدور · IP · الساعات · الموافقة',
      'الـ Agent يتصل للخارج ويستلم الأمر',
      'موافقة المستخدم · شريط تنبيه ظاهر',
      'الشاشة كمربعات JPEG عبر WebSocket في الذاكرة',
      'أو WebRTC H.264 مباشرة على الشبكة (Windows)',
      'سجل تدقيق · تسجيل اختياري (عبر الخادم)',
    ],
  },
};

function fleetFlow(themeName, lang) {
  const t = THEMES[themeName];
  const L = FLEET_TEXT[lang];
  const rtl = lang === 'ar';
  const W = 1000;
  const H = 600;
  const lane = rtl ? [830, 500, 170] : [170, 500, 830];
  const top = 26;
  const head = 84;
  const rowY = (i) => 160 + i * 60;
  const PERIOD = 14;
  const at = (i) => (i * PERIOD) / 7;
  const lc = [P.fleet.accent, BLUE, P.agent.accent];
  const lg = [G.user, G.server, P.agent.glyph];
  const out = [];
  // Lifelines.
  for (const x of lane) out.push(`<line x1="${x}" y1="${top + head}" x2="${x}" y2="${H - 26}" stroke="${t.line}" stroke-width="1.4" stroke-dasharray="3 6"/>`);
  // Lane headers.
  lane.forEach((x, i) => {
    const w = 236;
    const x0 = x - w / 2;
    const tileX = rtl ? x0 + w - 16 - 40 : x0 + 16;
    const tx = rtl ? x0 + w - 68 : x0 + 68;
    out.push(`<g><rect x="${x0}" y="${top}" width="${w}" height="${head - 14}" rx="14" fill="${t.card}" stroke="${t.cardStroke}" filter="url(#sh)"/>${tile(lg[i], lc[i], tileX, top + 15, 40)}${T(tx, top + 32, L.lanes[i][0], { size: 16, weight: 700, fill: t.ink, rtl })}${T(tx, top + 52, L.lanes[i][1], { size: 13, fill: t.muted, rtl })}</g>`);
  });
  const badge = (x, y, n, color) => `<g><circle class="act" style="animation-delay:${at(n - 1).toFixed(2)}s" cx="${x}" cy="${y}" r="15" fill="${color}" opacity="0"/><circle cx="${x}" cy="${y}" r="11" fill="${color}"/>${T(x, y + 4.5, String(n), { anchor: 'middle', size: 12.5, weight: 800, fill: '#fff' })}</g>`;
  const arrowRow = (i, from, to, o = {}) => {
    const y = rowY(i);
    const dir = Math.sign(lane[to] - lane[from]);
    const x1 = lane[from] + dir * 8;
    const x2 = lane[to] - dir * 8;
    const mid = (lane[from] + lane[to]) / 2;
    const color = o.color ?? t.line;
    const marker = o.marker ?? 'arrow';
    let s = link(`M${x1} ${y}H${x2}`, t, { color, marker, width: o.width ?? 1.6, dash: o.dash, packet: true, packetColor: o.packetColor ?? t.accent, dur: PERIOD, delay: f1(at(i) - PERIOD + 0.2) });
    const label = L.s[i];
    const lw = label.length * (rtl ? 6.1 : 7.1) + 44;
    s += `<rect x="${f1(mid - lw / 2)}" y="${y - 33}" width="${f1(lw)}" height="24" rx="12" fill="${t.mid}" opacity=".94"/>`;
    s += badge(rtl ? mid + lw / 2 - 14 : mid - lw / 2 + 14, y - 21, i + 1, o.badge ?? t.accent);
    s += T(rtl ? mid + lw / 2 - 32 : mid - lw / 2 + 32, y - 16, label, { size: 13.5, weight: 600, fill: t.body, rtl });
    return s;
  };
  const noteRow = (i, laneIdx, color, glyph) => {
    const y = rowY(i);
    const label = L.s[i];
    const w = label.length * 7.1 + 70;
    const x0 = Math.max(16, Math.min(W - 16 - w, lane[laneIdx] - w / 2));
    const ix = rtl ? x0 + w - 24 : x0 + 24;
    const tx = rtl ? x0 + w - 70 : x0 + 70;
    return `<g><rect x="${f1(x0)}" y="${y - 30}" width="${f1(w)}" height="40" rx="12" fill="${t.card}" stroke="${t.cardStroke}" filter="url(#sh)"/><rect x="${rtl ? f1(x0 + w - 4) : f1(x0)}" y="${y - 30}" width="4" height="40" rx="2" fill="${color}"/>${badge(rtl ? ix - 22 : ix + 22, y - 10, i + 1, color)}${glyphPath(glyph, ix, y - 10, 17, color, 2.2)}${T(tx, y - 5, label, { size: 13.5, weight: 600, fill: t.ink, rtl })}</g>`;
  };
  out.push(arrowRow(0, 0, 1, { packetColor: P.fleet.accent }));
  out.push(noteRow(1, 1, P.guard.accent, G.shieldCheck));
  out.push(arrowRow(2, 2, 1, { dash: '6 5', packetColor: P.agent.accent, badge: P.agent.accent }));
  out.push(noteRow(3, 2, OK, G.check));
  out.push(arrowRow(4, 2, 0, { color: t.accent, marker: 'arrowA', width: 2.6, packetColor: t.accent }));
  out.push(arrowRow(5, 2, 0, { color: P.fleet.accent, marker: 'arrowP', dash: '2 6', width: 2.2, packetColor: P.fleet.accent, badge: P.fleet.accent }));
  out.push(noteRow(6, 1, P.hub.accent, G.list));
  // A gentle continuous stream on row 5, the picture path.
  const y5 = rowY(4);
  const s1 = lane[2] + (rtl ? 8 : -8);
  const s2 = lane[0] + (rtl ? -8 : 8);
  out.push(`<path class="stream" d="M${s1} ${y5}H${s2}" fill="none" stroke="${t.accent}" stroke-width="2.6" stroke-dasharray="3 14" stroke-linecap="round" opacity=".55"/>`);
  const css = `
.act{animation:act ${PERIOD}s ease-out infinite}
@keyframes act{0%{opacity:0}3%{opacity:.35}12%,100%{opacity:0}}
.pk{animation-name:pk7}
@keyframes pk7{0%{stroke-dashoffset:8}9%,100%{stroke-dashoffset:-101}}
.stream{animation:stream 1.6s linear infinite}
@keyframes stream{to{stroke-dashoffset:${rtl ? 17 : -17}}}`;
  return figure(W, H, t, { title: L.title, desc: L.desc, lang, css }, out.join('\n'));
}

// ── Security ─────────────────────────────────────────────────────────────────────────────────────
const SEC_TEXT = {
  en: {
    title: 'Nigafiy security layers',
    desc: 'Every request passes sign-in, role checks, tenant isolation with PostgreSQL Row Level Security, sealed secrets and an append-only audit log. Sensors and Agents only dial out over HTTPS; the server never connects into a site.',
    req: 'EVERY REQUEST',
    conn: 'EVERY CONNECTION',
    gates: [
      ['Sign-in', 'scrypt passwords', 'TOTP MFA · SSO', 'rate limited'],
      ['Roles', 'owner · admin', 'technician · viewer', 'checked on the server'],
      ['Tenant isolation', 'PostgreSQL RLS', 'per organization', 'composite keys'],
      ['Sealed secrets', 'AES-256-GCM', 'write-only', 'key rotation'],
      ['Audit log', 'append-only', 'actor and reason', 'same transaction'],
    ],
    site: 'SITE NETWORK',
    sensor: ['Sensor', 'observer and prober, no shell'],
    agent: ['Agent', 'closed list of typed actions'],
    api: ['Nigafiy API', 'commands from a closed allow-list', 'every payload checked with Zod', 'per-machine credential, revocable'],
    out: 'Sensors and Agents dial out over HTTPS',
    never: 'The server never connects into a site',
  },
  ar: {
    title: 'طبقات الأمان في Nigafiy',
    desc: 'كل طلب يمر بتسجيل الدخول والتحقق من الدور وعزل الجهات عبر أمان PostgreSQL على مستوى الصف والأسرار المشفّرة وسجل تدقيق لا يُعدَّل. الـ Sensor والـ Agent يتصلون للخارج فقط عبر HTTPS؛ الخادم لا يتصل أبداً بداخل أي موقع.',
    req: 'كل طلب',
    conn: 'كل اتصال',
    gates: [
      ['تسجيل الدخول', 'كلمات مرور scrypt', 'TOTP · SSO', 'حدّ للمحاولات'],
      ['الأدوار', 'مالك · مسؤول', 'فني · مشاهد', 'تُفحص على الخادم'],
      ['عزل الجهات', 'PostgreSQL RLS', 'لكل جهة', 'مفاتيح مركّبة'],
      ['أسرار مشفّرة', 'AES-256-GCM', 'كتابة فقط', 'تدوير المفتاح'],
      ['سجل التدقيق', 'إضافة فقط', 'المنفّذ والسبب', 'في نفس المعاملة'],
    ],
    site: 'شبكة الموقع',
    sensor: ['Sensor', 'يراقب ويفحص، بلا سطر أوامر'],
    agent: ['Agent', 'قائمة مغلقة من الإجراءات'],
    api: ['Nigafiy API', 'أوامر من قائمة مسموحة مغلقة', 'كل طلب يُفحص بـ Zod', 'اعتماد لكل جهاز، قابل للإلغاء'],
    out: 'الـ Sensor والـ Agent يتصلون للخارج عبر HTTPS',
    never: 'الخادم لا يتصل أبداً بداخل الموقع',
  },
};

function security(themeName, lang) {
  const t = THEMES[themeName];
  const L = SEC_TEXT[lang];
  const rtl = lang === 'ar';
  const W = 1000;
  const H = 540;
  const mx = (x, w = 0) => (rtl ? W - x - w : x);
  const out = [];
  const colors = [P.hub.accent, WARN, P.radar.accent, P.fleet.accent, OK];
  const glyphs = [G.user, G.key, G.db, G.lock, G.list];
  const gw = 172;
  const gg = 22;
  const gy = 64;
  const gh = 160;
  out.push(T(mx(26), 44, L.req, { size: 12, weight: 700, fill: t.muted, ls: rtl ? 0 : 1.2, rtl, anchor: 'start' }));
  // A request travels through the gates; it shows only in the gaps between them.
  const pathD = rtl ? `M${W - 16} ${gy + 42}H16` : `M16 ${gy + 42}H${W - 16}`;
  out.push(`<path d="${pathD}" stroke="${t.line}" stroke-width="1.6" stroke-dasharray="2 6" fill="none"/>`);
  out.push(`<path class="pk req" d="${pathD}" pathLength="100" fill="none" stroke="${t.accent}" stroke-width="3" stroke-linecap="round" stroke-dasharray="4 300" stroke-dashoffset="5"/>`);
  L.gates.forEach((g, i) => {
    const x = mx(26 + i * (gw + gg), gw);
    const tx = rtl ? x + gw - 18 : x + 18;
    out.push(`<g><rect x="${x}" y="${gy}" width="${gw}" height="${gh}" rx="14" fill="${t.card}" stroke="${t.cardStroke}" filter="url(#sh)"/>
<rect class="gate" style="animation-delay:${(i * 0.9).toFixed(2)}s" x="${x}" y="${gy}" width="${gw}" height="${gh}" rx="14" fill="none" stroke="${colors[i]}" stroke-width="2" opacity="0"/>
${tile(glyphs[i], colors[i], rtl ? x + gw - 18 - 36 : x + 18, gy + 24, 36)}
${glyphPath(G.check, rtl ? x + 26 : x + gw - 26, gy + 42, 16, OK, 2.6)}
${T(tx, gy + 92, g[0], { size: 16, weight: 700, fill: t.ink, rtl })}
${g.slice(1).map((l, j) => T(tx, gy + 114 + j * 18, l, { size: 13, fill: t.muted, rtl })).join('')}</g>`);
  });

  // Connections: who dials whom.
  const by = 300;
  out.push(T(mx(26), by - 20, L.conn, { size: 12, weight: 700, fill: t.muted, ls: rtl ? 0 : 1.2, rtl }));
  const zx = mx(26, 300);
  out.push(zone(t, { x: zx, y: by, w: 300, h: 212, label: L.site, rtl }));
  const cardH = (x, y, w, glyph, color, title, sub) => {
    const tileX = rtl ? x + w - 16 - 36 : x + 16;
    const tx = rtl ? x + w - 66 : x + 66;
    return `<g><rect x="${x}" y="${y}" width="${w}" height="68" rx="14" fill="${t.card}" stroke="${t.cardStroke}" filter="url(#sh)"/>${tile(glyph, color, tileX, y + 16, 36)}${T(tx, y + 30, title, { size: 15.5, weight: 700, fill: t.ink, rtl })}${T(tx, y + 50, sub, { size: 13, fill: t.muted, rtl })}</g>`;
  };
  const sx = zx + 20;
  out.push(cardH(sx, by + 30, 260, P.sensor.glyph, P.sensor.accent, L.sensor[0], L.sensor[1]));
  out.push(cardH(sx, by + 122, 260, P.agent.glyph, P.fleet.accent, L.agent[0], L.agent[1]));
  const ax = mx(640, 334);
  const ay = by;
  const tileX = rtl ? ax + 334 - 20 - 44 : ax + 20;
  const atx = rtl ? ax + 334 - 76 : ax + 76;
  out.push(`<g><rect x="${ax}" y="${ay}" width="334" height="212" rx="16" fill="${t.card}" stroke="${t.cardStroke}" filter="url(#sh)"/>${tile(G.server, BLUE, tileX, ay + 22, 44)}${T(atx, ay + 42, L.api[0], { size: 17, weight: 700, fill: t.ink, rtl })}${T(atx, ay + 60, 'HTTPS · :47100', { size: 12.5, fill: t.muted, mono: true, anchor: rtl ? 'end' : 'start' })}
${L.api.slice(1).map((l, j) => `${glyphPath(G.check, rtl ? ax + 334 - 30 : ax + 30, ay + 104 + j * 32, 15, OK, 2.6)}${T(rtl ? ax + 334 - 50 : ax + 50, ay + 109 + j * 32, l, { size: 13.5, fill: t.body, rtl })}`).join('')}</g>`);
  // Outbound arrows (site → API) and the refused inbound one.
  const from = rtl ? zx : zx + 300;
  const to = rtl ? ax + 334 : ax;
  const d = rtl ? -1 : 1;
  out.push(link(`M${from - d * 20 + d * 4} ${by + 64}H${to - d * 6}`, t, { color: OK, packet: true, packetColor: OK, dur: 3.2, delay: -0.5, width: 2 }));
  out.push(link(`M${from - d * 20 + d * 4} ${by + 156}H${to - d * 6}`, t, { color: OK, packet: true, packetColor: OK, dur: 3.2, delay: -2.1, width: 2 }));
  const midX = (from + to) / 2;
  out.push(`<path d="M${to - d * 6} ${by + 110}H${from + d * 6}" fill="none" stroke="${CRIT}" stroke-width="1.8" stroke-dasharray="5 5" marker-end="url(#arrowR)" opacity=".8"/>`);
  out.push(`<circle cx="${midX}" cy="${by + 110}" r="13" fill="${t.card}" stroke="${CRIT}" stroke-width="1.8"/><path d="M${midX - 5} ${by + 105}l10 10M${midX + 5} ${by + 105}l-10 10" stroke="${CRIT}" stroke-width="2.4" stroke-linecap="round"/>`);
  out.push(tag(t, midX, by + 36, L.out, { color: OK, size: 12, rtl }));
  out.push(tag(t, midX, by + 138, L.never, { color: CRIT, size: 12, rtl }));
  const css = `
.req{animation:pkr 6s cubic-bezier(.45,0,.4,1) infinite}
@keyframes pkr{0%{stroke-dashoffset:5}80%,100%{stroke-dashoffset:-101}}
.gate{animation:gate 6s ease-in-out infinite}
@keyframes gate{0%,4%{opacity:0}9%{opacity:.9}20%,100%{opacity:0}}`;
  return figure(W, H, t, { title: L.title, desc: L.desc, lang, css }, out.join('\n'));
}

// ── Divider ──────────────────────────────────────────────────────────────────────────────────────
function divider(themeName) {
  const colors = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'].map((id) => P[id].accent);
  const stops = colors.map((c, i) => `<stop offset="${(i / (colors.length - 1)).toFixed(3)}" stop-color="${c}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 16" width="1200" height="16" role="img" aria-label="Section divider">
<defs><linearGradient id="g" x1="0" x2="1">${stops}</linearGradient>
<linearGradient id="fade" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".2" stop-color="#fff"/><stop offset=".8" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity="${themeName === 'dark' ? 0.9 : 1}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<mask id="m"><rect width="1200" height="16" fill="url(#fade)"/></mask></defs>
<style>.shine{animation:run 7s cubic-bezier(.45,0,.4,1) infinite}@keyframes run{0%{transform:translateX(-200px)}60%,100%{transform:translateX(1200px)}}@media (prefers-reduced-motion: reduce){.shine{animation:none!important;display:none}}</style>
<g mask="url(#m)"><rect x="0" y="7" width="1200" height="2" rx="1" fill="url(#g)" opacity="${themeName === 'dark' ? 0.85 : 0.7}"/>
<rect class="shine" x="0" y="6" width="200" height="4" rx="2" fill="url(#shine)" opacity=".7"/></g>
</svg>
`;
}

// ── Social preview (static, 1280×640; rendered to PNG by capture-readme-screenshots.mjs --social) ──
function social() {
  const t = THEMES.dark;
  const W = 1280;
  const H = 640;
  const logo = logoInner('logo-light.svg');
  const cx = 1010;
  const cy = 320;
  const R = 200;
  const ring = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox'];
  const nodes = ring.map((id, i) => {
    const a = ((-90 + (i * 360) / 7) * Math.PI) / 180;
    return { id, x: f1(cx + R * Math.cos(a)), y: f1(cy + R * Math.sin(a)) };
  });
  const spokes = nodes.map((n) => `<line x1="${cx}" y1="${cy}" x2="${n.x}" y2="${n.y}" stroke="${t.line}" stroke-width="1.5"/>`).join('');
  const orbit = `<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${t.line}" stroke-width="1.2" stroke-dasharray="3 7"/><circle cx="${cx}" cy="${cy}" r="${R * 0.55}" fill="none" stroke="${t.line}" stroke-opacity=".6" stroke-dasharray="2 6"/>`;
  const icons = nodes.map((n) => `<g filter="url(#sh)">${tile(P[n.id].glyph, P[n.id].accent, n.x - 32, n.y - 32, 64)}</g>`).join('');
  const body = `<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect width="${W}" height="${H}" fill="url(#dots)" opacity=".5"/>
<circle cx="${cx}" cy="${cy}" r="300" fill="url(#scope)"/>
<svg x="80" y="168" width="290" height="${f1((290 * 110.99) / 486.86)}" viewBox="${logo.viewBox}">${logo.body}</svg>
${T(80, 340, 'Know your network.', { size: 54, weight: 700, fill: t.ink, ls: -1 })}
${T(80, 404, 'Understand every incident.', { size: 54, weight: 700, fill: 'url(#headGrad)', ls: -1 })}
${T(80, 462, 'Network and endpoint management · seven programs, one local engine', { size: 22, fill: t.body })}
${T(80, 496, 'Windows-first · English + العربية · no cloud panel · no AI', { size: 22, fill: t.muted })}
${orbit}${spokes}${icons}
<circle cx="${cx}" cy="${cy}" r="58" fill="${t.markGround}" stroke="${t.cardStroke}" stroke-width="2"/>
${markSvg(cx - 34, cy - 34, 68, t.markShade)}`;
  const extra = `<linearGradient id="headGrad" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${BLUE}"/><stop offset="1" stop-color="#3FC8E4"/></linearGradient>
<radialGradient id="scope" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="${BLUE}" stop-opacity=".22"/><stop offset="1" stop-color="${BLUE}" stop-opacity="0"/></radialGradient>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
${defs(t, '', extra)}
${body}
</svg>
`;
}

// ── Program cards ────────────────────────────────────────────────────────────────────────────────
// One card per program for the README's "Programs" grid (docs/assets/readme/programs/<id>[-ar][-dark].svg).
// Every card has the same size and layout, so the grid lines up whatever the text: the README puts
// three side by side at 33 % width each. Names and jobs follow packages/shared-types/src/programs.ts
// (shortened to one line); Sensor and Agent are the two pieces that run outside the admin's PC.
// The card carries its own transparent margin, so the gaps between cards come from the art, not
// from Markdown whitespace.
const CARD_ORDER = ['hub', 'radar', 'watch', 'guard', 'fleet', 'mind', 'toolbox', 'sensor', 'agent'];
const CARD_TEXT = {
  en: {
    hub: 'Home, sign-in, settings, engine',
    radar: 'See every device on the network',
    watch: 'Monitoring, incidents, root causes',
    guard: 'Protect and control the network',
    fleet: 'Company computers and phones',
    mind: 'Knowledge, playbooks, automation',
    toolbox: 'Ping, DNS, traceroute, subnets',
    sensor: 'Network collector, one per site',
    agent: 'Windows, Linux, macOS, Android',
  },
  ar: {
    hub: 'الرئيسية والدخول والإعدادات والمحرك',
    radar: 'رؤية كل جهاز على الشبكة',
    watch: 'المراقبة وفهم سبب المشكلة',
    guard: 'حماية الشبكة والتحكم بها',
    fleet: 'إدارة أجهزة الشركة ودعمها',
    mind: 'المعرفة وخطط العمل والأتمتة',
    toolbox: 'أدوات شبكة سريعة من الـ Sensor',
    sensor: 'جامع بيانات الشبكة، واحد لكل موقع',
    agent: 'Windows · Linux · macOS · Android',
  },
};
// The program's own description for screen readers (the <title> and <desc> of each card).
const CARD_DESC = {
  en: (name, job) => `Nigafiy ${name}: ${job}.`,
  ar: (name, job) => `Nigafiy ${name}: ${job}.`,
};
// The job line has 252 px. Measured in Chromium (Segoe UI / Segoe UI Arabic, 14 px) the longest is
// 217 px (Mind, English), which leaves room for wider fallback fonts (Helvetica, Noto). Keep new
// wording within these character counts and measure again if a line gets longer.
const CARD_TEXT_MAX = 36;

const ARROW = { ltr: 'M5 12h14M13 6l6 6-6 6', rtl: 'M19 12H5M11 6l-6 6 6 6' };

function programCard(themeName, lang, id) {
  const t = THEMES[themeName];
  const rtl = lang === 'ar';
  const p = P[id];
  const job = CARD_TEXT[lang][id];
  if (job.length > CARD_TEXT_MAX) throw new Error(`card text too long for ${id} (${lang}): ${job}`);
  const W = 300;
  const H = 136;
  // The card inside its transparent margin.
  const x = 6;
  const y = 4;
  const w = W - 12;
  const h = H - 8;
  const pad = 18;
  const ts = 46;
  const tileX = rtl ? x + w - pad - ts : x + pad;
  const tileY = y + 22;
  const tx = rtl ? tileX - 14 : tileX + ts + 14;
  const arrowX = rtl ? x + pad + 12 : x + w - pad - 12;
  const title = CARD_DESC[lang](p.name, job);
  const body = [
    `<clipPath id="c"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14"/></clipPath>`,
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${t.card}" stroke="${t.cardStroke}" filter="url(#sh)"/>`,
    `<rect x="${x}" y="${y}" width="${w}" height="4" fill="${p.accent}" clip-path="url(#c)"/>`,
    tile(p.glyph, p.accent, tileX, tileY, ts),
    T(tx, tileY + 16, 'NIGAFIY', { size: 10.5, weight: 700, fill: t.muted, ls: 1.6, anchor: rtl ? 'end' : 'start' }),
    T(tx, tileY + 41, p.name, { size: 21, weight: 700, fill: t.ink, anchor: rtl ? 'end' : 'start' }),
    `<circle cx="${arrowX}" cy="${tileY + 23}" r="13" fill="${t.sunken}" stroke="${t.cardStroke}"/>`,
    glyphPath(ARROW[rtl ? 'rtl' : 'ltr'], arrowX, tileY + 23, 14, t.muted, 2.4),
    `<line x1="${x + pad}" y1="${y + 84.5}" x2="${x + w - pad}" y2="${y + 84.5}" stroke="${t.cardStroke}"/>`,
    T(rtl ? x + w - pad : x + pad, y + 110, job, { size: 14, fill: t.body, rtl }),
  ].join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t"${rtl ? ' xml:lang="ar"' : ''}>
<title id="t">${esc(title)}</title>
<defs>
<linearGradient id="tileLight" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".55" stop-color="#fff" stop-opacity="0"/></linearGradient>
<filter id="sh" x="-10%" y="-20%" width="120%" height="150%"><feDropShadow dx="0" dy="1.5" stdDeviation="2" flood-color="${t.shadow}" flood-opacity="${themeName === 'dark' ? 0.35 : 0.06}"/></filter>
<style>text{font-family:${FONT}}</style>
</defs>
${body}
</svg>
`;
}

/**
 * The same card for narrow screens (the README picks it with `media="(max-width: 600px)"`): at a
 * third of a phone's width the full card's text is too small to read, so this one shows only the
 * glyph and the name, large, in white on the program accent. Same size as the full card, so the grid
 * does not move; the same file serves light and dark pages and both languages.
 */
function programCardCompact(id) {
  const p = P[id];
  const W = 300;
  const H = 136;
  const x = 6;
  const y = 4;
  const w = W - 12;
  const h = H - 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t">
<title id="t">Nigafiy ${esc(p.name)}</title>
<defs>
<linearGradient id="light" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".2"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></linearGradient>
<style>text{font-family:${FONT}}</style>
</defs>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${p.accent}"/>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="url(#light)"/>
${glyphPath(p.glyph, W / 2, y + 40, 46, '#fff', 2)}
${T(W / 2, y + 108, p.name, { size: 36, weight: 700, fill: '#fff', anchor: 'middle' })}
</svg>
`;
}

// ── Write ────────────────────────────────────────────────────────────────────────────────────────
const files = {};
mkdirSync(path.join(out, 'programs'), { recursive: true });
for (const id of CARD_ORDER) {
  files[`programs/${id}-compact.svg`] = programCardCompact(id);
  for (const theme of ['light', 'dark']) {
    for (const lang of ['en', 'ar']) files[`programs/${id}${lang === 'ar' ? '-ar' : ''}${theme === 'dark' ? '-dark' : ''}.svg`] = programCard(theme, lang, id);
  }
}
for (const theme of ['light', 'dark']) {
  const sfx = theme === 'dark' ? '-dark' : '';
  for (const lang of ['en', 'ar']) {
    const lsfx = lang === 'ar' ? '-ar' : '';
    files[`hero${lsfx}${sfx}.svg`] = hero(theme, lang);
    files[`how-it-works${lsfx}${sfx}.svg`] = howItWorks(theme, lang);
    files[`architecture${lsfx}${sfx}.svg`] = architecture(theme, lang);
    files[`fleet-remote-desktop${lsfx}${sfx}.svg`] = fleetFlow(theme, lang);
    files[`security${lsfx}${sfx}.svg`] = security(theme, lang);
  }
  files[`divider${sfx}.svg`] = divider(theme);
}
files['social-preview.svg'] = social();
for (const [name, body] of Object.entries(files)) {
  writeFileSync(path.join(out, name), body);
  const kb = Buffer.byteLength(body) / 1024;
  if (kb > 60) throw new Error(`${name} is ${kb.toFixed(1)} KB, over the 60 KB budget`);
  console.log(name.padEnd(36), `${kb.toFixed(1)} KB`);
}
