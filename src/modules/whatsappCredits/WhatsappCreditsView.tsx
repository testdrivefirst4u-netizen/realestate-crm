/** WhatsApp Credits (plan feature whatsappCredits; server: modules/whatsappCredits.ts): the client's balance, usage and statement. Never Meta's cost or the margin. */
import React, { useCallback, useEffect, useState } from 'react';
import { Download, Wallet } from 'lucide-react';
import { api, type WaCreditsOverview } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { downloadXlsx } from '../../core/xlsx';
import { Button, Card, EmptyState, InlineNotice, LoadingState, cx, inputCls } from '../../components/ui';

const rupees = (n: number) => (n < 0 ? '-' : '') + '₹' + Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TYPE_LABEL: Record<string, string> = { marketing: 'Marketing', utility: 'Utility', authentication: 'Authentication', service: 'Replies' };
const monthName = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayName = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const td = 'px-3 py-2 text-right text-xs tabular-nums whitespace-nowrap border-b border-[#EEF4F9] text-[#0B2A44]';
const first = '!text-left !whitespace-normal';
const thHdr = 'px-3 py-2.5 text-right text-[11px] font-semibold uppercase tracking-wide text-white whitespace-nowrap';
const hdrRow = 'bg-gradient-to-r from-[#0B4E85] to-[#0B6BB0]';

