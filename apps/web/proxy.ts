import { legacyRedirect } from '@lan-detective/shared-types/routes';
import { type NextRequest, NextResponse } from 'next/server';
import { buildContentSecurityPolicy } from './lib/csp';

/**
 * Per-request Content-Security-Policy with a fresh script nonce.
 * Next.js reads the nonce from the request's CSP header and stamps it on its own scripts; the root
 * layout reads `x-nonce` for the theme boot script. Every page is already dynamic (the root layout
 * reads the locale cookie), so a per-request nonce costs nothing extra.
 */
export function proxy(request: NextRequest) {
  // Milestone 4 URL scheme: every pre-namespace URL, every program root and every device-action URL
  // answers a permanent redirect from the one shared table (query string kept), before any CSP work.
  const moved = legacyRedirect(request.nextUrl.pathname);
  if (moved) {
    const url = request.nextUrl.clone();
    url.pathname = moved.path;
    for (const [k, v] of Object.entries(moved.query ?? {})) url.searchParams.set(k, v);
    return NextResponse.redirect(url, 308);
  }

  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const csp = buildContentSecurityPolicy(nonce, process.env.NODE_ENV === 'development');

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  matcher: [
    {
      // /api is proxied to the API service (JSON, its own headers); static assets need no policy.
      source: '/((?!api|_next/static|_next/image|favicon.ico).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
