// Drawn mock-ups of the two Windows prompts a person meets when running a setup program that is not
// signed with a certificate Windows already trusts (UX review 2026-11-26, item 16). Simplified
// drawings, not screenshots: no Microsoft logos, only the words a person has to find and press.
// The wording follows Windows 10/11 in English and Arabic; it can differ slightly between versions.
import type { ReactNode } from 'react';
import type { Lang } from '../lib/i18n.ts';

const W = {
  en: {
    ssTitle: 'Windows protected your PC',
    ssBody1: 'Windows stopped an app it does not recognise',
    ssBody2: 'from starting.',
    more: 'More info',
    dontRun: "Don't run",
    app: 'App:',
    publisher: 'Publisher:',
    unknown: 'Unknown publisher',
    runAnyway: 'Run anyway',
    uacTitle: 'User Account Control',
    uacQ1: 'Do you want to allow this app from an',
    uacQ2: 'unknown publisher to make changes to your device?',
    uacFile: 'File origin: Hard drive on this computer',
    yes: 'Yes',
    no: 'No',
  },
  ar: {
    ssTitle: 'حمى Windows جهاز الكمبيوتر',
    ssBody1: 'منع Windows تطبيقًا لا يتعرّف عليه',
    ssBody2: 'من البدء.',
    more: 'مزيد من المعلومات',
    dontRun: 'عدم التشغيل',
    app: 'التطبيق:',
    publisher: 'الناشر:',
    unknown: 'ناشر غير معروف',
    runAnyway: 'تشغيل على أي حال',
    uacTitle: 'التحكم في حساب المستخدم',
    uacQ1: 'هل تريد السماح لهذا التطبيق من ناشر',
    uacQ2: 'غير معروف بإجراء تغييرات على جهازك؟',
    uacFile: 'مصدر الملف: محرك الأقراص الثابتة على هذا الكمبيوتر',
    yes: 'نعم',
    no: 'لا',
  },
} as const;

/** A numbered circle that points at the place to press. */
function Marker({ x, y, n }: { x: number; y: number; n: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={13} fill="#ffb000" stroke="#1b1b1b" strokeWidth={2} />
      <text x={x} y={y + 5} textAnchor="middle" fontSize={15} fontWeight={700} fill="#1b1b1b" direction="ltr">
        {n}
      </text>
    </g>
  );
}

function Frame({ label, children, viewBox }: { label: string; children: ReactNode; viewBox: string }) {
  return (
    <svg viewBox={viewBox} role="img" aria-label={label} style={{ width: '100%', height: 'auto', display: 'block' }} fontFamily="Segoe UI, system-ui, sans-serif">
      {children}
    </svg>
  );
}

/**
 * The SmartScreen window, before and after "More info". `file` is the setup program's name.
 * In Arabic the text is laid out right to left, as Windows does.
 */
