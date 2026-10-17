'use client';
import { useState } from 'react';
import { ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { call, errorMessage } from '../../_lib/api';
import { useAdmin } from '../../_components/ConsoleShell';
import { useToast } from '../../_components/Toast';
import { Button, Card, CardHeader, ErrorBox, TextField } from '../../_components/ui';

/** Your super admin account: two-step sign-in with an authenticator app. */
export function AccountSecurityCard() {
  const admin = useAdmin();
  const toast = useToast();
  const [on, setOn] = useState<boolean>(!!admin?.twoFactor);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [turningOff, setTurningOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    }
    setBusy(false);
  };

  return (
    <Card className="mb-6">
      <CardHeader
        title={<span className="inline-flex items-center gap-2">Your account security <span className={on ? 'rounded-full bg-[#ECFDF3] px-2 py-0.5 text-[12px] font-semibold text-[#067647]' : 'rounded-full bg-[#EEF4F9] px-2 py-0.5 text-[12px] font-semibold text-[#3F5A70]'}>{on ? 'Two-step sign-in on' : 'Two-step sign-in off'}</span></span>}
        description="A super admin can see every company's data. Two-step sign-in asks for a 6-digit code from an authenticator app (Google Authenticator, Microsoft Authenticator, Authy) after your password."
      />
      <div className="space-y-4 p-5">
        <ErrorBox message={error} />
        {!on && !setup && (
          <Button onClick={() => void run(async () => setSetup(await call('saTotpSetup', {})))} loading={busy} icon={<ShieldCheck className="h-4 w-4" aria-hidden />}>Turn on two-step sign-in</Button>
        )}
        {!on && setup && (
          <>
            <ol className="list-decimal space-y-2 pl-5 text-[14px] text-[#233B50]">
              <li>In your authenticator app choose <strong>Add account</strong> → <strong>Enter a setup key</strong> (time-based).</li>
              <li>
                Type this key:
                <code className="mt-1.5 block w-fit select-all break-all rounded-lg border border-[#D3E3F0] bg-[#F2F7FB] px-3 py-2 font-mono text-[15px] tracking-wider text-[#0A1F33]">{setup.secret}</code>
                <a href={setup.uri} className="mt-1.5 inline-flex min-h-[32px] items-center gap-1.5 text-[13px] font-semibold text-[#0B6BB0] underline"><Smartphone className="h-3.5 w-3.5" aria-hidden />On this phone? Open in authenticator app</a>
              </li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <div className="flex flex-wrap items-end gap-2">
              <TextField label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))} placeholder="123 456" className="w-40" />
              <Button
                onClick={() => void run(async () => { await call('saTotpEnable', { code }); setOn(true); setSetup(null); setCode(''); toast('Two-step sign-in is on'); })}
                loading={busy}
                disabled={code.replace(/\s/g, '').length !== 6}
              >
                Confirm and turn on
              </Button>
              <Button variant="ghost" onClick={() => { setSetup(null); setCode(''); setError(''); }} disabled={busy}>Cancel</Button>
            </div>
            <p className="text-[13px] text-[#5E778C]">Lost your phone later? Another super admin can reset your password, which also turns two-step sign-in off.</p>
          </>
        )}
        {on && !turningOff && (
          <Button variant="secondary" onClick={() => setTurningOff(true)} icon={<ShieldOff className="h-4 w-4" aria-hidden />}>Turn off</Button>
        )}
        {on && turningOff && (
          <div className="flex flex-wrap items-end gap-2">
            <TextField label="Your password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-64" />
            <Button
              variant="danger"
              onClick={() => void run(async () => { await call('saTotpDisable', { password }); setOn(false); setTurningOff(false); setPassword(''); toast('Two-step sign-in is off'); })}
              loading={busy}
              disabled={!password}
            >
              Turn off two-step sign-in
            </Button>
            <Button variant="ghost" onClick={() => { setTurningOff(false); setPassword(''); setError(''); }} disabled={busy}>Cancel</Button>
          </div>
        )}
      </div>
    </Card>
  );
}
