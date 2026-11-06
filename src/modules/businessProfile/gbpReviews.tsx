/**
 * Business Profile › Reviews (server: modules/businessReviews.ts): the location's reviews, filtered and sorted, with replies
 * written, changed and deleted here. A reply is public on Google. Customers write the reviews, so none can be added or deleted.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCw, Star } from 'lucide-react';
import { api, type BusinessReview } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, InlineNotice, cx, inputCls } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const ORDERS = [{ id: 'updateTime desc', label: 'Newest' }, { id: 'rating desc', label: 'Highest rating' }, { id: 'rating', label: 'Lowest rating' }];
const when = (s: string) => (s ? new Date(s).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

const Stars: React.FC<{ n: number; size?: number }> = ({ n, size = 14 }) => (
  <span className="inline-flex" role="img" aria-label={`${n} out of 5 stars`}>
    {[1, 2, 3, 4, 5].map((s) => <Star key={s} size={size} aria-hidden="true" className={s <= Math.round(n) ? 'fill-[#F9AB00] text-[#F9AB00]' : 'text-[#DADCE0]'} />)}
  </span>
);

const ReviewCard: React.FC<{ r: BusinessReview; location: string; canReply: boolean; onChanged: (id: string, reply: string) => void }> = ({ r, location, canReply, onChanged }) => {
  const [text, setText] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const comment = (text || '').trim();
      await api.businessProfile.replyReview(location, r.id, comment);
      onChanged(r.id, comment);
      setText(null);
      toast('Reply sent to Google', 'It can take a little while to appear on your listing.', 'success');
    } catch (e) {
      toast('Reply not sent', errText('gbp.reply', e), 'alert');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!window.confirm('Delete your reply to this review from Google?')) return;
    setBusy(true);
    try {
      await api.businessProfile.deleteReply(location, r.id);
      onChanged(r.id, '');
      toast('Reply deleted', undefined, 'success');
    } catch (e) {
      toast('Reply not deleted', errText('gbp.deleteReply', e), 'alert');
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="p-4">
      <div className="flex items-start gap-3">
        {r.photo ? <img src={r.photo} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-9 w-9 flex-none rounded-full object-cover" /> : <span aria-hidden="true" className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[#E8EAED] text-[13px] font-medium text-[#5F6368]">{r.author[0]?.toUpperCase()}</span>}
        <div className="min-w-0 flex-1">
          <p className="break-words text-[13px] font-medium text-[#202124]">{r.author}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-[#5F6368]"><Stars n={r.stars} />{when(r.updatedAt || r.createdAt)}</p>
          {r.comment ? <p className="mt-1.5 whitespace-pre-line break-words text-[13px] text-[#202124]">{r.comment}</p> : <p className="mt-1.5 text-xs text-[#5F6368]">Rating only, no words.</p>}
          {r.reply && text === null && (
            <div className="mt-2 rounded-lg bg-[#F1F3F4] p-3">
              <p className="text-[11px] font-medium text-[#202124]">Your reply <span className="font-normal text-[#5F6368]">{when(r.repliedAt)}</span></p>
              <p className="mt-0.5 whitespace-pre-line break-words text-[13px] text-[#202124]">{r.reply}</p>
            </div>
          )}
          {text !== null && (
            <div className="mt-2 space-y-2">
              <textarea rows={4} className={inputCls} value={text} aria-label={`Reply to ${r.author}`} onChange={(e) => setText(e.target.value)} />
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="sm" loading={busy} disabled={!text.trim()} onClick={() => void save()}>Send to Google</Button>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => setText(null)}>Cancel</Button>
                <span className="text-[11px] text-[#5F6368]">Everyone can see this on Google.</span>
              </div>
            </div>
          )}
          {canReply && text === null && (
            <div className="mt-2 flex flex-wrap gap-3 text-xs font-medium">
              <button type="button" disabled={busy} className="text-[#1967D2] hover:underline disabled:opacity-40" onClick={() => setText(r.reply)}>{r.reply ? 'Edit reply' : 'Reply'}</button>
              {r.reply && <button type="button" disabled={busy} className="text-[#A50E0E] hover:underline disabled:opacity-40" onClick={() => void remove()}>Delete reply</button>}
            </div>
          )}
        </div>
      </div>
    </li>
  );
};

export const ReviewsTab: React.FC<{ location: string; canReply: boolean }> = ({ location, canReply }) => {
  const [order, setOrder] = useState(ORDERS[0].id);
  const [rows, setRows] = useState<BusinessReview[]>([]);
  const [summary, setSummary] = useState<{ average: number; total: number; next: string } | null>(null);
  const [problem, setProblem] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<'all' | 'open' | number>('all');
  const latest = useRef(0);

  const load = useCallback(async (page = '') => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const r = await api.businessProfile.reviews({ location, order, page: page || undefined });
      if (mine !== latest.current) return;
      setProblem(r.error);
      setRows((old) => (page ? [...old, ...r.reviews] : r.reviews));
      setSummary({ average: r.average, total: r.total, next: r.nextPage });
    } catch (e) {
      if (mine === latest.current) setProblem(errText('gbp.reviews', e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [location, order]);
  useEffect(() => void load(), [load]);

  const changed = useCallback((id: string, reply: string) => setRows((old) => old.map((r) => (r.id === id ? { ...r, reply, repliedAt: reply ? new Date().toISOString() : '' } : r))), []);
  const shown = useMemo(() => rows.filter((r) => (filter === 'all' ? true : filter === 'open' ? !r.reply : r.stars === filter)), [rows, filter]);
  const chip = (id: 'all' | 'open' | number, label: string) => <button key={String(id)} type="button" aria-pressed={filter === id} onClick={() => setFilter(id)} className={cx('rounded-full border px-2.5 py-1 text-xs', filter === id ? 'border-[#1A73E8] bg-[#E8F0FE] font-medium text-[#1967D2]' : 'border-[#DADCE0] text-[#3C4043] hover:bg-[#F1F3F4]')}>{label}</button>;

  return (
    <div className="space-y-3">
      {problem && <InlineNotice tone="warning">{problem}</InlineNotice>}
      {!summary && !problem && <p className="p-6 text-center text-[13px] text-[#5F6368]">Loading…</p>}
      {summary && !problem && (
        <>
          <section className="flex flex-wrap items-center gap-3 rounded-lg border border-[#DADCE0] bg-white p-4">
            <b className="text-[30px] font-normal leading-none text-[#202124]">{summary.average ? summary.average.toFixed(1) : '—'}</b>
            <span><Stars n={summary.average} size={16} /><span className="block text-xs text-[#5F6368]">{summary.total.toLocaleString('en-IN')} review{summary.total === 1 ? '' : 's'} on Google</span></span>
            <span className="ml-auto flex flex-wrap items-center gap-2">
              <select className={cx(inputCls, 'w-auto py-1.5')} value={order} aria-label="Sort reviews" onChange={(e) => setOrder(e.target.value)}>{ORDERS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>
              <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} onClick={() => void load()}>Refresh</Button>
            </span>
          </section>
          <section className="rounded-lg border border-[#DADCE0] bg-white">
            <div className="flex flex-wrap gap-1.5 border-b border-[#E8EAED] p-3">
              {chip('all', 'All')}
              {chip('open', 'Needs a reply')}
              {[5, 4, 3, 2, 1].map((n) => chip(n, `${n} star${n === 1 ? '' : 's'}`))}
            </div>
            {!shown.length ? <p className="p-8 text-center text-[13px] text-[#5F6368]">{rows.length ? 'No reviews match this filter' : 'No reviews yet'}</p> : (
              <ul className="divide-y divide-[#F1F3F4]">{shown.map((r) => <ReviewCard key={r.id} r={r} location={location} canReply={canReply} onChanged={changed} />)}</ul>
            )}
            {summary.next && <div className="border-t border-[#E8EAED] p-3 text-center"><Button variant="secondary" size="sm" loading={loading} onClick={() => void load(summary.next)}>Load more reviews</Button></div>}
          </section>
          <p className="text-[11px] text-[#5F6368]">Filters cover the {rows.length.toLocaleString('en-IN')} reviews loaded so far. Customers write reviews, so they can't be added or deleted here. To report a fake or abusive one, use the Google Maps link at the top of this page.</p>
        </>
      )}
    </div>
  );
};
