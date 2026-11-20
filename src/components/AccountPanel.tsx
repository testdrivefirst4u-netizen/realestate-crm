'use client';
/**
 * Account panel — a right-side slide-out from the top-bar avatar (Zoho-style): who you are, the company and its plan,
 * help links, what's new, and My Account / Sign out. Replaces the old profile corner in the sidebar footer for quick
 * account access from anywhere.
 */
import React, { useEffect } from 'react';
import Link from 'next/link';
import { BookOpen, ChevronRight, Gift, Headphones, Laptop, LogOut, Mail, MessageSquare, Moon, Rocket, Star, Sun, UserRound, X } from 'lucide-react';
import { Avatar } from './Avatar';
import { useCompany } from '../core/tenant';
import { viewHref } from '../core/views';
import { roleLabel } from '../core/rbac';
import { useUiMode, type UiMode } from '../core/theme';
import type { UserAccount } from '../types/crm';

const MODES: Array<{ id: UiMode; label: string; Icon: typeof Sun }> = [{ id: 'day', label: 'Day', Icon: Sun }, { id: 'night', label: 'Night', Icon: Moon }, { id: 'auto', label: 'Auto', Icon: Laptop }];

const HELP_URL = 'https://broaddcast.com';
const MAIL_TO = 'mailto:support@broaddcast.com';

type Help = { label: string; href: string; icon: React.ComponentType<{ size?: number; className?: string }>; external?: boolean; bg: string; fg: string };
const HELP_TILES: Help[] = [
  { label: 'Chat with us', href: HELP_URL, icon: MessageSquare, external: true, bg: '#E8F0FE', fg: '#1559C0' },
  { label: 'Talk with us', href: 'tel:+914040123456', icon: Headphones, bg: '#E7F6EF', fg: '#0B7A43' },
  { label: 'Write to us', href: MAIL_TO, icon: Mail, bg: '#F3EEFB', fg: '#6D3BBF' },
  { label: 'Resources', href: HELP_URL, icon: BookOpen, external: true, bg: '#FFF4E0', fg: '#B45309' },
];
const TOUR: Help = { label: 'Take a tour', href: HELP_URL, icon: Rocket, external: true, bg: '#FCE8E6', fg: '#D93025' };
const extAttr = (h: Help) => (h.external ? { target: '_blank' as const, rel: 'noopener noreferrer' } : {});

