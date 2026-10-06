import type { Metadata, Viewport } from 'next';
import './globals.css';

const title = 'CRM';
const description = 'Sales CRM for real-estate teams';

export const metadata: Metadata = {
  title,
  description,
  icons: { icon: '/favicon.png' },
  openGraph: { title, description, type: 'website' },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB">
      <head>
        {/* Jost, exactly as the original index.html loaded it (no build-time font download needed). */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Jost:ital,wght@0,100..900;1,100..900&display=swap" rel="stylesheet" />
      </head>
      {/* Browser extensions (e.g. ColorZilla's cz-shortcut-listen) add attributes to <body> before React hydrates. */}
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
