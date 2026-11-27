/**
 * The phone's own on-screen keyboard typing on the remote computer. Android keyboards (Gboard,
 * Samsung) do not send usable key events (keyCode 229, words composed and corrected in place), so
 * a hidden text box takes the typing and each change is turned into what changed: characters to
 * type, Backspaces, and Enter. The box starts with a few placeholder characters so a Backspace
 * on "empty" still changes it.
 */

/** Kept at the start of the hidden box; deleting into it means Backspace on the remote computer. */
export const SENTINEL = '    ';

export type TypedStep = { kind: 'text'; text: string } | { kind: 'key'; key: 'Backspace' | 'Enter' };

/** What changed between two values of the hidden box, as steps for the remote computer. */
export function diffTyped(prev: string, next: string): TypedStep[] {
  let common = 0;
  const max = Math.min(prev.length, next.length);
  while (common < max && prev[common] === next[common]) common++;
  const steps: TypedStep[] = [];
  const removed = [...prev.slice(common)].length;
  for (let i = 0; i < removed; i++) steps.push({ kind: 'key', key: 'Backspace' });
  const added = next.slice(common);
  const parts = added.split(/\r\n|\n|\r/);
  parts.forEach((part, i) => {
    if (i > 0) steps.push({ kind: 'key', key: 'Enter' });
    if (part) steps.push({ kind: 'text', text: part });
  });
  return steps;
}

/** Modifier keys held from the extra-keys bar (one-shot: released after the next key). */
export interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
}

export const NO_MODS: Mods = { ctrl: false, alt: false, shift: false, win: false };

export const anyMod = (m: Mods) => m.ctrl || m.alt || m.shift || m.win;

/** A key with the held modifiers, as a key_combo for the agent ("Ctrl", "Alt", "Shift", "Win", then the key). */
export function comboKeys(m: Mods, key: string): string[] {
  const keys: string[] = [];
  if (m.ctrl) keys.push('Ctrl');
  if (m.alt) keys.push('Alt');
  if (m.shift) keys.push('Shift');
  if (m.win) keys.push('Win');
  keys.push(key);
  return keys;
}

/** The input event for one typed step, with any held modifiers. */
export function stepEvent(step: TypedStep, m: Mods): Record<string, unknown>[] {
  if (step.kind === 'key') return anyMod(m) ? [{ kind: 'key_combo', keys: comboKeys(m, step.key) }] : [{ kind: 'key_press', key: step.key }];
  if (!anyMod(m)) return [{ kind: 'text', text: step.text }];
  // Ctrl+C and the like: the first character takes the modifiers, the rest is typed.
  const [first, ...rest] = [...step.text];
  const out: Record<string, unknown>[] = [{ kind: 'key_combo', keys: comboKeys(m, first === ' ' ? 'Space' : first!.toLowerCase()) }];
  if (rest.length) out.push({ kind: 'text', text: rest.join('') });
  return out;
}
