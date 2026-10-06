import path from 'node:path';
import type { NextConfig } from 'next';

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
  { key: 'Permissions-Policy', value: 'camera=(), geolocation=(), microphone=(self)' },
];

const nextConfig: NextConfig = {
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
