import type { MetadataRoute } from 'next';

/** Web app manifest: "Add to Home Screen" opens the CRM full-screen like an app (needed for phone notifications on iPhone). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'CRM',
    short_name: 'CRM',
    description: 'Sales CRM for real-estate teams',
    id: '/dashboard',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#F2F7FB',
    theme_color: '#0A1F33',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
