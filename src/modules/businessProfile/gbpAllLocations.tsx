/**
 * All-locations overview for Business Profile — like Google's Business Profile Manager: a Businesses list (store code,
 * name, address, verification status) across every connected location, and a Reviews feed that spans all locations so
 * the whole account can be worked from one screen. Clicking a business opens the existing per-location detail.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, RefreshCw, Search, Send, Star } from 'lucide-react';
import { api, type AllLocationReview, type BusinessLocationRow, type BusinessLocationsView } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, cx, inputCls } from '../../components/ui';

const errText = (s: string, e: unknown) => toAppError(reportError(s, e)).userMessage;
const STATUS: Record<BusinessLocationRow['status'], { label: string; cls: string; dot: string }> = {
  verified: { label: 'Verified', cls: 'bg-[#E6F4EA] text-[#137333]', dot: 'bg-[#1E8E3E]' },
  duplicate: { label: 'Duplicate', cls: 'bg-[#FCE8E6] text-[#C5221F]', dot: 'bg-[#D93025]' },
  unverified: { label: 'Verification required', cls: 'bg-[#FEF7E0] text-[#8A5A00]', dot: 'bg-[#F9AB00]' },
  unknown: { label: 'Unknown', cls: 'bg-[#F1F3F4] text-[#5F6368]', dot: 'bg-[#9AA0A6]' },
};
const timeAgo = (iso: string) => {
  const d = new Date(iso).getTime(); if (!d) return '';
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 2592000) return `${Math.round(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};
const Stars: React.FC<{ n: number }> = ({ n }) => (
  <span className="inline-flex" aria-label={`${n} stars`}>{[1, 2, 3, 4, 5].map((i) => <Star key={i} size={13} className={i <= n ? 'fill-[#FBBC04] text-[#FBBC04]' : 'fill-[#E8EAED] text-[#E8EAED]'} />)}</span>
);

/* ------------------------------ Businesses ------------------------------ */

