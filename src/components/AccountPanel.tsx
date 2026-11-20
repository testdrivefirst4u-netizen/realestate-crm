'use client';
/**
 * Account panel — a right-side slide-out from the top-bar avatar (Zoho-style): who you are, the company and its plan,
 * help links, what's new, and My Account / Sign out. Replaces the old profile corner in the sidebar footer for quick
 * account access from anywhere.
 */
import React, { useEffect } from 'react';
import Link from 'next/link';
import { BookOpen, Gift, Headphones, Laptop, LogOut, Mail, MessageSquare, Moon, Rocket, Star, Sun, UserRound, X } from 'lucide-react';
import { Avatar } from './Avatar';
import { useCompany } from '../core/tenant';
import { viewHref } from '../core/views';
import { roleLabel } from '../core/rbac';
import { useUiMode, type UiMode } from '../core/theme';
import type { UserAccount } from '../types/crm';

const MODES: Array<{ id: UiMode; label: string; Icon: typeof Sun }> = [{ id: 'day', label: 'Day', Icon: Sun }, { id: 'night', label: 'Night', Icon: Moon }, { id: 'auto', label: 'Auto', Icon: Laptop }];

const HELP_URL = 'https://broaddcast.com';
const MAIL_TO = 'mailto:support@broaddcast.com';

const HELP_LINKS: Array<{ label: string; href: string; icon: React.ComponentType<{ size?: number; className?: string }>; external?: boolean }> = [
  { label: 'Chat with us', href: HELP_URL, icon: MessageSquare, external: true },
  { label: 'Talk with us', href: 'tel:+914040123456', icon: Headphones },
  { label: 'Write to us', href: MAIL_TO, icon: Mail },
  { label: 'Resources', href: HELP_URL, icon: BookOpen, external: true },
  { label: 'Take a tour', href: HELP_URL, icon: Rocket, external: true },
];

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
        <div className="relative flex-none bg-gradient-to-br from-[#4F46E5] via-[#4458d8] to-[#2646C6] px-5 pb-5 pt-6 text-white">
          <button type="button" onClick={onClose} aria-label="Close" className="absolute -left-4 top-5 grid h-9 w-9 place-items-center rounded-full bg-white text-[#44566B] shadow-md hover:bg-[#F2F7FB]"><X size={18} /></button>
          <div className="flex items-center gap-3">
            <span className="rounded-full ring-2 ring-white/40"><Avatar user={user} size="lg" /></span>
            <div className="min-w-0">
              <div className="truncate text-[17px] font-bold">{user?.name || 'Guest'}</div>
              {user?.id && <div className="text-[12.5px] text-white/80">User ID: <span className="font-medium">{user.id}</span></div>}
            </div>
          </div>
          <div className="mt-3 inline-flex max-w-full items-center gap-2 rounded-lg border border-white/30 bg-white/10 px-3 py-1.5 text-[13px] font-semibold">
            <span className="truncate">{company?.name || 'Your company'}</span>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {/* plan */}
          <div className="flex items-center justify-between gap-3 rounded-xl border border-[#E3EDF5] bg-white p-4 shadow-[0_1px_2px_rgba(11,42,68,.05)] dark:border-[#263345] dark:bg-[#151c26]">
            <div className="flex items-center gap-3">
              <span className="grid h-9 w-9 flex-none place-items-center rounded-full bg-[#E8F0FE] text-[#1559C0] dark:bg-[#1a2440] dark:text-[#9db4ff]"><Star size={17} className="fill-current" /></span>
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
              <a href={HELP_URL} target="_blank" rel="noopener noreferrer" className="text-[12px] font-semibold text-[#1559C0] hover:underline">24×7 support</a>
            </div>
            <div className="grid grid-cols-2 gap-1">
              {HELP_LINKS.map((l) => (
                <a key={l.label} href={l.href} {...(l.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13px] text-[#3E5A70] hover:bg-white dark:text-[#aab8c7] dark:hover:bg-[#1a2330]">
                  <l.icon size={15} className="flex-none text-[#5E778C]" />{l.label}
                </a>
              ))}
            </div>
          </div>

          {/* news */}
          <div>
            <h3 className="mb-2 text-[13.5px] font-bold text-[#0B2A44] dark:text-[#e8eef5]">News room</h3>
            <a href={HELP_URL} target="_blank" rel="noopener noreferrer" className="flex items-center gap-3 rounded-xl border border-[#E3EDF5] bg-white p-3 text-[13px] font-semibold text-[#0B2A44] hover:border-[#B9D9F2] dark:border-[#263345] dark:bg-[#151c26] dark:text-[#e8eef5]">
              <span className="grid h-9 w-9 flex-none place-items-center rounded-lg bg-[#FFF4E0] text-[#B45309]"><Gift size={17} /></span>
              What&apos;s new?
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
