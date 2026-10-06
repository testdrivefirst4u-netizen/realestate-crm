import React, { useState } from 'react';
import { LogIn, Loader2, Eye, EyeOff } from 'lucide-react';
import { AppLogo } from '../../components/AppLogo';
import { Button, inputCls, labelCls, InlineNotice } from '../../components/ui';
import { toAppError } from '../../core/errors';
import { AuthStatus } from '../../core/engine';
import { APP } from '../../core/config';
import { platformProductName } from '../../core/tenant';

interface Props {
  status: AuthStatus;
  lastError?: string;
  onLogin: (email: string, password: string) => Promise<void>;
}

/** Is this a message about the whole company account (suspended), not about the credentials? */
export const isCompanyAccountMessage = (msg: string | null | undefined) => /suspend/i.test(String(msg || ''));

/**
 * One sign-in page for every company: the server finds the company from the e-mail address.
 * There is no first-run setup here — accounts are created by the company administrator.
 */
export const LoginScreen: React.FC<Props> = ({ status, lastError, onLogin }) => {
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
    <div className="min-h-screen bg-[#F4F0EB] flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <div className="flex items-center gap-3 justify-center mb-6">
          <AppLogo size="md" />
          <div>
            <div className="text-xl font-bold text-[#1D2F3F] leading-tight">{platformProductName()}</div>
            <div className="text-xs text-[#6B5F57]">{APP.subtitle}</div>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-[#D2C9BF] shadow-lg p-6">
          {status === 'checking' ? (
            <div className="flex flex-col items-center py-8 text-[#6B5F57]">
              <Loader2 size={24} className="animate-spin text-[#A9825A]" />
              <span className="text-xs mt-3">Connecting to the CRM backend…</span>
            </div>
          ) : (
            <form onSubmit={submit} className="space-y-4">
              <div className="flex items-center gap-2">
                <div className="p-2 rounded-lg bg-[#1D2F3F] text-white"><LogIn size={18} /></div>
                <div>
                  <h2 className="text-base font-bold text-[#1D2F3F]">Sign in</h2>
                  <p className="text-[11px] text-[#6B5F57]">Use the email and password your administrator gave you.</p>
                </div>
              </div>

              <div>
                <label className={labelCls}>Email</label>
                <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" autoFocus />
              </div>
              <div>
                <label className={labelCls}>Password</label>
                <div className="relative">
                  <input className={inputCls + ' pr-9'} type={showPw ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete="current-password" />
                  <button type="button" onClick={() => setShowPw(!showPw)} className="absolute right-2.5 top-2 text-[#9E948D] hover:text-[#1D2F3F]" aria-label="Toggle password">{showPw ? <EyeOff size={15} /> : <Eye size={15} />}</button>
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

              <Button type="submit" variant="primary" size="md" className="w-full" loading={busy} icon={<LogIn size={15} />}>
                Sign in
              </Button>
              <p className="text-[11px] text-center text-[#6B5F57]">Accounts are created by your company administrator.</p>
            </form>
          )}
        </div>
        <p className="text-center text-[10px] text-[#9E948D] mt-4">v{APP.version} · Data stays on your CRM server</p>
      </div>
    </div>
  );
};
