/**
 * My profile › Two-step sign-in: add the account to an authenticator app (setup key or otpauth link), confirm with a
 * code, or turn it off with the password. Sign-in then asks for the app's 6-digit code after the password.
 */
import React, { useState } from 'react';
import { ShieldCheck, ShieldOff, Smartphone } from 'lucide-react';
import { api } from '../../core/api';
import { toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, InlineNotice, inputCls } from '../../components/ui';

export const TwoStepCard: React.FC<{ enabled: boolean; onChanged: () => void }> = ({ enabled: enabledProp, onChanged }) => {
  // the signed-in session only learns the new state on its next refresh: show it right away
  const [override, setOverride] = useState<boolean | null>(null);
  const enabled = override ?? enabledProp;
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [turningOff, setTurningOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(toAppError(e).userMessage);
    }
    setBusy(false);
  };

  const start = () => run(async () => setSetup(await api.auth.totpSetup()));
  const confirm = () => run(async () => {
    await api.auth.totpEnable(code);
    setOverride(true);
    setSetup(null);
    setCode('');
    toast('Two-step sign-in is on', 'From now on you will be asked for a code from your authenticator app.', 'success');
    onChanged();
  });
  const turnOff = () => run(async () => {
    await api.auth.totpDisable(password);
    setOverride(false);
    setPassword('');
    setTurningOff(false);
    toast('Two-step sign-in is off', undefined, 'info');
    onChanged();
  });

  return (
    <Card
      title={<span className="inline-flex items-center gap-2">Two-step sign-in {enabled ? <Badge tone="sage">On</Badge> : <Badge>Off</Badge>}</span>}
      subtitle="After your password, sign-in also asks for a 6-digit code from an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, Authy). Someone who learns your password still cannot get in."
    >
      {error && <InlineNotice tone="warning">{error}</InlineNotice>}

      {!enabled && !setup && (
        <Button variant="primary" onClick={() => void start()} loading={busy} icon={<ShieldCheck size={13} />}>Turn on</Button>
      )}

      {!enabled && setup && (
        <div className="space-y-4">
          <ol className="list-decimal pl-5 space-y-2 text-sm text-[#233B50]">
            <li>Open your authenticator app and choose <strong>Add account</strong> → <strong>Enter a setup key</strong> (time-based).</li>
            <li>
              Type this key:
              <code className="mt-1.5 block w-fit rounded-lg bg-[#F2F7FB] border border-[#D3E3F0] px-3 py-2 font-mono text-[15px] tracking-wider text-[#0B2A44] select-all break-all">{setup.secret}</code>
              <a href={setup.uri} className="mt-1.5 inline-flex items-center gap-1.5 text-xs font-semibold text-[#0B6BB0] underline min-h-[32px]"><Smartphone size={13} />On this phone? Open in authenticator app</a>
            </li>
            <li>Enter the 6-digit code the app shows:</li>
          </ol>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs font-semibold text-[#233B50]">
              Code
              <input className={inputCls + ' w-40 tracking-[0.3em] text-base'} inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value.replace(/[^0-9 ]/g, ''))} placeholder="123 456" />
            </label>
            <Button variant="primary" onClick={() => void confirm()} loading={busy} disabled={code.replace(/\s/g, '').length !== 6}>Confirm and turn on</Button>
            <Button variant="ghost" onClick={() => { setSetup(null); setCode(''); setError(null); }} disabled={busy}>Cancel</Button>
          </div>
          <p className="text-xs text-[#5E778C]">Lost your phone later? An administrator can reset your password, which also turns two-step sign-in off so you can set it up again.</p>
        </div>
      )}

      {enabled && !turningOff && (
        <Button variant="secondary" onClick={() => setTurningOff(true)} icon={<ShieldOff size={13} />}>Turn off</Button>
      )}
      {enabled && turningOff && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs font-semibold text-[#233B50]">
            Your password
            <input type="password" className={inputCls + ' w-56'} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </label>
          <Button variant="danger" onClick={() => void turnOff()} loading={busy} disabled={!password}>Turn off two-step sign-in</Button>
          <Button variant="ghost" onClick={() => { setTurningOff(false); setPassword(''); setError(null); }} disabled={busy}>Cancel</Button>
        </div>
      )}
    </Card>
  );
};
