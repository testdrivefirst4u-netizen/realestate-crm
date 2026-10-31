import React, { useState } from 'react';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { AppLogo } from '../../components/AppLogo';
import { InlineNotice } from '../../components/ui';
import { toAppError } from '../../core/errors';
import { AuthStatus } from '../../core/engine';
import { APP } from '../../core/config';
import { platformProductName } from '../../core/tenant';
import { ConstructionScene } from './ConstructionScene';
import { Check } from 'lucide-react';

interface Props {
  status: AuthStatus;
  lastError?: string;
  /** `code`: the authenticator code, once the server asked for it (two-step sign-in). */
  onLogin: (email: string, password: string, code?: string) => Promise<void>;
  /** Photo for the left panel (e.g. `/login-photo.jpg` from public/); without one an animated construction scene is shown. */
  photoUrl?: string | null;
}

/** Is this a message about the whole company account (suspended), not about the credentials? */
export const isCompanyAccountMessage = (msg: string | null | undefined) => /suspend/i.test(String(msg || ''));

const fieldCls =
  'w-full h-12 px-3.5 rounded-[10px] border border-[#C9BEB2] bg-white text-[15px] text-[#3D3530] placeholder:text-[#A39990] focus:outline-none focus:ring-2 focus:ring-[#A9825A] focus:border-[#A9825A]';

/** Sign-in form motion: pieces rise in on arrival; the button stacks floors while checking. */
const LOGIN_CSS = `
.lg-rise{animation:lg-rise .6s cubic-bezier(.2,.8,.2,1) both}
@keyframes lg-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
.lg-floors{display:inline-flex;flex-direction:column-reverse;gap:2px;width:16px}
.lg-floors i{display:block;height:3px;border-radius:1px;background:#fff;opacity:0;animation:lg-floor 1.2s ease-in-out infinite}
.lg-floors i:nth-child(2){animation-delay:.15s;width:88%}.lg-floors i:nth-child(3){animation-delay:.3s;width:76%}.lg-floors i:nth-child(4){animation-delay:.45s;width:64%}
@keyframes lg-floor{0%{opacity:0;transform:translateY(-4px)}25%,70%{opacity:1;transform:none}100%{opacity:0}}
.lg-busy::after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.18) 50%,transparent 70%);transform:translateX(-100%);animation:lg-sheen 1.3s ease-in-out infinite}
@keyframes lg-sheen{to{transform:translateX(100%)}}
.lg-pop{animation:lg-pop .45s cubic-bezier(.3,1.6,.5,1) both}
@keyframes lg-pop{from{transform:scale(.3);opacity:0}to{transform:none;opacity:1}}
@media (prefers-reduced-motion:reduce){.lg-rise,.lg-floors i,.lg-busy::after,.lg-pop{animation:none!important;opacity:1!important}}
`;

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
  /** The password was right and this account uses two-step sign-in: ask for the code. */
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState('');
  /** Signed in: the tower glows while the CRM opens. */
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await onLogin(email, password, needCode ? code : undefined);
      setDone(true);
    } catch (err) {
      const e = toAppError(err);
      if (e.details?.totpRequired) {
        // first time: just show the code box; after a wrong code: show why
        if (needCode) setError(e.userMessage);
        setNeedCode(true);
        setCode('');
      } else setError(e.userMessage);
    } finally {
      setBusy(false);
    }
  };
  const working = busy || done;

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
          <ConstructionScene mode={done ? 'success' : busy ? 'signing' : 'idle'} />
        )}
        <div className="lg-rise relative m-4 sm:m-8 max-w-[420px] rounded-[14px] bg-[#1D2F3F]/90 px-5 py-4 text-white shadow-xl backdrop-blur-sm" style={{ animationDelay: '300ms' }}>
          <div className="text-[12px] font-medium uppercase tracking-[0.16em] text-[#D4B28C]">{APP.subtitle}</div>
          <div className="mt-1.5 text-lg sm:text-xl font-semibold leading-snug">{done ? 'Welcome back. Opening your CRM…' : busy ? 'Checking your details…' : 'Every enquiry, site visit and booking in one place.'}</div>
        </div>
      </section>

      {/* Form */}
      <main className="flex-1 flex items-center justify-center px-6 py-10 sm:py-12">
        <style>{LOGIN_CSS}</style>
        <div className="w-full max-w-[380px] flex flex-col gap-[22px]">
          <div className="lg-rise flex items-center gap-2.5">
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
              <div className="lg-rise flex flex-col gap-1.5" style={{ animationDelay: '80ms' }}>
                <h1 className="m-0 text-[30px] font-semibold leading-tight text-[#1D2F3F]">Sign in</h1>
                <p className="m-0 text-[15px] text-[#5E534B]">Use the email and password your administrator gave you.</p>
              </div>

              <div className="lg-rise flex flex-col gap-2" style={{ animationDelay: '160ms' }}>
                <label htmlFor="login-email" className="text-sm font-medium">Email</label>
                <input id="login-email" className={fieldCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" autoFocus placeholder="you@company.com" />
              </div>
              <div className="lg-rise flex flex-col gap-2" style={{ animationDelay: '240ms' }}>
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

              {needCode && (
                <div className="flex flex-col gap-2">
                  <label htmlFor="login-code" className="text-sm font-medium">Authenticator code</label>
                  <input id="login-code" className={fieldCls + ' tracking-[0.3em] text-lg'} inputMode="numeric" pattern="[0-9 ]{6,7}" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))} required autoComplete="one-time-code" autoFocus placeholder="123 456" aria-describedby="login-code-hint" />
                  <p id="login-code-hint" className="m-0 text-[13px] text-[#5E534B]">Open your authenticator app and type the 6-digit code shown for this account.</p>
                </div>
              )}

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
                disabled={working}
                style={{ animationDelay: '320ms' }}
                className={'lg-rise lg-btn relative overflow-hidden h-[50px] rounded-[10px] text-white text-base font-semibold flex items-center justify-center gap-2.5 transition-[background-color,transform,box-shadow] duration-300 ' + (done ? 'bg-[#2F7D57]' : 'bg-[#7A5B37] hover:bg-[#6A4E2F] hover:-translate-y-px hover:shadow-lg active:translate-y-0') + (busy ? ' lg-busy' : '')}
              >
                {done ? (
                  <><span className="lg-pop inline-flex h-6 w-6 items-center justify-center rounded-full bg-white/20"><Check size={16} strokeWidth={3} /></span>Signed in</>
                ) : busy ? (
                  <><span className="lg-floors" aria-hidden><i /><i /><i /><i /></span>Signing in…</>
                ) : needCode ? 'Verify and sign in' : 'Sign in'}
              </button>
              <p className="m-0 text-sm text-[#5E534B]">Accounts are created by your company administrator. Forgot your password? Ask them to reset it.</p>
            </form>
          )}

          <p className="m-0 text-[11px] text-[#8A7F77]">
            v{APP.version} · <a href="/privacy" className="underline underline-offset-2 hover:text-[#3D3530]">Privacy</a> · <a href="/terms" className="underline underline-offset-2 hover:text-[#3D3530]">Terms</a> · <a href="/data-deletion" className="underline underline-offset-2 hover:text-[#3D3530]">Data deletion</a>
          </p>
          <p className="m-0 flex items-center gap-2 text-[11px] text-[#8A7F77]">
            Developed by
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/BroaddCast-Logo-blue.svg" alt="Broaddcast" className="h-6 w-auto" />
          </p>
        </div>
      </main>
    </div>
  );
};
