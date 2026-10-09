import path from 'node:path';
import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV === 'development';

/**
 * Content-Security-Policy without nonces (see the Next.js CSP guide): pages stay statically optimisable.
 * Only Google Fonts is loaded from outside; the browser talks to this origin alone (AI, Meta, Google and
 * Chat360 calls all go through the server). Images allow data:/blob: (logos, avatars) and https: (Page pictures).
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  ...(isDev ? [] : ['upgrade-insecure-requests']),
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self)' },
];

const nextConfig: NextConfig = {
  // Local escape hatch: NEXT_DIST_DIR=.next-local builds elsewhere when .next is locked (e.g. by antivirus). Unset = .next.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  // Next's development badge sits bottom-left by default, on top of the sidebar's profile button.
  devIndicators: { position: 'bottom-right' },
  // The repository root holds the original Vite app (with its own lockfile): pin the workspace to next-app/.
  turbopack: { root: path.resolve(__dirname) },
  // The MongoDB driver and its optional native deps must stay server-side and unbundled.
  serverExternalPackages: ['mongodb', 'mongodb-memory-server', 'bcryptjs', 'nodemailer'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
  // Each CRM screen is its own route under app/(crm)/; `/` opens the dashboard (the query, e.g. ?lead=…, is kept).
  async redirects() {
    return [{ source: '/', destination: '/dashboard', permanent: false }];
  },
};

export default nextConfig;
