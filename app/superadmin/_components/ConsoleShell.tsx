'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Activity, Building2, Database, LayoutDashboard, Layers, LogOut, Menu, Receipt, ScrollText, Settings2, ShieldCheck, X } from 'lucide-react';
import type { SuperAdmin } from '@/server/platform/contract';
import { LOGIN_PATH, call, errorMessage, isAuthError } from '../_lib/api';
import { initials } from '../_lib/format';
import { ToastProvider } from './Toast';
import { ErrorBox, Spinner, cx } from './ui';

const AdminCtx = createContext<SuperAdmin | null>(null);
/** The signed-in super admin (available inside the console shell). */
export function useAdmin() {
  return useContext(AdminCtx);
}

const GROUPS: Array<{ label: string; items: Array<{ href: string; label: string; icon: typeof LayoutDashboard; exact?: boolean }> }> = [
  { label: 'Overview', items: [
    { href: '/superadmin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
    { href: '/superadmin/health', label: 'Platform health', icon: Activity },
    { href: '/superadmin/storage', label: 'Database storage', icon: Database },
  ] },
  { label: 'Customers', items: [
    { href: '/superadmin/companies', label: 'Companies', icon: Building2 },
    { href: '/superadmin/plans', label: 'Plans', icon: Layers },
    { href: '/superadmin/billing', label: 'Billing', icon: Receipt },
  ] },
  { label: 'Security', items: [
    { href: '/superadmin/admins', label: 'Super admins', icon: ShieldCheck },
    { href: '/superadmin/audit', label: 'Audit log', icon: ScrollText },
  ] },
  { label: 'Platform', items: [{ href: '/superadmin/settings', label: 'Settings', icon: Settings2 }] },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() || '';
  return (
    <div className="space-y-5">
      {GROUPS.map((g) => (
        <div key={g.label}>
          <div className="px-3 pb-1.5 text-[11px] font-bold uppercase tracking-[0.1em] text-[#7FA3C2]">{g.label}</div>
          <ul className="space-y-0.5">
            {g.items.map(({ href, label, icon: Icon, exact }) => {
              const active = exact ? pathname === href : pathname === href || pathname.startsWith(href + '/');
              return (
                <li key={href}>
                  <Link
                    href={href}
                    onClick={onNavigate}
                    aria-current={active ? 'page' : undefined}
                    className={cx(
                      'relative flex min-h-[42px] items-center gap-3 rounded-xl px-3 text-[14px] font-medium transition-colors',
                      active ? 'bg-[#16466E] text-white' : 'text-[#C9D3DC] hover:bg-white/5 hover:text-white',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#36B3F2]',
                    )}
                  >
                    {active && <span aria-hidden className="absolute -left-3 top-2 bottom-2 w-1 rounded-r bg-[#36B3F2]" />}
                    <Icon className={cx('h-[18px] w-[18px] flex-none', active ? 'text-[#36B3F2]' : 'text-[#7FA3C2]')} aria-hidden />
                    {label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

function Brand() {
  return (
    <Link href="/superadmin" className="flex items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#36B3F2]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/broaddcast_logo-white.svg" alt="Broaddcast" className="h-8 w-auto" />
      <span className="border-l border-white/20 pl-3 text-[10.5px] font-bold uppercase tracking-[0.14em] text-[#36B3F2]">Super admin</span>
    </Link>
  );
}

/** The dark navigation panel: brand, grouped links, the signed-in admin and Sign out. */
function SidebarPanel({ admin, onNavigate, onClose, signingOut, signOut }: { admin: SuperAdmin; onNavigate?: () => void; onClose?: () => void; signingOut: boolean; signOut: () => void }) {
  return (
    <div className="flex h-full flex-col rounded-[24px] bg-[#0A1F33] px-3 py-5">
      <div className="flex items-center justify-between gap-2 px-2">
        <Brand />
        {onClose && (
          <button type="button" onClick={onClose} aria-label="Close navigation" className="flex h-11 w-11 items-center justify-center rounded-lg text-[#C9D3DC] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#36B3F2]">
            <X className="h-5 w-5" aria-hidden />
          </button>
        )}
      </div>
      <nav aria-label="Console" className="mt-7 min-h-0 flex-1 overflow-y-auto pl-3 pr-1">
        <NavLinks onNavigate={onNavigate} />
      </nav>
      <div className="mt-4 flex items-center gap-2.5 border-t border-white/10 px-2 pt-4">
        <div aria-hidden className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[#16466E] text-[13px] font-semibold text-white">{initials(admin.name)}</div>
        <div className="min-w-0 flex-1 text-[13px] leading-tight">
          <div className="truncate font-semibold text-white">{admin.name}</div>
          <div className="truncate text-[#7FA3C2]">{admin.email}</div>
        </div>
        <button
          type="button"
          onClick={signOut}
          disabled={signingOut}
          aria-label={signingOut ? 'Signing out' : 'Sign out'}
          title="Sign out"
          className="flex h-10 w-10 flex-none items-center justify-center rounded-full border border-white/15 text-[#C9D3DC] hover:bg-white/10 hover:text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#36B3F2]"
        >
          <LogOut className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<SuperAdmin | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;
    setError('');
    call('saMe', {}).then(
      (r) => {
        if (alive) setAdmin(r.user);
      },
      (e) => {
        if (!alive || isAuthError(e)) return; // call() already redirects to the login page
        setError(errorMessage(e));
      },
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  useEffect(() => setDrawer(false), [pathname]);

  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawer(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);

  const signOut = async () => {
    setSigningOut(true);
    try {
      await call('saLogout', {});
    } catch {
      /* the session is gone either way */
    }
    window.location.assign(LOGIN_PATH);
  };

  if (!admin) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F2F7FB] p-6">
        {error ? (
          <div className="w-full max-w-md">
            <ErrorBox message={error} onRetry={() => setAttempt((a) => a + 1)} />
          </div>
        ) : (
          <Spinner label="Checking your session…" />
        )}
      </div>
    );
  }

  return (
    <AdminCtx.Provider value={admin}>
      <ToastProvider>
        <a href="#sa-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-lg focus:bg-white focus:px-4 focus:py-2 focus:shadow-lg">
          Skip to content
        </a>
        <div className="min-h-screen bg-[#F2F7FB] lg:flex">
          {/* Desktop sidebar */}
          <aside aria-label="Console navigation" className="sticky top-0 hidden h-screen w-[272px] flex-none p-3 lg:block">
            <SidebarPanel admin={admin} signingOut={signingOut} signOut={signOut} />
          </aside>

          {/* Mobile top bar */}
          <header className="sticky top-0 z-20 flex min-h-14 items-center gap-3 bg-[#0B2A44] px-3 text-white lg:hidden">
            <button
              type="button"
              onClick={() => setDrawer(true)}
              aria-label="Open navigation"
              aria-expanded={drawer}
              aria-controls="sa-drawer"
              className="flex h-11 w-11 items-center justify-center rounded-md text-[#C9D3DC] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#36B3F2]"
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
            <Brand />
          </header>

          {/* Mobile drawer */}
          {drawer && (
            <div className="fixed inset-0 z-40 lg:hidden">
              <div aria-hidden className="animate-in fade-in absolute inset-0 bg-[#0A1F33]/50" onClick={() => setDrawer(false)} />
              <div id="sa-drawer" className="animate-in slide-in-from-left absolute inset-y-0 left-0 w-[290px] max-w-[88vw] p-2">
                <SidebarPanel admin={admin} onNavigate={() => setDrawer(false)} onClose={() => setDrawer(false)} signingOut={signingOut} signOut={signOut} />
              </div>
            </div>
          )}

          <main id="sa-main" tabIndex={-1} className="min-w-0 flex-1 outline-none">
            <div className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-8 lg:py-8">{children}</div>
          </main>
        </div>
      </ToastProvider>
    </AdminCtx.Provider>
  );
}
