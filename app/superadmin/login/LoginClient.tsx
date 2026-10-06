'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Building2, Layers, ShieldCheck } from 'lucide-react';
import { call, errorMessage } from '../_lib/api';
import { EMAIL_RE } from '../_lib/format';
import { Button, ErrorBox, Spinner, TextField } from '../_components/ui';

type Status = { setupRequired: boolean; setupTokenRequired: boolean; platformName: string };
const MIN = 12;

function safeNext(): string {
  if (typeof window === 'undefined') return '/superadmin';
  const n = new URLSearchParams(window.location.search).get('next') || '';
  return n.startsWith('/superadmin') && !n.startsWith('//') && !n.startsWith('/superadmin/login') ? n : '/superadmin';
}

export function LoginClient() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoadError('');
    call('saStatus', {}).then(
      (s) => alive && setStatus(s),
      (e) => alive && setLoadError(errorMessage(e)),
    );
    return () => {
      alive = false;
    };
  }, [attempt]);

  const done = () => router.replace(safeNext());
  const platformName = status?.platformName || 'Amaya Platform';

  return (
    <div className="flex min-h-screen">
      {/* Brand panel */}
      <aside className="relative hidden w-[44%] max-w-xl flex-col justify-between overflow-hidden bg-[#1D2F3F] p-10 text-white lg:flex">
        <div aria-hidden className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[#A9825A]/20 blur-2xl" />
        <div aria-hidden className="absolute -bottom-32 -left-20 h-80 w-80 rounded-full bg-white/5 blur-2xl" />
        <div className="relative flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#A9825A] text-[16px] font-bold">A</div>
          <p className="text-[16px] font-semibold">{platformName}</p>
        </div>
        <div className="relative">
          <p className="text-[12.5px] font-medium uppercase tracking-[0.18em] text-[#D4B28C]">Super Admin console</p>
          <h2 className="mt-3 text-[2rem] leading-tight text-white">Run every company workspace from one place.</h2>
          <ul className="mt-8 space-y-4 text-[14.5px] text-[#C9D3DC]">
            <li className="flex items-center gap-3">
              <Building2 className="h-5 w-5 text-[#D4B28C]" aria-hidden /> Provision companies and their first administrators
            </li>
            <li className="flex items-center gap-3">
              <Layers className="h-5 w-5 text-[#D4B28C]" aria-hidden /> Manage plans, seats and feature access
            </li>
            <li className="flex items-center gap-3">
              <ShieldCheck className="h-5 w-5 text-[#D4B28C]" aria-hidden /> Every action is recorded in the audit log
            </li>
          </ul>
        </div>
        <p className="relative text-[12.5px] text-[#7F909F]">Restricted area — authorised platform staff only.</p>
      </aside>

      {/* Form panel */}
      <main className="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
        <div className="w-full max-w-md">
          <div className="mb-8 flex items-center gap-3 lg:hidden">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#1D2F3F] text-[16px] font-bold text-white">A</div>
            <div className="leading-tight">
              <p className="text-[16px] font-semibold text-[#14202B]">{platformName}</p>
              <p className="text-[12px] uppercase tracking-[0.14em] text-[#A9825A]">Super Admin</p>
            </div>
          </div>
          <div className="rounded-2xl border border-[#E4DCD2] bg-white p-6 shadow-[0_8px_30px_rgba(29,47,63,0.06)] sm:p-8">
            {loadError ? (
              <ErrorBox message={loadError} onRetry={() => setAttempt((a) => a + 1)} />
            ) : !status ? (
              <Spinner />
            ) : status.setupRequired ? (
              <SetupForm tokenRequired={status.setupTokenRequired} platformName={platformName} onDone={done} />
            ) : (
              <SignInForm platformName={platformName} onDone={done} />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

function SignInForm({ platformName, onDone }: { platformName: string; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!EMAIL_RE.test(email.trim()) || !password) return;
    setBusy(true);
    setError('');
    try {
      await call('saLogin', { email: email.trim(), password });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5">
      <div>
        <h1 className="text-[1.4rem]">Sign in</h1>
        <p className="mt-1 text-[14px] text-[#6B6158]">to the {platformName} super admin console.</p>
      </div>
      <TextField
        label="E-mail"
        type="email"
        autoComplete="username"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
        error={touched && !EMAIL_RE.test(email.trim()) ? 'Enter a valid e-mail address.' : ''}
      />
      <TextField
        label="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
        error={touched && !password ? 'Enter your password.' : ''}
      />
      <ErrorBox message={error} />
      <Button type="submit" loading={busy} className="w-full">
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}

function SetupForm({ tokenRequired, platformName, onDone }: { tokenRequired: boolean; platformName: string; onDone: () => void }) {
  const [f, setF] = useState({ name: '', email: '', password: '', confirm: '', token: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [touched, setTouched] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));

  const errs = {
    name: !f.name.trim() ? 'Enter your name.' : '',
    email: !EMAIL_RE.test(f.email.trim()) ? 'Enter a valid e-mail address.' : '',
    password: f.password.length < MIN ? `Use at least ${MIN} characters.` : '',
    confirm: f.confirm !== f.password ? 'Passwords do not match.' : '',
    token: tokenRequired && !f.token.trim() ? 'Enter the setup token.' : '',
  };
  const show = (k: keyof typeof errs) => (touched ? errs[k] : '');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (Object.values(errs).some(Boolean)) return;
    setBusy(true);
    setError('');
    try {
      await call('saSetup', {
        name: f.name.trim(),
        email: f.email.trim(),
        password: f.password,
        ...(tokenRequired ? { setupToken: f.token.trim() } : {}),
      });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      <div>
        <p className="text-[12.5px] font-medium uppercase tracking-[0.14em] text-[#A9825A]">First-time setup</p>
        <h1 className="mt-1 text-[1.4rem]">Create the first super admin</h1>
        <p className="mt-1 text-[14px] text-[#6B6158]">This account will have full control of {platformName}. You can add more super admins later.</p>
      </div>
      <TextField label="Full name" autoComplete="name" autoFocus value={f.name} onChange={set('name')} required error={show('name')} />
      <TextField label="E-mail" type="email" autoComplete="username" value={f.email} onChange={set('email')} required error={show('email')} />
      <TextField label="Password" type="password" autoComplete="new-password" value={f.password} onChange={set('password')} required error={show('password')} hint={`At least ${MIN} characters.`} />
      <TextField label="Confirm password" type="password" autoComplete="new-password" value={f.confirm} onChange={set('confirm')} required error={show('confirm')} />
      {tokenRequired && (
        <TextField
          label="Setup token"
          autoComplete="off"
          spellCheck={false}
          value={f.token}
          onChange={set('token')}
          required
          error={show('token')}
          hint="The one-time setup token configured on the server."
        />
      )}
      <ErrorBox message={error} />
      <Button type="submit" variant="accent" loading={busy} className="w-full">
        Create super admin &amp; sign in
      </Button>
    </form>
  );
}
