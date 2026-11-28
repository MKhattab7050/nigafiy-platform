// Path helpers of the file manager (pure: unit-tested in sha256.test.ts).

export const isWinPath = (p: string) => p.includes('\\') || /^[A-Za-z]:/.test(p);

export function joinRemote(dir: string, rel: string): string {
  const sep = isWinPath(dir) ? '\\' : '/';
  const r = rel.split('/').filter(Boolean).join(sep);
  return dir.endsWith(sep) ? `${dir}${r}` : `${dir}${sep}${r}`;
}

/** The path of `child` under `root`, with forward slashes. */
export function relPath(root: string, child: string): string {
  const sep = isWinPath(root) ? '\\' : '/';
  const base = root.endsWith(sep) ? root : root + sep;
  const rest = child.startsWith(base) ? child.slice(base.length) : child.split(sep).pop() ?? child;
  return rest.split(sep).join('/');
}

/** Folders of a path, for the breadcrumbs: [{ name, path }] from the root to the folder. */
export function crumbsOf(path: string): { name: string; path: string }[] {
  if (!path) return [];
  const win = path.includes('\\') || /^[A-Za-z]:/.test(path);
  const sep = win ? '\\' : '/';
  const parts = path.split(sep).filter(Boolean);
  const out: { name: string; path: string }[] = [];
  let acc = win ? '' : '/';
  if (!win) out.push({ name: '/', path: '/' });
  for (const p of parts) {
    acc = win ? (acc ? `${acc.replace(/\\$/, '')}\\${p}` : `${p}\\`) : `${acc.replace(/\/$/, '')}/${p}`;
    out.push({ name: p, path: acc });
  }
  return out;
}

