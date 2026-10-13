/**
 * SourceLogo — a small brand mark for a lead's Source (Facebook, Instagram,
 * Website, Google Sheet, …) plus the source text. Matching is by keyword, so
 * custom labels such as "FB Lead Form" or "Sheet – Diwali campaign" still get
 * the right logo; anything unknown falls back to a neutral tag.
 *
 * Brand sources draw their own mark (full colour); the rest use a soft tinted
 * tile with a coloured icon, so the brands stand out in a table.
 */
import React, { useId } from 'react';
import { Footprints, MessagesSquare, PhoneIncoming, Tag, Users } from 'lucide-react';
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

/* ------------------------------ brand marks ------------------------------ */
/* Each mark fills a 24×24 box; gradient ids come from useId so several badges can share a page. */

const FacebookMark: React.FC = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#0866FF" />
    <path fill="#fff" d="M13.6 24v-8.4h2.8l.5-3.3h-3.3v-2.1c0-.9.3-1.6 1.7-1.6h1.7V5.7c-.3 0-1.4-.1-2.5-.1-2.5 0-4.2 1.5-4.2 4.3v2.4H7.5v3.3h2.8V24h3.3z" />
  </svg>
);

const InstagramMark: React.FC = () => {
  const id = useId();
  return (
    <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
      <defs>
        <radialGradient id={id} cx="0.3" cy="1.07" r="1.3">
          <stop offset="0" stopColor="#FFDD55" />
          <stop offset="0.12" stopColor="#FFC93D" />
          <stop offset="0.45" stopColor="#F5368A" />
          <stop offset="0.75" stopColor="#B42CC0" />
          <stop offset="1" stopColor="#5851DB" />
        </radialGradient>
      </defs>
      <rect width="24" height="24" rx="6.5" fill={`url(#${id})`} />
      <rect x="5.2" y="5.2" width="13.6" height="13.6" rx="4" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="3.3" fill="none" stroke="#fff" strokeWidth="1.8" />
      <circle cx="16.2" cy="7.8" r="1.05" fill="#fff" />
    </svg>
  );
};

const WhatsAppMark: React.FC = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <circle cx="12" cy="12" r="12" fill="#25D366" />
    <path fill="none" stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" d="M12 5.2a6.8 6.8 0 0 0-5.9 10.2l-.9 3.4 3.5-.9A6.8 6.8 0 1 0 12 5.2z" />
    <path fill="#fff" d="M9.6 8.6c.2-.2.5-.2.6 0l.7 1.5c.1.2 0 .4-.1.6l-.4.5c.5 1.1 1.4 2 2.5 2.5l.5-.4c.2-.2.4-.2.6-.1l1.5.7c.2.1.3.4.1.6-.3.7-1 1.1-1.7 1-2.6-.4-4.6-2.4-5-5 0-.7.3-1.4.7-1.9z" />
  </svg>
);

const SheetsMark: React.FC = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <path fill="#0F9D58" d="M14.5 1.5H6A2 2 0 0 0 4 3.5v17a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7l-5.5-5.5z" />
    <path fill="#87CEAC" d="M14.5 1.5V7H20z" />
    <path fill="#fff" d="M7.5 10.5h9v7.5h-9zm1.3 1.3v1.8h2.6v-1.8zm3.9 0v1.8h2.5v-1.8zm-3.9 3.1v1.8h2.6v-1.8zm3.9 0v1.8h2.5v-1.8z" fillRule="evenodd" />
  </svg>
);

const GoogleAdsMark: React.FC = () => (
  <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
    <rect width="24" height="24" rx="6.5" fill="#fff" />
    <rect x="10.6" y="3.3" width="5.4" height="16.5" rx="2.7" fill="#4285F4" transform="rotate(-30 13.3 11.55)" />
    <rect x="8" y="3.3" width="5.4" height="16.5" rx="2.7" fill="#FBBC04" transform="rotate(30 10.7 11.55)" />
    <circle cx="6.6" cy="17.6" r="2.7" fill="#34A853" />
  </svg>
);

const MetaMark: React.FC = () => {
  const id = useId();
  return (
    <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="1" y1="0.6" y2="0.4">
          <stop offset="0" stopColor="#0064E1" />
          <stop offset="0.6" stopColor="#0082FB" />
          <stop offset="1" stopColor="#00A1F8" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6.5" fill="#EAF3FF" />
      <path fill="none" stroke={`url(#${id})`} strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round"
        d="M5.3 14.8c0-3.3 1.5-6.3 3.2-6.3 2.3 0 4.6 6.9 6.8 6.9 1.4 0 2.4-1.5 2.4-3.6 0-2.5-1.2-4.3-2.6-4.3-2.2 0-4.2 6.9-6.6 6.9-1.9 0-3.2-.3-3.2.4" />
    </svg>
  );
};

const WebsiteMark: React.FC = () => {
  const id = useId();
  return (
    <svg viewBox="0 0 24 24" className="w-full h-full" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stopColor="#36B3F2" />
          <stop offset="1" stopColor="#0B6BB0" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="6.5" fill={`url(#${id})`} />
      <g fill="none" stroke="#fff" strokeWidth="1.5">
        <circle cx="12" cy="12" r="6.5" />
        <ellipse cx="12" cy="12" rx="2.8" ry="6.5" />
        <path d="M5.8 10h12.4M5.8 14h12.4" />
      </g>
    </svg>
  );
};

/* -------------------------- tinted generic tiles ------------------------- */

const tinted = (bg: string, fg: string, Icon: React.FC<{ size?: number; strokeWidth?: number; color?: string }>) => () => (
  <span className="w-full h-full flex items-center justify-center rounded-[30%]" style={{ background: bg }}>
    <Icon size={13} strokeWidth={2.2} color={fg} />
  </span>
);

const MARKS: Record<Kind, React.FC> = {
  facebook: FacebookMark,
  instagram: InstagramMark,
  whatsapp: WhatsAppMark,
  sheet: SheetsMark,
  google: GoogleAdsMark,
  meta: MetaMark,
  website: WebsiteMark,
  chat360: tinted('#DDF5EF', '#128C7E', MessagesSquare),
  reference: tinted('#EFE8FA', '#7C5CC4', Users),
  walkin: tinted('#FBEFDF', '#B9762A', Footprints),
  call: tinted('#E0F3F1', '#1F8A7E', PhoneIncoming),
  other: tinted('#EAF0F5', '#6B8296', Tag),
};

/** Logo + label. `iconOnly` keeps just the logo (label stays in the tooltip). */
export const SourceLogo: React.FC<{ source: unknown; size?: number; iconOnly?: boolean; className?: string }> = ({ source, size = 20, iconOnly, className }) => {
  const label = String(source ?? '').trim();
  if (!label) return <span className="text-[#7E93A6]">—</span>;
  const kind = sourceKind(label);
  const Mark = MARKS[kind];
  return (
    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap', className)} title={label}>
      <span
        className={cx('inline-flex flex-shrink-0 overflow-hidden', kind === 'google' || kind === 'meta' ? 'rounded-[30%] ring-1 ring-[#D3E3F0]' : 'drop-shadow-[0_1px_1px_rgba(11,42,68,0.15)]')}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        <Mark />
      </span>
      {iconOnly ? <span className="sr-only">{label}</span> : <span className="text-[11px] font-semibold text-[#0B2A44]">{label}</span>}
    </span>
  );
};
