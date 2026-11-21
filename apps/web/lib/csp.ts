/**
 * The Content-Security-Policy for every page.
 *
 * - Scripts: only this origin's bundles plus scripts carrying the per-request nonce
 *   ('strict-dynamic' lets those load their own chunks). No inline handlers, no eval in production.
 * - Styles: 'unsafe-inline' stays because server-rendered `style="…"` attributes (charts, topology,
 *   progress bars) are blocked by a nonce-only policy, and styles cannot run code.
 * - Images: data: for remote-desktop frames, blob: for exports and downloads.
 * - Connections: same origin only (the /api proxy, the event stream, dev HMR).
 * - No upgrade-insecure-requests: the desktop app and LAN installs are served over plain http on
 *   loopback or the local network, and upgrading would break every same-origin request.
 */
export function buildContentSecurityPolicy(nonce: string, isDev: boolean): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? ' ws: wss:' : ''}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join('; ');
}