export function SmartScreenFigure({ lang, file, label }: { lang: Lang; file: string; label: string }) {
  const t = W[lang];
  const rtl = lang === 'ar';
  // With direction="rtl", SVG measures text-anchor along the text direction: 'start' is the right edge.
  const anchor = 'start';
  const dir = rtl ? 'rtl' : 'ltr';
  // Each panel is 340 wide; text starts 24 from the reading edge.
  const tx = (panel: number) => (rtl ? panel + 316 : panel + 24);
  const panel = (px: number, after: boolean) => (
    <g>
      <rect x={px} y={0} width={340} height={230} rx={6} fill="#0b5cad" />
      <text x={tx(px)} y={44} fontSize={20} fontWeight={600} fill="#fff" textAnchor={anchor} direction={dir}>
        {t.ssTitle}
      </text>
      <text x={tx(px)} y={76} fontSize={13} fill="#e6efff" textAnchor={anchor} direction={dir}>
        {t.ssBody1}
      </text>
      <text x={tx(px)} y={94} fontSize={13} fill="#e6efff" textAnchor={anchor} direction={dir}>
        {t.ssBody2}
      </text>
      {after ? (
        <>
          <text x={tx(px)} y={126} fontSize={13} fill="#fff" textAnchor={anchor} direction={dir}>
            {t.app} <tspan direction="ltr">{file}</tspan>
          </text>
          <text x={tx(px)} y={146} fontSize={13} fill="#fff" textAnchor={anchor} direction={dir}>
            {t.publisher} {t.unknown}
          </text>
          <rect x={rtl ? px + 186 : px + 24} y={180} width={130} height={32} fill="#fff" fillOpacity={0.12} stroke="#fff" />
          <text x={rtl ? px + 251 : px + 89} y={201} fontSize={13} fill="#fff" textAnchor="middle" direction={dir}>
            {t.runAnyway}
          </text>
          <Marker x={rtl ? px + 172 : px + 168} y={196} n={2} />
        </>
      ) : (
        <>
          <text x={tx(px)} y={130} fontSize={13} fill="#fff" textDecoration="underline" textAnchor={anchor} direction={dir}>
            {t.more}
          </text>
          <Marker x={rtl ? px + 316 - 150 : px + 24 + 150} y={125} n={1} />
        </>
      )}
      <rect x={rtl ? px + 24 : px + 186} y={180} width={130} height={32} fill="#fff" />
      <text x={rtl ? px + 89 : px + 251} y={201} fontSize={13} fill="#0b5cad" textAnchor="middle" direction={dir}>
        {t.dontRun}
      </text>
    </g>
  );
  // Reading order: the first window on the reading side.
  return (
    <Frame label={label} viewBox="0 0 720 230">
      {panel(rtl ? 380 : 0, false)}
      {panel(rtl ? 0 : 380, true)}
      <path d={rtl ? 'M372 115 L348 115 M356 107 L348 115 L356 123' : 'M348 115 L372 115 M364 107 L372 115 L364 123'} stroke="currentColor" strokeWidth={2.5} fill="none" />
    </Frame>
  );
}

/** The User Account Control prompt for a program whose publisher Windows cannot confirm. */
export function UacFigure({ lang, file, label }: { lang: Lang; file: string; label: string }) {
  const t = W[lang];
  const rtl = lang === 'ar';
  // With direction="rtl", SVG measures text-anchor along the text direction: 'start' is the right edge.
  const anchor = 'start';
  const dir = rtl ? 'rtl' : 'ltr';
  const tx = rtl ? 396 : 24;
  return (
    <Frame label={label} viewBox="0 0 420 290">
      <rect x={0} y={0} width={420} height={290} rx={6} fill="#f3f3f3" stroke="#c8c8c8" />
      <rect x={0} y={0} width={420} height={40} rx={6} fill="#e8a33d" />
      <rect x={0} y={30} width={420} height={10} fill="#e8a33d" />
      <text x={tx} y={26} fontSize={13} fill="#1b1b1b" textAnchor={anchor} direction={dir}>
        {t.uacTitle}
      </text>
      <text x={tx} y={72} fontSize={15} fontWeight={600} fill="#1b1b1b" textAnchor={anchor} direction={dir}>
        {t.uacQ1}
      </text>
      <text x={tx} y={92} fontSize={15} fontWeight={600} fill="#1b1b1b" textAnchor={anchor} direction={dir}>
        {t.uacQ2}
      </text>
      <text x={tx} y={130} fontSize={14} fill="#1b1b1b" textAnchor={rtl ? 'end' : 'start'} direction="ltr">
        {file}
      </text>
      <text x={tx} y={154} fontSize={12} fill="#444" textAnchor={anchor} direction={dir}>
        {t.publisher} {t.unknown}
      </text>
      <text x={tx} y={174} fontSize={12} fill="#444" textAnchor={anchor} direction={dir}>
        {t.uacFile}
      </text>
      <rect x={rtl ? 214 : 24} y={230} width={182} height={36} fill="#e3e3e3" stroke="#8a8a8a" />
      <text x={rtl ? 305 : 115} y={253} fontSize={14} fill="#1b1b1b" textAnchor="middle" direction={dir}>
        {t.yes}
      </text>
      <rect x={rtl ? 24 : 214} y={230} width={182} height={36} fill="#e3e3e3" stroke="#8a8a8a" />
      <text x={rtl ? 115 : 305} y={253} fontSize={14} fill="#1b1b1b" textAnchor="middle" direction={dir}>
        {t.no}
      </text>
      <Marker x={rtl ? 396 : 24} y={230} n={3} />
    </Frame>
  );
}