const Tile: React.FC<{ label: string; value: string; hint?: string; tone?: 'warn' | 'bad'; accent?: string }> = ({ label, value, hint, tone, accent = '#0B6BB0' }) => {
  const bar = tone === 'bad' ? '#E11D48' : tone === 'warn' ? '#F59E0B' : accent;
  return (
    <div className="relative overflow-hidden rounded-xl border border-[#E3EDF5] bg-white py-3 pl-4 pr-4 shadow-[0_1px_2px_rgba(11,42,68,.05)]">
      <span aria-hidden className="absolute inset-y-0 left-0 w-[3px] rounded-r" style={{ background: bar }} />
      <p className="text-[11px] font-medium uppercase tracking-wide text-[#8296A6]">{label}</p>
      <p className={cx('mt-0.5 text-xl font-bold tabular-nums', tone === 'bad' ? 'text-[#B42318]' : tone === 'warn' ? 'text-[#B54708]' : 'text-[#0B2A44]')}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-[#5E778C]">{hint}</p>}
    </div>
  );
};

/** Usage day by day: thin bars from one baseline, the exact figure on hover and in the statement below. */
const DayBars: React.FC<{ days: WaCreditsOverview['byDay'] }> = ({ days }) => {
  const top = Math.max(...days.map((d) => d.amount), 0);
  if (!top) return null;
  return (
    <Card title="Used each day">
      <div className="flex h-32 items-end gap-1.5 overflow-x-auto" role="img" aria-label={`Credits used on ${days.length} days. The statement below has every figure.`}>
        {days.map((d) => (
          <div key={d.key} className="group flex h-full min-w-[16px] flex-1 flex-col items-center justify-end" title={`${dayName(d.key)}: ${rupees(d.amount)}, ${d.messages} message${d.messages === 1 ? '' : 's'}`}>
            <div className="w-3.5 rounded-t bg-[#0B6BB0] group-hover:bg-[#095A94] sm:w-5" style={{ height: `${Math.max(2, (d.amount / top) * 100)}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-[#5E778C]"><span>{dayName(days[0].key)}</span><span>Highest: {rupees(top)}</span><span>{dayName(days[days.length - 1].key)}</span></div>
    </Card>
  );
};

export const WhatsappCreditsView: React.FC = () => {
  const [month, setMonth] = useState('');
  const [data, setData] = useState<WaCreditsOverview | null>(null);
  const [failed, setFailed] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await api.whatsappCredits.overview(month || undefined));
      setFailed('');
    } catch (e) {
      setFailed(toAppError(reportError('whatsappCredits.overview', e)).userMessage);
    }
  }, [month]);
  useEffect(() => void load(), [load]);
  if (!data) return failed ? <InlineNotice tone="warning">{failed}</InlineNotice> : <LoadingState label="Loading credits…" />;

  const download = () => downloadXlsx(`WhatsApp_credits_${data.month}.xlsx`, ['Date', 'Details', 'Added', 'Used', 'Balance'], [...data.statement].reverse().map((r) => [r.date, r.details, r.credit || '', r.used || '', r.balance]), 'Statement');

  return (
    <div className="space-y-4 p-4 sm:p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#0B2A44] sm:text-2xl">WhatsApp Credits</h2>
          <p className="mt-0.5 text-xs text-[#5E778C]">1 credit = ₹1. Only delivered messages are charged. Contact BroaddCast to add credits.</p>
        </div>
        <span className="flex flex-wrap items-center gap-2">
          <select aria-label="Month" className={cx(inputCls, '!w-auto')} value={data.month} onChange={(e) => setMonth(e.target.value)}>{data.months.map((m) => <option key={m} value={m}>{monthName(m)}</option>)}</select>
          <Button variant="secondary" size="sm" icon={<Download size={13} />} disabled={!data.statement.length} onClick={download}>Statement</Button>
        </span>
      </div>

      {data.finished ? <InlineNotice tone="warning">Your credits are finished. Paid WhatsApp messages have stopped until BroaddCast adds more.</InlineNotice>
        : data.low ? <InlineNotice tone="warning">Your credits are running low. Contact BroaddCast before they run out.</InlineNotice> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Available" value={rupees(data.available)} hint={data.held > 0 ? `${rupees(data.held)} held for messages on their way` : undefined} tone={data.finished ? 'bad' : data.low ? 'warn' : undefined} />
        <Tile label="Used today" value={rupees(data.usedToday)} accent="#2563EB" />
        <Tile label={`Used in ${monthName(data.month)}`} value={rupees(data.usedMonth)} accent="#B45309" />
        <Tile label={`Added in ${monthName(data.month)}`} value={rupees(data.addedMonth)} accent="#16A34A" />
      </div>

      {!data.statement.length ? <EmptyState icon={<Wallet size={22} />} title="Nothing this month yet" description="Credits added and messages sent will show here." /> : (
        <>
          <DayBars days={data.byDay} />
          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="By type of message">
              <div className="overflow-x-auto rounded-lg border border-[#E3EDF5]"><table className="w-full border-collapse">
                <thead><tr className={hdrRow}><th className={cx(thHdr, first)}>Type</th><th className={thHdr}>Rate</th><th className={thHdr}>Messages</th><th className={thHdr}>Free</th><th className={thHdr}>Amount</th></tr></thead>
                <tbody>{data.byType.map((r) => <tr key={r.key}><td className={cx(td, first)}>{TYPE_LABEL[r.key] || r.key}</td><td className={td}>₹{data.prices[r.key as keyof typeof data.prices] ?? '—'}</td><td className={td}>{r.messages.toLocaleString('en-IN')}</td><td className={td}>{r.free.toLocaleString('en-IN')}</td><td className={td}>{rupees(r.amount)}</td></tr>)}</tbody>
              </table></div>
              <p className="mt-2 text-[11px] text-[#5E778C]">Before GST. Free: WhatsApp's own free messages, like the first 1,000 replies a month.</p>
            </Card>
            <Card title="By template">
              <div className="overflow-x-auto rounded-lg border border-[#E3EDF5]"><table className="w-full border-collapse">
                <thead><tr className={hdrRow}><th className={cx(thHdr, first)}>Template</th><th className={thHdr}>Messages</th><th className={thHdr}>Amount</th></tr></thead>
                <tbody>{data.byTemplate.map((r) => <tr key={r.key}><td className={cx(td, first, 'break-all')}>{r.key}</td><td className={td}>{r.messages.toLocaleString('en-IN')}</td><td className={td}>{rupees(r.amount)}</td></tr>)}</tbody>
              </table></div>
            </Card>
          </div>
          <Card title="Statement">
            <div className="overflow-x-auto rounded-lg border border-[#E3EDF5]"><table className="w-full border-collapse">
              <thead><tr className={hdrRow}><th className={cx(thHdr, first)}>Date</th><th className={cx(thHdr, first)}>Details</th><th className={thHdr}>Added</th><th className={thHdr}>Used</th><th className={thHdr}>Balance</th></tr></thead>
              <tbody>{data.statement.map((r, i) => <tr key={i}><td className={cx(td, '!text-left')}>{dayName(r.date)}</td><td className={cx(td, first)}>{r.details}</td><td className={td}>{r.credit ? rupees(r.credit) : ''}</td><td className={td}>{r.used ? rupees(r.used) : ''}</td><td className={cx(td, 'font-semibold')}>{rupees(r.balance)}</td></tr>)}</tbody>
            </table></div>
          </Card>
        </>
      )}
    </div>
  );
};
