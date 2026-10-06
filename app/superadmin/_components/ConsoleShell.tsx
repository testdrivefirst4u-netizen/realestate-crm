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
import { ErrorBox, Spinner, cx } from './ui';

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
  { href: '/superadmin/settings', label: 'Settings', icon: Settings2 },
];

function NavLinks({ onNavigate, vertical = false }: { onNavigate?: () => void; vertical?: boolean }) {
  const pathname = usePathname() || '';
  return (
    <ul className={vertical ? 'space-y-1' : 'flex flex-wrap items-center gap-1'}>
      {NAV.map(({ href, label, icon: Icon, exact }) => {
        const active = exact ? pathname === href : pathname === href || pathname.startsWith(href + '/');
        return (
          <li key={href}>
            <Link
              href={href}
              onClick={onNavigate}
              aria-current={active ? 'page' : undefined}
              className={cx(
                'flex items-center gap-2.5 rounded-lg text-[14px] font-medium transition-colors',
                vertical ? 'px-3 py-2.5' : 'h-10 px-3.5',
                active ? 'bg-white/10 text-white' : 'text-[#C9D3DC] hover:bg-white/5 hover:text-white',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A9825A]',
              )}
            >
              {vertical && <Icon className={cx('h-[18px] w-[18px]', active ? 'text-[#D4B28C]' : 'text-[#8FA0AF]')} aria-hidden />}
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
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#A9825A] text-[14px] font-bold text-white">A</div>
      <span className="text-[15px] font-semibold text-white">Amaya Platform</span>
      <span className="ml-1 hidden text-[11px] uppercase tracking-[0.14em] text-[#D4B28C] sm:inline">Super admin</span>
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
  /** The dashboard draws its own full-width summary strip under the top bar. */
  const fullBleed = pathname === '/superadmin';

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
        <div className="min-h-screen bg-[#FDFCFA]">
          <header className="sticky top-0 z-20 bg-[#1D2F3F] text-white">
            <div className="mx-auto flex min-h-16 max-w-[1320px] items-center gap-6 px-4 sm:px-8">
              <button
                type="button"
                onClick={() => setDrawer(true)}
                aria-label="Open navigation"
                aria-expanded={drawer}
                aria-controls="sa-drawer"
                className="-ml-1 rounded-md p-2 text-[#C9D3DC] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A9825A] lg:hidden"
              >
                <Menu className="h-5 w-5" aria-hidden />
              </button>
              <Brand />
              <nav aria-label="Console" className="hidden flex-1 lg:block">
                <NavLinks />
              </nav>
              <div className="ml-auto flex items-center gap-2">
                <div
                  aria-hidden
                  title={`${admin.name} · ${admin.email}`}
                  className="hidden h-9 w-9 items-center justify-center rounded-full bg-[#3E5468] text-[13px] font-semibold text-white sm:flex"
                >
                  {initials(admin.name)}
                </div>
                <button
                  type="button"
                  onClick={() => setPwOpen(true)}
                  className="inline-flex h-9 items-center gap-2 rounded-lg px-2.5 text-[13.5px] font-medium text-[#C9D3DC] hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A9825A]"
                >
                  <KeyRound className="h-4 w-4" aria-hidden />
                  <span className="hidden xl:inline">Change password</span>
                  <span className="sr-only xl:hidden">Change password</span>
                </button>
                <button
                  type="button"
                  onClick={signOut}
                  disabled={signingOut}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#3A5266] px-3 text-[13.5px] font-medium text-[#C9D3DC] hover:bg-white/10 hover:text-white disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A9825A]"
                >
                  <LogOut className="h-4 w-4" aria-hidden />
                  <span className="hidden md:inline">{signingOut ? 'Signing out…' : 'Sign out'}</span>
                  <span className="sr-only md:hidden">Sign out</span>
                </button>
              </div>
            </div>
          </header>

          {/* Mobile drawer */}
          {drawer && (
            <div className="fixed inset-0 z-40 lg:hidden">
              <div aria-hidden className="animate-in fade-in absolute inset-0 bg-[#14202B]/50" onClick={() => setDrawer(false)} />
              <aside id="sa-drawer" aria-label="Console navigation" className="animate-in slide-in-from-right absolute inset-y-0 left-0 flex w-72 max-w-[85vw] flex-col bg-[#1D2F3F] px-3 py-5">
                <div className="flex items-center justify-between px-2">
                  <Brand />
                  <button type="button" onClick={() => setDrawer(false)} aria-label="Close navigation" className="rounded-md p-2 text-[#C9D3DC] hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#A9825A]">
                    <X className="h-5 w-5" aria-hidden />
                  </button>
                </div>
                <nav aria-label="Console" className="mt-8">
                  <NavLinks vertical onNavigate={() => setDrawer(false)} />
                </nav>
                <p className="mt-auto px-3 text-[12.5px] text-[#8FA0AF]">{admin.name} · {admin.email}</p>
              </aside>
            </div>
          )}

          <main id="sa-main" tabIndex={-1} className="outline-none">
            {fullBleed ? children : <div className="mx-auto w-full max-w-[1320px] px-4 py-6 sm:px-8 lg:py-8">{children}</div>}
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
