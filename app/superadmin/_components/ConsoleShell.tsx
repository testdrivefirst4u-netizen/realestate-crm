'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Building2, KeyRound, LayoutDashboard, Layers, LogOut, Menu, ScrollText, Settings2, ShieldCheck, X } from 'lucide-react';
import type { SuperAdmin } from '@/server/platform/contract';
import { LOGIN_PATH, call, errorMessage, isAuthError } from '../_lib/api';
import { initials } from '../_lib/format';
import { ChangePasswordDialog } from './ChangePasswordDialog';
import { ToastProvider } from './Toast';
import { ErrorBox, Spinner, cx, focusRing } from './ui';

const AdminCtx = createContext<SuperAdmin | null>(null);
/** The signed-in super admin (available inside the console shell). */
export function useAdmin() {
  return useContext(AdminCtx);
}

const NAV = [
  { href: '/superadmin', label: 'Dashboard', icon: LayoutDashboard, exact: true },
  { href: '/superadmin/companies', label: 'Companies', icon: Building2 },
  { href: '/superadmin/plans', label: 'Plans', icon: Layers },
  { href: '/superadmin/admins', label: 'Super admins', icon: ShieldCheck },
  { href: '/superadmin/audit', label: 'Audit log', icon: ScrollText },
  { href: '/superadmin/settings', label: 'Platform settings', icon: Settings2 },
];

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname() || '';
  return (
    <ul className="space-y-1">
      {NAV.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname === href || pathname.startsWith(href + '/');
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] font-medium transition-colors',
                active ? 'bg-white/10 text-white shadow-[inset_3px_0_0_#A9825A]' : 'text-[#C9D3DC] hover:bg-white/5 hover:text-white',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A9825A]',
              )}
            >
              <Icon className={cx('h-[18px] w-[18px]', active ? 'text-[#D4B28C]' : 'text-[#8FA0AF]')} aria-hidden />
              {label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3 px-2">
      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#A9825A] text-[15px] font-bold text-white">A</div>
      <div className="leading-tight">
        <p className="text-[15px] font-semibold text-white">Amaya Platform</p>
        <p className="text-[12px] uppercase tracking-[0.14em] text-[#A9B6C2]">Super Admin</p>
      </div>
    </div>
  );
}

export function ConsoleShell({ children }: { children: ReactNode }) {
  const [admin, setAdmin] = useState<SuperAdmin | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [drawer, setDrawer] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const [mustChange, setMustChange] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;
    setError('');
    call('saMe', {}).then(
      (r) => {
        if (!alive) return;
        setAdmin(r.user);
        // The backend may flag accounts that still use a temporary password (not part of the contract type).
        if ((r.user as SuperAdmin & { mustChangePassword?: boolean }).mustChangePassword) {
          setMustChange(true);
          setPwOpen(true);
        }
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
      <div className="flex min-h-screen items-center justify-center bg-[#F4F0EB] p-6">
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
        <div className="min-h-screen bg-[#F4F0EB] lg:pl-64">
          {/* Desktop sidebar */}
          <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 flex-col bg-[#1D2F3F] px-3 py-5 lg:flex">
            <Brand />
            <nav aria-label="Console" className="mt-8 flex-1">
              <NavLinks />
            </nav>
            <p className="px-3 text-[12px] text-[#7F909F]">Multi-tenant administration</p>
          </aside>

          {/* Mobile drawer */}
          {drawer && (
            <div className="fixed inset-0 z-40 lg:hidden">
              <div aria-hidden className="animate-in fade-in absolute inset-0 bg-[#14202B]/50" onClick={() => setDrawer(false)} />
              <aside id="sa-drawer" aria-label="Console navigation" className="animate-in slide-in-from-right absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-[#1D2F3F] px-3 py-5">
                <div className="flex items-center justify-between">
                  <Brand />
                  <button type="button" onClick={() => setDrawer(false)} aria-label="Close navigation" className="rounded-md p-2 text-[#C9D3DC] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A9825A]">
                    <X className="h-5 w-5" aria-hidden />
                  </button>
                </div>
                <nav aria-label="Console" className="mt-8">
                  <NavLinks onNavigate={() => setDrawer(false)} />
                </nav>
              </aside>
            </div>
          )}

          {/* Top bar */}
          <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-[#E4DCD2] bg-white/90 px-4 backdrop-blur sm:px-6">
            <button
              type="button"
              onClick={() => setDrawer(true)}
              aria-label="Open navigation"
              aria-expanded={drawer}
              aria-controls="sa-drawer"
              className={cx('rounded-md p-2 text-[#1D2F3F] hover:bg-[#F4F0EB] lg:hidden', focusRing)}
            >
              <Menu className="h-5 w-5" aria-hidden />
            </button>
            <span className="text-[15px] font-semibold text-[#1D2F3F] lg:hidden">Super Admin</span>
            <div className="ml-auto flex items-center gap-2 sm:gap-3">
              <div className="hidden items-center gap-3 sm:flex">
                <div aria-hidden className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F4EEE7] text-[13px] font-semibold text-[#6B4F33] ring-1 ring-[#E7DCCF]">
                  {initials(admin.name)}
                </div>
                <div className="leading-tight">
                  <p className="text-[14px] font-medium text-[#14202B]">{admin.name}</p>
                  <p className="text-[12.5px] text-[#7A6F64]">{admin.email}</p>
                </div>
              </div>
              <span aria-hidden className="mx-1 hidden h-8 w-px bg-[#E4DCD2] sm:block" />
              <button
                type="button"
                onClick={() => setPwOpen(true)}
                className={cx('inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] font-medium text-[#1D2F3F] hover:bg-[#F4F0EB]', focusRing)}
              >
                <KeyRound className="h-4 w-4" aria-hidden />
                <span className="hidden md:inline">Change password</span>
                <span className="sr-only md:hidden">Change password</span>
              </button>
              <button
                type="button"
                onClick={signOut}
                disabled={signingOut}
                className={cx('inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-[13.5px] font-medium text-[#1D2F3F] hover:bg-[#F4F0EB] disabled:opacity-60', focusRing)}
              >
                <LogOut className="h-4 w-4" aria-hidden />
                <span className="hidden md:inline">{signingOut ? 'Signing out…' : 'Sign out'}</span>
                <span className="sr-only md:hidden">Sign out</span>
              </button>
            </div>
          </header>

          <main id="sa-main" tabIndex={-1} className="mx-auto w-full max-w-7xl px-4 py-6 outline-none sm:px-6 lg:px-8 lg:py-8">
            {children}
          </main>
        </div>
        <ChangePasswordDialog
          open={pwOpen}
          forced={mustChange}
          onClose={() => setPwOpen(false)}
          onChanged={() => setMustChange(false)}
        />
      </ToastProvider>
    </AdminCtx.Provider>
  );
}
