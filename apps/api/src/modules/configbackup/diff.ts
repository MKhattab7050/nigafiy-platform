/**
 * Line diff of two configuration texts (Myers' O((N+M)·D) algorithm on the lines between the common
 * prefix and suffix), grouped into unified-diff hunks with context lines.
 *
 * Bounded: past MAX_EDIT_DISTANCE line edits (a different device, a re-imaged switch…) the middle is
 * reported as one replaced block and `approximate` is set, instead of spending seconds and memory.
 */

export const MAX_EDIT_DISTANCE = 3000;
/** Lines returned in hunks; a diff beyond this is cut and `truncated` is set (the stats stay exact). */
export const MAX_DIFF_LINES = 20_000;

export type DiffOp = ' ' | '-' | '+';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the old / new text (absent for an added / removed line). */
  old?: number;
  new?: number;
}

export interface DiffHunk {
  old_start: number;
  old_lines: number;
  new_start: number;
  new_lines: number;
  lines: DiffLine[];
}

export interface LineDiff {
  identical: boolean;
  added: number;
  removed: number;
  approximate: boolean;
  truncated: boolean;
  hunks: DiffHunk[];
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

interface Edit {
  op: DiffOp;
  a: number; // index in old (for ' ' and '-')
  b: number; // index in new (for ' ' and '+')
}

/** Edit script between a[lo..] and b[lo..] (indices relative to the slices), or null past the limit. */
function myers(a: Int32Array, b: Int32Array, maxD: number): Edit[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (found >= 0) break;
  }
  if (found < 0) return null;

  const edits: Edit[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d - 1]!; // k ∈ [-(d-1), d-1] stored at index k + (d-1)
    const at = (k: number) => prev[k + d - 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      edits.push({ op: ' ', a: x - 1, b: y - 1 });
      x--;
      y--;
    }
    if (x === prevX) edits.push({ op: '+', a: x, b: y - 1 });
    else edits.push({ op: '-', a: x - 1, b: y });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    edits.push({ op: ' ', a: x - 1, b: y - 1 });
    x--;
    y--;
  }
  return edits.reverse();
}

function editScript(oldLines: string[], newLines: string[]): { edits: Edit[]; approximate: boolean } {
  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;
  let suf = 0;
  while (suf < oldLines.length - pre && suf < newLines.length - pre && oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]) suf++;

  const ids = new Map<string, number>();
  const id = (l: string) => {
    let v = ids.get(l);
    if (v === undefined) {
      v = ids.size;
      ids.set(l, v);
    }
    return v;
  };
  const a = Int32Array.from(oldLines.slice(pre, oldLines.length - suf), id);
  const b = Int32Array.from(newLines.slice(pre, newLines.length - suf), id);

  const edits: Edit[] = [];
  for (let i = 0; i < pre; i++) edits.push({ op: ' ', a: i, b: i });
  let middle = myers(a, b, MAX_EDIT_DISTANCE);
  const approximate = middle === null;
  if (!middle) {
    middle = [];
    for (let i = 0; i < a.length; i++) middle.push({ op: '-', a: i, b: 0 });
    for (let j = 0; j < b.length; j++) middle.push({ op: '+', a: a.length, b: j });
  }
  for (const e of middle) edits.push({ op: e.op, a: e.a + pre, b: e.b + pre });
  for (let i = 0; i < suf; i++) edits.push({ op: ' ', a: oldLines.length - suf + i, b: newLines.length - suf + i });
  return { edits, approximate };
}

export function diffLines(oldText: string, newText: string, context = 3): LineDiff {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const { edits, approximate } = editScript(oldLines, newLines);
  let added = 0;
  let removed = 0;
  for (const e of edits) {
    if (e.op === '+') added++;
    else if (e.op === '-') removed++;
  }
  const result: LineDiff = { identical: added === 0 && removed === 0, added, removed, approximate, truncated: false, hunks: [] };
  if (result.identical) return result;

  // Hunks: each change with `context` unchanged lines around it; nearby changes share a hunk.
  const changed = edits.map((e, i) => (e.op !== ' ' ? i : -1)).filter((i) => i >= 0);
  let emitted = 0;
  let i = 0;
  while (i < changed.length) {
    const start = Math.max(0, changed[i]! - context);
    let end = Math.min(edits.length - 1, changed[i]! + context);
    let j = i + 1;
    while (j < changed.length && changed[j]! - context <= end + 1) {
      end = Math.min(edits.length - 1, changed[j]! + context);
      j++;
    }
    const lines: DiffLine[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let k = start; k <= end; k++) {
      const e = edits[k]!;
      if (e.op === ' ') {
        lines.push({ op: ' ', text: oldLines[e.a]!, old: e.a + 1, new: e.b + 1 });
        oldCount++;
        newCount++;
      } else if (e.op === '-') {
        lines.push({ op: '-', text: oldLines[e.a]!, old: e.a + 1 });
        oldCount++;
      } else {
        lines.push({ op: '+', text: newLines[e.b]!, new: e.b + 1 });
        newCount++;
      }
    }
    const first = edits[start]!;
    // Unified-diff convention: a side with no lines in the hunk starts at the line before it.
    result.hunks.push({
      old_start: oldCount ? first.a + 1 : first.a,
      old_lines: oldCount,
      new_start: newCount ? first.b + 1 : first.b,
      new_lines: newCount,
      lines,
    });
    emitted += lines.length;
    if (emitted >= MAX_DIFF_LINES) {
      result.truncated = j < changed.length;
      break;
    }
    i = j;
  }
  return result;
}

/** The diff as unified-diff text (what `diff -u` prints), for download. */
export function unifiedText(diff: LineDiff, oldName: string, newName: string): string {
  const out = [`--- ${oldName}`, `+++ ${newName}`];
  for (const h of diff.hunks) {
    out.push(`@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@`);
    for (const l of h.lines) out.push(`${l.op}${l.text}`);
  }
  return `${out.join('\n')}\n`;
}
