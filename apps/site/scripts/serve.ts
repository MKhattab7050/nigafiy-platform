// A tiny static file server for the exported site, the way a static host serves it:
// "/x/" → x/index.html, a missing file → 404.html with status 404. Loopback only.
//
//   node scripts/serve.ts [dir=out] [port=3290]
import { createReadStream, existsSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/** The file a URL path maps to inside root, or null (outside root, or nothing there). */
export function resolveFile(root: string, urlPath: string): string | null {
  let p: string;
  try {
    p = decodeURIComponent(urlPath.split('?')[0]!.split('#')[0]!);
  } catch {
    return null;
  }
  const full = path.resolve(root, `.${p}`);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  if (existsSync(full) && statSync(full).isFile()) return full;
  const index = path.join(full, 'index.html');
  if (existsSync(index)) return index;
  return null;
}

export function startServer(dir: string, port: number, host = '127.0.0.1'): Promise<http.Server> {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const url = req.url ?? '/';
    // A directory address without its slash: send the browser to the slash form, as static hosts do.
    const bare = url.split('?')[0]!;
    if (!bare.endsWith('/') && !path.extname(bare) && existsSync(path.join(root, `.${bare}`, 'index.html'))) {
      res.writeHead(308, { Location: `${bare}/` }).end();
      return;
    }
    const file = resolveFile(root, url);
    const status = file ? 200 : 404;
    const send = file ?? path.join(root, '404.html');
    res.writeHead(status, { 'Content-Type': TYPES[path.extname(send)] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end();
    else createReadStream(send).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (import.meta.main) {
  const dir = process.argv[2] ?? 'out';
  const port = Number(process.argv[3] ?? 3290);
  await startServer(dir, port);
  console.log(`[serve] ${path.resolve(dir)} on http://127.0.0.1:${port}/`);
}