export const AccountPanel: React.FC<{ open: boolean; onClose: () => void; user?: UserAccount | null; onLogout: () => void }> = ({ open, onClose, user, onLogout }) => {
  const company = useCompany();
  const [mode, setMode] = useUiMode();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const planName = (company?.plan || '').replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) || 'Standard';

  return (
    <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Account">
      <div className="absolute inset-0 bg-[#04121F]/40 animate-[crm-fade-in_.2s_ease]" onClick={onClose} />
      <div className="absolute right-0 top-0 flex h-full w-[min(380px,100vw)] flex-col bg-[#F4F7FB] shadow-[0_0_60px_rgba(8,30,51,0.4)] animate-in slide-in-from-right dark:bg-[#0f1821]">
        {/* header */}
        <div className="relative flex-none overflow-hidden bg-gradient-to-br from-[#4F46E5] via-[#4458d8] to-[#2646C6] px-5 pb-6 pt-6 text-white">
          <span aria-hidden className="pointer-events-none absolute -right-10 -top-16 h-44 w-44 rounded-full border-[26px] border-white/10" />
          <span aria-hidden className="pointer-events-none absolute -bottom-20 right-16 h-40 w-40 rounded-full bg-white/5" />
          <button type="button" onClick={onClose} aria-label="Close" className="absolute -left-4 top-5 grid h-9 w-9 place-items-center rounded-full bg-white text-[#44566B] shadow-md hover:bg-[#F2F7FB]"><X size={18} /></button>
          <div className="relative flex items-center gap-3">
            <span className="rounded-full ring-2 ring-white/40"><Avatar user={user} size="lg" /></span>
            <div className="min-w-0">
              <div className="truncate text-[17px] font-bold">{user?.name || 'Guest'}</div>
              {user?.id && <div className="text-[12.5px] text-white/80">User ID: <span className="font-medium">{user.id}</span></div>}
            </div>
          </div>
          <div className="relative mt-3 inline-flex max-w-full items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-3 py-1.5 text-[13px] font-semibold backdrop-blur-sm">
            <span className="truncate">{company?.name || 'Your company'}</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          {/* plan */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-[#E3EDF5] bg-white p-4 shadow-[0_1px_2px_rgba(11,42,68,.05)] dark:border-[#263345] dark:bg-[#151c26]">
            <div className="flex items-center gap-3">
              <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-gradient-to-br from-[#4F7FE8] to-[#1559C0] text-white shadow-[0_4px_10px_-3px_rgba(21,89,192,.5)]"><Star size={18} className="fill-current" /></span>
              <div>
                <div className="text-[14px] font-bold text-[#0B2A44] dark:text-[#e8eef5]">{planName} Edition</div>
                <div className="text-[12px] text-[#5E778C] dark:text-[#aab8c7]">{user ? roleLabel(user.role) : 'Member'} access</div>
              </div>
            </div>
            <Link href={`${viewHref('settings')}?section=company`} onClick={onClose} className="rounded-lg border border-[#C7D8E8] px-3 py-1.5 text-[12.5px] font-semibold text-[#1559C0] hover:bg-[#F2F7FB]">Manage</Link>
          </div>

          {/* appearance mode */}
          <div className="rounded-xl border border-[#E3EDF5] bg-white p-3.5 shadow-[0_1px_2px_rgba(11,42,68,.05)] dark:border-[#263345] dark:bg-[#151c26]">
            <div className="mb-2 text-[11.5px] font-bold uppercase tracking-wide text-[#8296A6]">Mode</div>
            <div className="flex gap-1 rounded-lg bg-[#F2F7FB] p-1 dark:bg-[#0f1821]">
              {MODES.map(({ id, label, Icon }) => (
                <button key={id} type="button" onClick={() => setMode(id)} aria-pressed={mode === id}
                  className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12.5px] font-semibold transition-colors ${mode === id ? 'bg-white text-[#0B2A44] shadow-[0_1px_2px_rgba(11,42,68,.15)] dark:bg-[#263345] dark:text-white' : 'text-[#5E778C] hover:text-[#0B2A44] dark:hover:text-white'}`}>
                  <Icon size={14} />{label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-[11px] text-[#8296A6]">Dark mode is rolling out — some screens are still light for now.</p>
          </div>

          {/* help */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[13.5px] font-bold text-[#0B2A44] dark:text-[#e8eef5]">Need help?</h3>
              <a href={HELP_URL} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full bg-[#E8F0FE] px-2.5 py-1 text-[11.5px] font-bold text-[#1559C0] dark:bg-[#1a2440] dark:text-[#9db4ff]">24×7 support</a>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {HELP_TILES.map((h) => (
                <a key={h.label} href={h.href} {...extAttr(h)} className="flex flex-col gap-2 rounded-xl border border-[#E3EDF5] bg-white p-3 text-[12.5px] font-semibold text-[#0B2A44] transition hover:-translate-y-0.5 hover:border-[#B9D9F2] hover:shadow-[0_8px_18px_-12px_rgba(11,42,68,.35)] dark:border-[#263345] dark:bg-[#151c26] dark:text-[#e8eef5]">
                  <span className="grid h-8 w-8 place-items-center rounded-lg" style={{ background: h.bg, color: h.fg }}><h.icon size={16} /></span>
                  {h.label}
                </a>
              ))}
            </div>
            <a href={TOUR.href} {...extAttr(TOUR)} className="mt-2 flex items-center gap-3 rounded-xl border border-[#E3EDF5] bg-white p-3 font-semibold text-[#0B2A44] transition hover:border-[#B9D9F2] dark:border-[#263345] dark:bg-[#151c26] dark:text-[#e8eef5]">
              <span className="grid h-8 w-8 flex-none place-items-center rounded-lg" style={{ background: TOUR.bg, color: TOUR.fg }}><Rocket size={16} /></span>
              <span className="flex-1 text-[13px]">Take a tour</span>
              <span className="text-[12px] text-[#8296A6]">2 min</span>
              <ChevronRight size={16} className="text-[#B6C6D4]" />
            </a>
          </div>

          {/* news */}
          <div>
            <h3 className="mb-2 text-[13.5px] font-bold text-[#0B2A44] dark:text-[#e8eef5]">News room</h3>
            <a href={HELP_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-xl border border-[#E3EDF5] bg-gradient-to-r from-[#FFF8EE] to-white p-3 text-[13px] font-bold text-[#0B2A44] transition hover:border-[#F3DCA8] dark:border-[#263345] dark:from-[#1f2230] dark:to-[#151c26] dark:text-[#e8eef5]">
              <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-white text-[#D97706] shadow-[0_2px_8px_-2px_rgba(217,119,6,.4)] dark:bg-[#2a2113]"><Gift size={18} /></span>
              <span className="flex-1">What&apos;s new?</span>
              <ChevronRight size={16} className="text-[#D4A85A]" />
            </a>
          </div>
        </div>

        {/* footer */}
        <div className="flex flex-none items-center justify-between border-t border-[#E3EDF5] bg-white px-4 py-3 dark:border-[#263345] dark:bg-[#121a24]">
          <Link href={`${viewHref('settings')}?section=profile`} onClick={onClose} className="inline-flex items-center gap-2 text-[13px] font-semibold text-[#1559C0] hover:underline"><UserRound size={16} /> My Account</Link>
          <button type="button" onClick={() => { onClose(); onLogout(); }} className="inline-flex items-center gap-2 text-[13px] font-semibold text-[#C5221F] hover:underline"><LogOut size={16} /> Sign out</button>
        </div>
      </div>
    </div>
  );
};
