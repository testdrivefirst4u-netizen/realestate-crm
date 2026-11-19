/**
 * Presentational, server-rendered Client Report — the no-login public page (/r/<slug>/<token>) renders this from the
 * stored report figures (server/modules/clientReport.ts → ClientReportData). No interactivity, no session; print-friendly.
 */
import type { ClientReportData } from '@/server/modules/clientReport';

const nf = (n: number) => Math.round(n).toLocaleString('en-IN');
const inr = (n: number) => `₹${nf(n)}`;
const pct = (cur: number, prev: number): number | null => (prev ? Math.round(((cur - prev) / prev) * 100) : cur ? null : 0);

function Delta({ v, suffix = '%' }: { v: number | null; suffix?: string }) {
  if (v === null) return <span className="text-[#0B6BB0]">new</span>;
  return <span className={v > 0 ? 'font-semibold text-emerald-600' : v < 0 ? 'font-semibold text-[#B06A55]' : 'font-semibold text-[#8296A6]'}>{v > 0 ? '▲' : v < 0 ? '▼' : '•'} {Math.abs(v)}{suffix}</span>;
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[#EEF3F7] bg-white p-3.5">
      <div className="text-[22px] font-bold tabular-nums text-[#0B2A44]">{value}</div>
      <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-wide text-[#8296A6]">{label}</div>
      {sub != null && <div className="mt-1 text-[11px]">{sub}</div>}
    </div>
  );
}

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="break-inside-avoid rounded-2xl border border-[#D3E3F0] bg-white p-5">
      <div className="mb-3 flex items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-bold text-[#0B2A44]">{title}</h2>
        {hint && <span className="text-[11px] text-[#8296A6]">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

export function ReportDocument({ r }: { r: ClientReportData }) {
  const eng = r.engagement;
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      {/* header */}
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-[#D3E3F0] bg-white p-5">
        <div className="flex h-14 w-14 flex-none items-center justify-center overflow-hidden rounded-xl bg-[#F2F7FB]">
          {r.company.logo ? <img src={r.company.logo} alt="" className="max-h-full max-w-full object-contain p-1" /> : <span className="text-lg font-bold text-[#0B6BB0]">{(r.company.name || 'C')[0]}</span>}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-bold tracking-tight text-[#0B2A44]">{r.company.name}</h1>
          <p className="text-sm text-[#5E778C]">Marketing Report · <b>{r.monthLabel}</b></p>
        </div>
        <div className="text-right text-[11px] text-[#8296A6]">Prepared {new Date(r.preparedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</div>
      </div>

      {/* headline */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Tile label="Ad spend" value={inr(r.spend.total)} sub={<Delta v={pct(r.spend.total, r.spend.totalPrev)} />} />
        <Tile label="Leads" value={nf(r.leads.total)} sub={<Delta v={pct(r.leads.total, r.leads.totalPrev)} />} />
        <Tile label="Bookings" value={nf(r.leads.booked)} sub={<Delta v={pct(r.leads.booked, r.leads.bookedPrev)} />} />
        <Tile label="Follower growth" value={r.audience.netGrowth != null ? `${r.audience.netGrowth >= 0 ? '+' : ''}${nf(r.audience.netGrowth)}` : '—'} sub={<span className="text-[#8296A6]">this month</span>} />
      </div>

      {/* paid */}
      <Card title="Paid advertising — Meta & Google" hint={r.monthLabel}>
        <div className="grid grid-cols-3 gap-2.5">
          <Tile label="Total spend" value={inr(r.spend.total)} sub={<Delta v={pct(r.spend.total, r.spend.totalPrev)} />} />
          <Tile label="Meta" value={inr(r.spend.meta)} sub={<span className="text-[#8296A6]">{nf(r.spend.metaCampaigns)} campaigns</span>} />
          <Tile label="Google" value={inr(r.spend.google)} sub={<span className="text-[#8296A6]">{nf(r.spend.googleCampaigns)} campaigns</span>} />
        </div>
        {r.spend.top.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead><tr className="border-b border-[#EEF3F7] text-left text-[11px] font-bold uppercase tracking-wide text-[#8296A6]"><th className="py-2">Campaign</th><th className="py-2">Platform</th><th className="py-2 text-right">Spend</th></tr></thead>
              <tbody>
                {r.spend.top.map((c, i) => (<tr key={i} className="border-b border-[#F3F7FA] last:border-0"><td className="py-2 font-medium text-[#0B2A44]">{c.campaign}</td><td className="py-2 capitalize text-[#5E778C]">{c.source || '—'}</td><td className="py-2 text-right font-semibold tabular-nums text-[#0B2A44]">{inr(c.amount)}</td></tr>))}
              </tbody>
            </table>
          </div>
        )}
        {r.leads.costPerLead != null && <p className="mt-2 text-[11px] text-[#8296A6]">Cost per lead this month: <b className="text-[#0B2A44]">{inr(r.leads.costPerLead)}</b></p>}
      </Card>

      {/* content & engagement */}
      <Card title="Content & engagement" hint={r.monthLabel}>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {([['Posts', eng.posts, eng.prev.posts], ['Likes', eng.likes, eng.prev.likes], ['Comments', eng.comments, eng.prev.comments], ['Shares', eng.shares, eng.prev.shares]] as Array<[string, number, number]>).map(([label, c, p]) => (
            <Tile key={label} label={label} value={nf(c)} sub={<Delta v={pct(c, p)} />} />
          ))}
        </div>
        {eng.top.length > 0 && (
          <>
            <p className="mb-2 mt-4 text-[11px] font-bold uppercase tracking-wide text-[#8296A6]">Top posts</p>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {eng.top.map((p) => (
                <div key={p.id} className="overflow-hidden rounded-lg border border-[#EEF3F7]">
                  {p.imageUrl ? <img src={p.imageUrl} alt="" className="aspect-video w-full object-cover" /> : <div className="aspect-video w-full bg-[#F2F7FB]" />}
                  <div className="p-2"><p className="line-clamp-2 text-[11px] text-[#44505C]">{p.text || 'No caption'}</p><p className="mt-1 text-[11px] font-semibold text-[#0B2A44]">♥ {nf(p.likes)} · 💬 {nf(p.comments)}</p></div>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* leads & bookings */}
      <Card title="Leads & bookings" hint={r.monthLabel}>
        <div className="grid grid-cols-3 gap-2.5">
          <Tile label="New leads" value={nf(r.leads.total)} sub={<Delta v={pct(r.leads.total, r.leads.totalPrev)} />} />
          <Tile label="Bookings" value={nf(r.leads.booked)} sub={<Delta v={pct(r.leads.booked, r.leads.bookedPrev)} />} />
          <Tile label="Conversion" value={`${r.leads.total ? Math.round((r.leads.booked / r.leads.total) * 100) : 0}%`} />
        </div>
        {r.leads.bySource.length > 0 && (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[360px] text-sm">
              <thead><tr className="border-b border-[#EEF3F7] text-left text-[11px] font-bold uppercase tracking-wide text-[#8296A6]"><th className="py-2">Source</th><th className="py-2 text-right">Leads</th><th className="py-2 text-right">Bookings</th></tr></thead>
              <tbody>
                {r.leads.bySource.map((s) => (<tr key={s.source} className="border-b border-[#F3F7FA] last:border-0"><td className="py-2 font-medium text-[#0B2A44]">{s.source}</td><td className="py-2 text-right tabular-nums">{nf(s.n)}</td><td className="py-2 text-right font-semibold tabular-nums text-[#067647]">{nf(s.booked)}</td></tr>))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* audience */}
      {r.audience.accounts.length > 0 && (
        <Card title="Audience" hint="Followers per connected account">
          <div className="grid gap-2 sm:grid-cols-2">
            {r.audience.accounts.map((a) => (
              <div key={a.key} className="flex items-center justify-between rounded-lg border border-[#EEF3F7] px-3 py-2.5">
                <span className="text-sm font-semibold capitalize text-[#0B2A44]">{a.name} <span className="font-normal text-[#8296A6]">· {a.kind}</span></span>
                <span className="flex items-baseline gap-2">
                  {a.delta != null && <span className={a.delta > 0 ? 'text-[11px] font-semibold text-emerald-600' : a.delta < 0 ? 'text-[11px] font-semibold text-[#B06A55]' : 'text-[11px] font-semibold text-[#8296A6]'}>{a.delta > 0 ? '▲ +' : a.delta < 0 ? '▼ ' : '• '}{nf(a.delta)}</span>}
                  <span className="text-lg font-bold tabular-nums text-[#0B2A44]">{a.followers != null ? nf(a.followers) : '—'}</span>
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      <p className="pt-1 text-center text-[11px] text-[#8296A6]">Prepared by {r.company.name} · Figures are for {r.monthLabel}.</p>
    </div>
  );
}
