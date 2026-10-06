import React, { useState } from 'react';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { AppLogo } from '../../components/AppLogo';
import { InlineNotice } from '../../components/ui';
import { toAppError } from '../../core/errors';
import { AuthStatus } from '../../core/engine';
import { APP } from '../../core/config';
import { platformProductName } from '../../core/tenant';

interface Props {
  status: AuthStatus;
  lastError?: string;
  onLogin: (email: string, password: string) => Promise<void>;
  /** Photo for the left panel (e.g. `/login-photo.jpg` from public/); without one a building illustration is shown. */
  photoUrl?: string | null;
}

/** Is this a message about the whole company account (suspended), not about the credentials? */
export const isCompanyAccountMessage = (msg: string | null | undefined) => /suspend/i.test(String(msg || ''));

const fieldCls =
  'w-full h-12 px-3.5 rounded-[10px] border border-[#C9BEB2] bg-white text-[15px] text-[#3D3530] placeholder:text-[#A39990] focus:outline-none focus:ring-2 focus:ring-[#A9825A] focus:border-[#A9825A]';

/** Stylised project skyline in the brand colours — shown until a real photo is added. */
function BuildingIllustration() {
  const win = (xs: number[], ys: number[], w: number, h: number) =>
    ys.flatMap((y) => xs.map((x) => <rect key={`${x}-${y}`} x={x} y={y} width={w} height={h} />));
  return (
    <svg viewBox="0 0 800 800" preserveAspectRatio="xMidYMax slice" className="absolute inset-0 h-full w-full" aria-hidden="true">
      <rect width="800" height="800" fill="#E7D8C6" />
      <circle cx="610" cy="210" r="90" fill="#F1E6D8" />
      <rect x="90" y="300" width="230" height="500" fill="#3E5468" />
      <rect x="300" y="190" width="260" height="610" fill="#1D2F3F" />
      <rect x="540" y="360" width="200" height="440" fill="#A9825A" />
      <g fill="#E7D8C6" opacity="0.55">
        {win([330, 388, 446, 504], [230, 306, 382, 458], 36, 46)}
        {win([120, 185, 250], [340, 410], 40, 40)}
        {win([570, 625, 680], [400, 460], 34, 34)}
      </g>
      <rect x="0" y="690" width="800" height="110" fill="#7C8B78" />
    </svg>
  );
}

/**
 * One sign-in page for everybody: company users (the server finds the company from the e-mail address)
 * and platform super admins. There is no first-run setup here — accounts are created by an administrator.
 */
export const LoginScreen: React.FC<Props> = ({ status, lastError, onLogin, photoUrl }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onLogin(email, password);
    } catch (err) {
      setError(toAppError(err).userMessage);
    } finally {
      setBusy(false);
    }
  };

  const shown = error || lastError || '';
  const suspended = isCompanyAccountMessage(shown);

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-[#FDFCFA] text-[#3D3530]">
      {/* Project photo */}
      <section aria-label="Project" className="relative overflow-hidden bg-[#DCCFBF] min-h-[260px] sm:min-h-[340px] lg:min-h-screen lg:flex-[1.3] flex flex-col justify-end">
        {photoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={photoUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        ) : (
          <BuildingIllustration />
        )}
        <div className="relative m-4 sm:m-8 max-w-[420px] rounded-[14px] bg-[#1D2F3F]/90 px-5 py-4 text-white">
          <div className="text-[12px] font-medium uppercase tracking-[0.16em] text-[#D4B28C]">{APP.subtitle}</div>
          <div className="mt-1.5 text-lg sm:text-xl font-semibold leading-snug">Every enquiry, site visit and booking in one place.</div>
        </div>
      </section>

      {/* Form */}
      <main className="flex-1 flex items-center justify-center px-6 py-10 sm:py-12">
        <div className="w-full max-w-[380px] flex flex-col gap-[22px]">
          <div className="flex items-center gap-2.5">
            <AppLogo size="sm" />
            <span className="text-[17px] font-semibold text-[#1D2F3F]">{platformProductName()}</span>
          </div>

          {status === 'checking' ? (
            <div className="flex flex-col items-center py-10 text-[#5E534B]">
              <Loader2 size={24} className="animate-spin text-[#A9825A]" />
              <span className="text-sm mt-3">Connecting to the CRM backend…</span>
            </div>
          ) : (
            <form onSubmit={submit} className="flex flex-col gap-[22px]">
              <div className="flex flex-col gap-1.5">
                <h1 className="m-0 text-[30px] font-semibold leading-tight text-[#1D2F3F]">Sign in</h1>
                <p className="m-0 text-[15px] text-[#5E534B]">Use the email and password your administrator gave you.</p>
              </div>

              <div className="flex flex-col gap-2">
                <label htmlFor="login-email" className="text-sm font-medium">Email</label>
                <input id="login-email" className={fieldCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" autoFocus placeholder="you@company.com" />
              </div>
              <div className="flex flex-col gap-2">
                <label htmlFor="login-password" className="text-sm font-medium">Password</label>
                <div className="relative">
                  <input id="login-password" className={fieldCls + ' pr-12'} type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete="current-password" />
                  <button
                    type="button"
                    onClick={() => setShowPw(!showPw)}
                    className="absolute right-0.5 top-0.5 h-11 w-11 flex items-center justify-center rounded-[9px] text-[#6B5F57] hover:text-[#1D2F3F]"
                    aria-label={showPw ? 'Hide password' : 'Show password'}
                  >
                    {showPw ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {shown && (
                <InlineNotice tone="warning">
                  {suspended ? (
                    <>
                      <strong className="block">Company account suspended</strong>
                      {shown}
                    </>
                  ) : (
                    shown
                  )}
                </InlineNotice>
              )}

              <button
                type="submit"
                disabled={busy}
                className="h-[50px] rounded-[10px] bg-[#7A5B37] hover:bg-[#6A4E2F] disabled:opacity-70 text-white text-base font-semibold flex items-center justify-center gap-2 transition-colors"
              >
                {busy && <Loader2 size={18} className="animate-spin" />}
                {busy ? 'Signing in…' : 'Sign in'}
              </button>
              <p className="m-0 text-sm text-[#5E534B]">Accounts are created by your company administrator. Forgot your password? Ask them to reset it.</p>
            </form>
          )}

          <p className="m-0 text-[11px] text-[#8A7F77]">
            v{APP.version} · <a href="/privacy" className="underline underline-offset-2 hover:text-[#3D3530]">Privacy</a> · <a href="/terms" className="underline underline-offset-2 hover:text-[#3D3530]">Terms</a> · <a href="/data-deletion" className="underline underline-offset-2 hover:text-[#3D3530]">Data deletion</a>
          </p>
        </div>
      </main>
    </div>
  );
};
