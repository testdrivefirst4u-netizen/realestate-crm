'use client';

import { useMemo, useState, type FormEvent } from 'react';
import { CalendarCheck, Check, Clock, Loader2, MapPin } from 'lucide-react';

interface Slot { at: string; label: string; left: number }
interface Day { date: string; slots: Slot[] }
interface Initial {
  company: { name: string; tagline: string; logo: string };
  location: string;
  instructions: string;
  slotMinutes: number;
  days: Day[];
}

/** "Thu 8 Oct" from a yyyy-mm-dd key (read at UTC noon, so server and browser agree). */
const dayLabel = (key: string, part: 'weekday' | 'date') => {
  const d = new Date(`${key}T12:00:00Z`);
  return part === 'weekday'
    ? new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(d)
    : new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
};
const longWhen = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' }).format(new Date(iso));

const field = 'w-full h-12 px-3.5 rounded-[10px] border border-[#C9BEB2] bg-white text-[15px] text-[#3D3530] placeholder:text-[#A39990] focus:outline-none focus:ring-2 focus:ring-[#A9825A] focus:border-[#A9825A]';

export function BookingClient({ slug, initial }: { slug: string; initial: Initial }) {
  const [days, setDays] = useState<Day[]>(initial.days);
  const open = useMemo(() => days.filter((d) => d.slots.some((s) => s.left > 0)), [days]);
  const [dayKey, setDayKey] = useState(open[0]?.date || '');
  const [at, setAt] = useState('');
  const [form, setForm] = useState({ name: '', phone: '', email: '', notes: '', _gotcha: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const day = days.find((d) => d.date === dayKey);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const refresh = async () => {
    try {
      const r = await fetch(`/api/public/visits/${encodeURIComponent(slug)}`, { cache: 'no-store' });
      const b = await r.json();
      if (b?.status === 'success') setDays(b.data.days);
    } catch { /* keep what we have */ }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    if (!at) return setError('Please choose a time.');
    setBusy(true);
    try {
      const r = await fetch(`/api/public/visits/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, at }),
      });
      const b = await r.json().catch(() => null);
      if (b?.status === 'success') {
        setDone(b.data.at || at);
        return;
      }
      setError(b?.message || 'Something went wrong — please try again.');
      if (r.status === 409 || r.status === 400) {
        setAt('');
        await refresh();
      }
    } catch {
      setError('Could not reach the server — check your connection and try again.');
    } finally {
      setBusy(false);
    }
  };

  const { company } = initial;

  return (
    <div className="min-h-screen bg-[#F4F0EB] text-[#3D3530]">
      <header className="bg-[#1D2F3F] text-white">
        <div className="mx-auto flex max-w-4xl items-center gap-3 px-5 py-4">
          {company.logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={company.logo} alt="" className="h-9 w-auto rounded-md bg-white/90 p-1" />
          ) : (
            <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#A9825A] font-bold">{company.name.slice(0, 1)}</span>
          )}
          <div className="leading-tight">
            <div className="font-semibold">{company.name}</div>
            {company.tagline && <div className="text-[12px] text-[#C9D3DC]">{company.tagline}</div>}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-5 py-8 sm:py-10">
        {done ? (
          <section className="mx-auto max-w-lg rounded-2xl bg-white p-8 text-center shadow-[0_8px_30px_rgba(60,48,36,0.08)]">
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[#E3EBDF] text-[#2F5A3A]"><Check size={28} /></div>
            <h1 className="mt-4 text-[26px] font-semibold text-[#1D2F3F]">Your visit is booked</h1>
            <p className="mt-2 text-[16px] text-[#5E534B]">{longWhen(done)}</p>
            {initial.location && <p className="mt-4 flex items-start justify-center gap-2 text-[14px] text-[#5E534B]"><MapPin size={16} className="mt-0.5 flex-none text-[#A9825A]" />{initial.location}</p>}
            {initial.instructions && <p className="mt-3 text-[14px] text-[#5E534B]">{initial.instructions}</p>}
            <p className="mt-5 text-[13px] text-[#8A7F77]">Our team will call you to confirm. Need to change the time? Just reply to our message or call us.</p>
          </section>
        ) : (
          <form onSubmit={submit} className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
            <section aria-labelledby="pick" className="min-w-0 rounded-2xl bg-white p-6 shadow-[0_8px_30px_rgba(60,48,36,0.06)]">
              <h1 id="pick" className="text-[26px] font-semibold leading-tight text-[#1D2F3F]">Book a site visit</h1>
              <p className="mt-1 flex items-center gap-1.5 text-[14px] text-[#5E534B]"><Clock size={15} className="text-[#A9825A]" /> About {initial.slotMinutes} minutes · our team will show you around</p>
              {initial.location && <p className="mt-1 flex items-start gap-1.5 text-[14px] text-[#5E534B]"><MapPin size={15} className="mt-0.5 flex-none text-[#A9825A]" /> {initial.location}</p>}

              {open.length === 0 ? (
                <p className="mt-6 rounded-xl bg-[#FAF7F2] p-4 text-[14px] text-[#5E534B]">All visit times are booked for now. Please call us or check again tomorrow.</p>
              ) : (
                <>
                  <h2 className="mt-6 text-[13px] font-semibold uppercase tracking-[0.12em] text-[#8A6942]">Choose a day</h2>
                  <div role="radiogroup" aria-label="Day" className="mt-2 flex gap-2 overflow-x-auto pb-1">
                    {open.map((d) => {
                      const on = d.date === dayKey;
                      return (
                        <button key={d.date} type="button" role="radio" aria-checked={on} onClick={() => { setDayKey(d.date); setAt(''); }}
                          className={`flex min-w-[68px] flex-col items-center rounded-xl border px-3 py-2.5 ${on ? 'border-[#1D2F3F] bg-[#1D2F3F] text-white' : 'border-[#E4DCD2] bg-white text-[#3D3530] hover:border-[#A9825A]'}`}>
                          <span className={`text-[12px] ${on ? 'text-[#C9D3DC]' : 'text-[#8A7F77]'}`}>{dayLabel(d.date, 'weekday')}</span>
                          <span className="whitespace-nowrap text-[15px] font-semibold">{dayLabel(d.date, 'date')}</span>
                        </button>
                      );
                    })}
                  </div>

                  <h2 className="mt-6 text-[13px] font-semibold uppercase tracking-[0.12em] text-[#8A6942]">Choose a time</h2>
                  <div role="radiogroup" aria-label="Time" className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {(day?.slots || []).map((s) => {
                      const on = s.at === at;
                      const full = s.left <= 0;
                      return (
                        <button key={s.at} type="button" role="radio" aria-checked={on} disabled={full} onClick={() => setAt(s.at)}
                          className={`h-12 rounded-xl border text-[15px] font-medium ${full ? 'cursor-not-allowed border-[#EFE8DF] bg-[#FAF7F2] text-[#B9AFA6] line-through' : on ? 'border-[#A9825A] bg-[#A9825A] text-white' : 'border-[#E4DCD2] bg-white hover:border-[#A9825A]'}`}>
                          {s.label}
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
            </section>

            <section aria-labelledby="you" className="min-w-0 rounded-2xl bg-white p-6 shadow-[0_8px_30px_rgba(60,48,36,0.06)]">
              <h2 id="you" className="text-[18px] font-semibold text-[#1D2F3F]">Your details</h2>
              <div className="mt-4 flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-sm font-medium">Name<input className={field} required autoComplete="name" value={form.name} onChange={set('name')} /></label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">Phone<input className={field} required type="tel" autoComplete="tel" inputMode="tel" placeholder="10-digit mobile number" value={form.phone} onChange={set('phone')} /></label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">E-mail <span className="font-normal text-[#8A7F77]">(optional)</span><input className={field} type="email" autoComplete="email" value={form.email} onChange={set('email')} /></label>
                <label className="flex flex-col gap-1.5 text-sm font-medium">Anything we should know? <span className="font-normal text-[#8A7F77]">(optional)</span>
                  <textarea className={field + ' h-20 py-2.5'} maxLength={500} value={form.notes} onChange={set('notes')} placeholder="e.g. coming with parents, interested in 2.5 BHK" />
                </label>
                <input type="text" name="_gotcha" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" value={form._gotcha} onChange={set('_gotcha')} />
                {at && <p className="flex items-center gap-2 rounded-xl bg-[#FAF7F2] px-3 py-2.5 text-[14px] text-[#1D2F3F]"><CalendarCheck size={16} className="text-[#A9825A]" /> {longWhen(at)}</p>}
                {error && <p role="alert" className="rounded-xl border border-[#F1C9B6] bg-[#FFF7F2] px-3 py-2.5 text-[14px] text-[#8A2E0E]">{error}</p>}
                <button type="submit" disabled={busy || open.length === 0}
                  className="flex h-[50px] items-center justify-center gap-2 rounded-[10px] bg-[#7A5B37] text-base font-semibold text-white hover:bg-[#6A4E2F] disabled:opacity-60">
                  {busy && <Loader2 size={18} className="animate-spin" />} {busy ? 'Booking…' : 'Book my visit'}
                </button>
              </div>
            </section>
          </form>
        )}
      </main>
    </div>
  );
}
