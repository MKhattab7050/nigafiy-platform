// The site's own address, for the sitemap, robots.txt and Open Graph links. The domain is not
// decided yet (docs/website.md): set NIGAFIY_SITE_URL when building for the real host. Without it
// the build uses the local preview address, so nothing points at a domain that does not exist.
export const SITE_URL = (process.env.NIGAFIY_SITE_URL || 'http://127.0.0.1:3290').replace(/\/+$/, '');
