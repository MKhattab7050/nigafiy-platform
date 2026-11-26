import type { MetadataRoute } from 'next';

/**
 * Installable web app (UX review item 11): "Install app" / "Add to Home screen" opens Nigafiy in its own
 * window, and on an iPhone (iOS 16.4+) a home-screen app is the only way to receive push notifications.
 * Icons are rendered from packages/brand/svg/app-icon.svg into public/icons.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/',
    name: 'Nigafiy',
    short_name: 'Nigafiy',
    description: 'Know your network. Understand every incident.',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#0b1016',
    theme_color: '#0b1016',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
