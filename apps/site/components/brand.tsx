import { MARK_PATHS, PROGRAMS_BRAND, type ProgramId } from '@nigafiy/brand';
import { WORDMARK } from '@nigafiy/brand/wordmark';

/** Logo D: the two-tone rounded n and the lowercase wordmark (packages/brand). Mark and wordmark only. */
export function Logo({ size = 30 }: { size?: number }) {
  const [, , w = 344.8, h = 105.7] = WORDMARK.viewBox.split(' ').map(Number);
  const wordH = size * 0.62;
  return (
    <span className="logo">
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <path d={MARK_PATHS.blue} fill="var(--logo-blue)" />
        <path d={MARK_PATHS.navy} fill="var(--logo-navy)" />
      </svg>
      <svg height={wordH} width={(wordH * w) / h} viewBox={WORDMARK.viewBox} aria-hidden="true" focusable="false">
        <path d={WORDMARK.d} fill="var(--wordmark)" />
      </svg>
      <span className="sr-only">Nigafiy</span>
    </span>
  );
}

/** A program glyph in its rounded accent square (the icon family of packages/brand). */
export function ProgramIcon({ id, size = 44 }: { id: ProgramId; size?: number }) {
  const p = PROGRAMS_BRAND[id];
  return (
    <span className="program-icon" style={{ width: size, height: size, borderRadius: size / 4, background: p.accent }} aria-hidden="true">
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d={p.glyph} />
      </svg>
    </span>
  );
}

/** A technical value (version, hash, file name, command) kept left-to-right inside Arabic text. */
export function Ltr({ children, code = false }: { children: React.ReactNode; code?: boolean }) {
  return <bdi dir="ltr">{code ? <code>{children}</code> : children}</bdi>;
}

/** Text with `backticks` (the guide's notation for technical values) shown as left-to-right code. */
export function TickText({ text }: { text: string }) {
  const parts = text.split(/`([^`]*)`/);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string never reorder
          <Ltr key={i} code>
            {p}
          </Ltr>
        ) : (
          p
        ),
      )}
    </>
  );
}