const BusinessesList: React.FC<{ data: BusinessLocationsView; onOpen: (name: string) => void }> = ({ data, onOpen }) => {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | BusinessLocationRow['status']>('all');
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return data.locations.filter((l) => (status === 'all' || l.status === status) && (!term || l.title.toLowerCase().includes(term) || l.storeCode.toLowerCase().includes(term) || l.address.toLowerCase().includes(term)));
  }, [data.locations, q, status]);
  const pctVerified = data.total ? Math.round((data.verified / data.total) * 100) : 0;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#E3E6EA] bg-white px-4 py-3">
        <span className="text-[15px] font-semibold text-[#202124]">{data.total} {data.total === 1 ? 'business' : 'businesses'}</span>
        <span className="flex min-w-[160px] flex-1 items-center gap-2">
          <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-[#E8EAED]"><span className="block h-full rounded-full bg-[#1E8E3E]" style={{ width: `${pctVerified}%` }} /></span>
          <span className="whitespace-nowrap text-[12.5px] font-medium text-[#5F6368]">{pctVerified}% verified</span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span className="relative min-w-[200px] flex-1">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#80868B]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, store code or address" className={cx(inputCls, 'w-full pl-9')} />
        </span>
        <select value={status} onChange={(e) => setStatus(e.target.value as any)} className={cx(inputCls, 'w-auto')} aria-label="Status">
          <option value="all">All statuses</option>
          <option value="verified">Verified</option>
          <option value="unverified">Verification required</option>
          <option value="duplicate">Duplicate</option>
        </select>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[#E3E6EA] bg-white">
        <table className="w-full min-w-[640px] text-[13.5px]">
          <thead>
            <tr className="border-b border-[#E3E6EA] text-left text-[11.5px] font-semibold uppercase tracking-wide text-[#5F6368]">
              <th className="px-4 py-3">Store code</th>
              <th className="px-4 py-3">Business</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows.map((l) => {
              const s = STATUS[l.status];
              return (
                <tr key={l.name} onClick={() => onOpen(l.name)} className="cursor-pointer border-b border-[#F1F3F4] last:border-0 hover:bg-[#F8F9FA]">
                  <td className="px-4 py-3 align-top font-mono text-[12px] text-[#5F6368]">{l.storeCode || '—'}</td>
                  <td className="px-4 py-3 align-top">
                    <div className="font-semibold text-[#202124]">{l.title}</div>
                    {l.address && <div className="mt-0.5 max-w-[420px] text-[12.5px] text-[#5F6368]">{l.address}</div>}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[12px] font-semibold', s.cls)}><span className={cx('h-1.5 w-1.5 rounded-full', s.dot)} />{s.label}</span>
                  </td>
                  <td className="px-4 py-3 align-top text-right">
                    <span className="inline-flex items-center gap-1 whitespace-nowrap text-[12.5px] font-semibold text-[#1967D2]">Open <ChevronRight size={14} /></span>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={4} className="px-4 py-10 text-center text-[13px] text-[#5F6368]">No businesses match your search.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
};

/* -------------------------------- Reviews ------------------------------- */

const ReviewRow: React.FC<{ r: AllLocationReview; canReply: boolean; onReplied: () => void }> = ({ r, canReply, onReplied }) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(r.reply || '');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try { await api.businessProfile.replyReview(r.location, r.id, text.trim()); toast('Reply posted', undefined, 'success'); setOpen(false); onReplied(); }
    catch (e) { toast('Could not reply', errText('gbp.allReviews.reply', e), 'alert'); }
    finally { setBusy(false); }
  };
  return (
    <div className="rounded-xl border border-[#E3E6EA] bg-white p-4">
      <div className="mb-1.5 flex flex-wrap items-center justify-between gap-1">
        <span className="text-[13px] font-semibold text-[#202124]">{r.locationTitle}</span>
        <span className="font-mono text-[11px] text-[#80868B]">{r.storeCode || ''}</span>
      </div>
      <div className="flex items-start gap-3">
        {r.photo ? <img src={r.photo} alt="" className="h-8 w-8 flex-none rounded-full object-cover" /> : <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-[#E8F0FE] text-[12px] font-bold text-[#1967D2]">{(r.author[0] || '?').toUpperCase()}</span>}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13.5px] font-medium text-[#202124]">{r.author}</span>
            <Stars n={r.stars} />
            <span className="text-[12px] text-[#80868B]">{timeAgo(r.updatedAt || r.createdAt)}</span>
            {!r.reply && <span className="rounded-full bg-[#FEF7E0] px-2 py-0.5 text-[11px] font-semibold text-[#8A5A00]">Needs reply</span>}
          </div>
          {r.comment ? <p className="mt-1 whitespace-pre-wrap text-[13.5px] text-[#3C4043]">{r.comment}</p> : <p className="mt-1 text-[13px] italic text-[#80868B]">No written comment.</p>}
          {r.reply && !open && (
            <div className="mt-2 rounded-lg bg-[#F8F9FA] p-2.5 text-[13px] text-[#3C4043]"><span className="text-[11px] font-semibold uppercase tracking-wide text-[#5F6368]">Your reply</span><p className="mt-0.5 whitespace-pre-wrap">{r.reply}</p></div>
          )}
          {canReply && (open || !r.reply) && (
            <div className="mt-2">
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Write a public reply…" className={cx(inputCls, 'w-full resize-y')} />
              <div className="mt-1.5 flex gap-2">
                <Button size="sm" variant="primary" icon={<Send size={13} />} loading={busy} onClick={() => void send()}>{r.reply ? 'Update reply' : 'Reply'}</Button>
                {open && <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>}
              </div>
            </div>
          )}
          {canReply && r.reply && !open && <button type="button" onClick={() => setOpen(true)} className="mt-1.5 text-[12.5px] font-semibold text-[#1967D2] hover:underline">Edit reply</button>}
        </div>
      </div>
    </div>
  );
};

const AllReviewsFeed: React.FC<{ canReply: boolean }> = ({ canReply }) => {
  const [data, setData] = useState<{ reviews: AllLocationReview[]; scanned: number; locations: number; unansweredTotal: number } | null>(null);
  const [unansweredOnly, setUnansweredOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState('');
  const latest = useRef(0);
  const load = useCallback(async (unanswered: boolean) => {
    const mine = ++latest.current;
    setLoading(true); setFailed('');
    try { const r = await api.businessProfile.allReviews({ unansweredOnly: unanswered }); if (mine === latest.current) setData(r); }
    catch (e) { if (mine === latest.current) setFailed(errText('gbp.allReviews', e)); }
    finally { if (mine === latest.current) setLoading(false); }
  }, []);
  useEffect(() => { void load(unansweredOnly); }, [load, unansweredOnly]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[13px] font-medium text-[#3C4043]">
          <input type="checkbox" checked={unansweredOnly} onChange={(e) => setUnansweredOnly(e.target.checked)} className="h-4 w-4 rounded border-[#C4D6E6] text-[#1A73E8]" />
          Needs reply only{data ? ` (${data.unansweredTotal})` : ''}
        </label>
        <span className="text-[12.5px] text-[#5F6368]">{data ? `Reviewing ${data.scanned} of ${data.locations} locations` : ''}</span>
        <Button size="sm" variant="secondary" className="ml-auto" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} disabled={loading} onClick={() => void load(unansweredOnly)}>Refresh</Button>
      </div>
      {failed && <div className="rounded-lg bg-[#FCE8E6] px-3 py-2 text-[13px] text-[#C5221F]">{failed}</div>}
      {loading && !data && <p className="py-10 text-center text-[13px] text-[#5F6368]">Reading reviews from every location… this can take a moment.</p>}
      {data && data.reviews.length === 0 && !loading && <p className="py-10 text-center text-[13px] text-[#5F6368]">{unansweredOnly ? 'No reviews are waiting for a reply.' : 'No reviews found.'}</p>}
      <div className="space-y-2.5">
        {data?.reviews.map((r) => <ReviewRow key={`${r.location}:${r.id}`} r={r} canReply={canReply} onReplied={() => void load(unansweredOnly)} />)}
      </div>
    </div>
  );
};

/* ------------------------------- Overview ------------------------------- */

export const LocationsOverview: React.FC<{ data: BusinessLocationsView; loading: boolean; onOpen: (name: string) => void; onRefresh: () => void; canReply: boolean }> = ({ data, loading, onOpen, onRefresh, canReply }) => {
  const [tab, setTab] = useState<'businesses' | 'reviews'>('businesses');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="All locations" className="flex rounded-lg border border-[#DADCE0] bg-white p-0.5">
          {(['businesses', 'reviews'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx('rounded-md px-3.5 py-1.5 text-[13px] font-semibold capitalize', tab === t ? 'bg-[#1A73E8] text-white' : 'text-[#5F6368] hover:bg-[#F1F3F4]')}>{t}</button>
          ))}
        </div>
        <Button size="sm" variant="secondary" className="ml-auto" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} disabled={loading} onClick={onRefresh}>Refresh from Google</Button>
      </div>
      {tab === 'businesses' ? <BusinessesList data={data} onOpen={onOpen} /> : <AllReviewsFeed canReply={canReply} />}
    </div>
  );
};
