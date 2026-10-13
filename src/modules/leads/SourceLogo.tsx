/**
 * SourceLogo — a small brand badge for a lead's Source (Facebook, Instagram,
 * Website, Google Sheet, …) plus the source text. Matching is by keyword, so
 * custom labels such as "FB Lead Form" or "Sheet – Diwali campaign" still get
 * the right logo; anything unknown falls back to a neutral tag.
 */
import React from 'react';
import { Footprints, Globe, Megaphone, MessageCircle, MessagesSquare, PhoneIncoming, Sheet, Tag, Users } from 'lucide-react';
import { cx } from '../../components/ui';

type Kind = 'facebook' | 'instagram' | 'sheet' | 'website' | 'whatsapp' | 'chat360' | 'google' | 'meta' | 'reference' | 'walkin' | 'call' | 'other';

export function sourceKind(source: string): Kind {
  const s = source.toLowerCase();
  if (/sheet/.test(s)) return 'sheet';
  if (/insta|\big\b/.test(s)) return 'instagram';
  if (/facebook|\bfb\b/.test(s)) return 'facebook';
  if (/meta/.test(s)) return 'meta';
  if (/web|site|portal/.test(s)) return 'website';
  if (/whats\s*app|\bwa\b/.test(s)) return 'whatsapp';
  if (/chat\s*360/.test(s)) return 'chat360';
  if (/google/.test(s)) return 'google';
  if (/refer/.test(s)) return 'reference';
  if (/walk/.test(s)) return 'walkin';
  if (/call|phone/.test(s)) return 'call';
  return 'other';
}

const FacebookGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
    <path d="M13.5 21v-7.5H16l.4-3h-2.9V8.6c0-.9.3-1.5 1.5-1.5h1.5V4.4c-.3 0-1.2-.1-2.2-.1-2.2 0-3.7 1.3-3.7 3.8v2.4H8.1v3h2.5V21h2.9z" />
  </svg>
);

const InstagramGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} aria-hidden="true">
    <rect x="4" y="4" width="16" height="16" rx="4.5" />
    <circle cx="12" cy="12" r="3.6" />
    <circle cx="16.9" cy="7.1" r="0.9" fill="#fff" stroke="none" />
  </svg>
);

const GoogleGlyph: React.FC<{ size: number }> = ({ size }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M21.6 12.2c0-.7-.1-1.3-.2-1.9H12v3.6h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.2z" />
    <path fill="#34A853" d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1-2.6 0-4.8-1.8-5.6-4.1H3.1v2.6A10 10 0 0 0 12 22z" />
    <path fill="#FBBC05" d="M6.4 14c-.2-.6-.3-1.3-.3-2s.1-1.4.3-2V7.4H3.1a10 10 0 0 0 0 9.2L6.4 14z" />
    <path fill="#EA4335" d="M12 5.9c1.5 0 2.8.5 3.8 1.5l2.9-2.9A10 10 0 0 0 3.1 7.4L6.4 10c.8-2.3 3-4.1 5.6-4.1z" />
  </svg>
);

const STYLE: Record<Kind, { bg: string; icon: (size: number) => React.ReactNode }> = {
  facebook: { bg: 'bg-[#1877F2]', icon: (s) => <FacebookGlyph size={s} /> },
  instagram: { bg: 'bg-[linear-gradient(45deg,#F9CE34_0%,#EE2A7B_50%,#6228D7_100%)]', icon: (s) => <InstagramGlyph size={s} /> },
  meta: { bg: 'bg-[#0866FF]', icon: (s) => <Megaphone size={s - 2} className="text-white" /> },
  sheet: { bg: 'bg-[#0F9D58]', icon: (s) => <Sheet size={s - 2} className="text-white" /> },
  website: { bg: 'bg-[#0B6BB0]', icon: (s) => <Globe size={s - 2} className="text-white" /> },
  whatsapp: { bg: 'bg-[#25D366]', icon: (s) => <MessageCircle size={s - 2} className="text-white" /> },
  chat360: { bg: 'bg-[#128C7E]', icon: (s) => <MessagesSquare size={s - 2} className="text-white" /> },
  google: { bg: 'bg-white border border-[#D3E3F0]', icon: (s) => <GoogleGlyph size={s - 2} /> },
  reference: { bg: 'bg-[#8A6BBE]', icon: (s) => <Users size={s - 2} className="text-white" /> },
  walkin: { bg: 'bg-[#B9874A]', icon: (s) => <Footprints size={s - 2} className="text-white" /> },
  call: { bg: 'bg-[#2F8F83]', icon: (s) => <PhoneIncoming size={s - 2} className="text-white" /> },
  other: { bg: 'bg-[#A9BDCD]', icon: (s) => <Tag size={s - 2} className="text-white" /> },
};

/** Logo badge + label. `iconOnly` keeps just the badge (label stays in the tooltip). */
export const SourceLogo: React.FC<{ source: unknown; size?: number; iconOnly?: boolean; className?: string }> = ({ source, size = 20, iconOnly, className }) => {
  const label = String(source ?? '').trim();
  if (!label) return <span className="text-[#7E93A6]">—</span>;
  const style = STYLE[sourceKind(label)];
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap', className)} title={label}>
      <span className={cx('inline-flex flex-shrink-0 items-center justify-center rounded-md', style.bg)} style={{ width: size, height: size }} aria-hidden="true">
        {style.icon(Math.round(size * 0.75))}
      </span>
      {iconOnly ? <span className="sr-only">{label}</span> : <span className="text-[11px] font-medium text-[#0B2A44]">{label}</span>}
    </span>
  );
};
