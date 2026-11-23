/**
 * All-locations overview for Business Profile — like Google's Business Profile Manager: a Businesses list (store code,
 * name, address, verification status) across every connected location, and a Reviews feed that spans all locations so
 * the whole account can be worked from one screen. Clicking a business opens the existing per-location detail.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, ChevronRight, Copy, ExternalLink, ImagePlus, Pencil, RefreshCw, Search, Send, ShieldCheck, Sparkles, Star } from 'lucide-react';
import { api, type AllLocationReview, type BusinessLocationRow, type BusinessLocationsView } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, cx, inputCls } from '../../components/ui';

type DetailTab = 'profile' | 'photos' | 'reviews' | 'performance';
const errText = (s: string, e: unknown) => toAppError(reportError(s, e)).userMessage;
const STATUS: Record<BusinessLocationRow['status'], { label: string; text: string; badge: string; dot: string; rail: string; Icon: typeof ShieldCheck }> = {
  verified: { label: 'Verified', text: 'text-[#188038]', badge: 'bg-[#E6F4EA] text-[#137333]', dot: 'bg-[#1E8E3E]', rail: 'bg-[#1E8E3E]', Icon: ShieldCheck },
  duplicate: { label: 'Duplicate', text: 'text-[#C5221F]', badge: 'bg-[#FCE8E6] text-[#C5221F]', dot: 'bg-[#D93025]', rail: 'bg-[#D93025]', Icon: Copy },
  unverified: { label: 'Verification required', text: 'text-[#B06000]', badge: 'bg-[#FEF7E0] text-[#8A5A00]', dot: 'bg-[#F9AB00]', rail: 'bg-[#F9AB00]', Icon: AlertTriangle },
  unknown: { label: 'Unknown', text: 'text-[#5F6368]', badge: 'bg-[#F1F3F4] text-[#5F6368]', dot: 'bg-[#9AA0A6]', rail: 'bg-[#9AA0A6]', Icon: AlertTriangle },
};
// deterministic brand grouping + avatar colour from the location name's first word
const PAIRS: Array<[string, string]> = [['#5b57eb', '#7a76ff'], ['#0891b2', '#22d3ee'], ['#0b8043', '#34a853'], ['#ea8600', '#fbbf24'], ['#1a73e8', '#4285f4'], ['#9334e6', '#c084fc'], ['#d93025', '#f28b82'], ['#0f766e', '#2dd4bf']];
const hashIdx = (s: string, n: number) => ([...s].reduce((a, c) => a + c.charCodeAt(0), 0)) % n;
const gradOf = (s: string) => { const [a, b] = PAIRS[hashIdx(s, PAIRS.length)]; return `linear-gradient(135deg, ${a}, ${b})`; };
const initials = (s: string) => s.replace(/[^a-zA-Z ]/g, '').trim().split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
const brandOf = (title: string) => (title.replace(/[^a-zA-Z0-9 ]/g, ' ').trim().split(/\s+/)[0] || 'Other');
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

const RatingCell: React.FC<{ r: BusinessLocationRow }> = ({ r }) => (
  r.rating ? (
    <span className="flex items-center gap-1.5 whitespace-nowrap">
      <span className="font-bold tabular-nums text-[#202124]">{r.rating.toFixed(1)}</span>
      <Star size={13} className="fill-[#FBBC04] text-[#FBBC04]" />
      <span className="text-[12px] tabular-nums text-[#80868B]">({r.reviews.toLocaleString('en-IN')})</span>
    </span>
  ) : <span className="text-[12.5px] text-[#80868B]">No reviews yet</span>
);

const BizRow: React.FC<{ l: BusinessLocationRow; onOpen: (name: string, tab?: DetailTab) => void }> = ({ l, onOpen }) => {
  const s = STATUS[l.status];
  const act = (e: React.MouseEvent, tab: DetailTab) => { e.stopPropagation(); onOpen(l.name, tab); };
  return (
    <tr onClick={() => onOpen(l.name)} className="group relative cursor-pointer border-b border-[#EEF1F4] last:border-0 hover:bg-[#F6FAFE]">
      <td className="relative w-0 p-0"><span className={cx('absolute left-0 top-2 bottom-2 w-[3px] rounded-r', s.rail)} /></td>
      <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-[#80868B]">{l.storeCode || '—'}</td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-[10px] text-[13px] font-bold text-white" style={{ backgroundImage: gradOf(brandOf(l.title)) }}>{initials(l.title)}</span>
          <div className="min-w-0">
            <div className="truncate font-medium text-[#202124]">{l.title}</div>
            {l.address && <div className="truncate text-[12.5px] text-[#5F6368]">{l.address}</div>}
          </div>
        </div>
      </td>
      <td className="px-4 py-3"><RatingCell r={l} /></td>
      <td className="px-4 py-3"><span className={cx('inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] font-medium', s.text)}><s.Icon size={16} /> {s.label}</span></td>
      <td className="px-2 py-3">
        <div className="flex items-center justify-center gap-0.5">
          <button type="button" title="Edit details" onClick={(e) => act(e, 'profile')} className="grid h-9 w-9 place-items-center rounded-full text-[#5F6368] hover:bg-[#E8F0FE] hover:text-[#1967D2]"><Pencil size={17} /></button>
          <button type="button" title="Photos" onClick={(e) => act(e, 'photos')} className="grid h-9 w-9 place-items-center rounded-full text-[#5F6368] hover:bg-[#E8F0FE] hover:text-[#1967D2]"><ImagePlus size={17} /></button>
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-[#DADCE0] bg-white px-3 py-1.5 text-[12.5px] font-medium text-[#1967D2] group-hover:border-[#1A73E8] group-hover:bg-[#F6FAFE]">See profile <ExternalLink size={13} /></span>
      </td>
    </tr>
  );
};

const BusinessesList: React.FC<{ data: BusinessLocationsView; onOpen: (name: string, tab?: DetailTab) => void }> = ({ data, onOpen }) => {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | BusinessLocationRow['status']>('all');
  const [groupBy, setGroupBy] = useState<'none' | 'brand' | 'status'>('none');

  const counts = useMemo(() => {
    const c = { all: data.locations.length, verified: 0, unverified: 0, duplicate: 0 } as Record<string, number>;
    for (const l of data.locations) c[l.status] = (c[l.status] || 0) + 1;
    return c;
  }, [data.locations]);
  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return data.locations.filter((l) => (filter === 'all' || l.status === filter) && (!term || l.title.toLowerCase().includes(term) || l.storeCode.toLowerCase().includes(term) || l.address.toLowerCase().includes(term)));
  }, [data.locations, q, filter]);
  const groups = useMemo(() => {
    if (groupBy === 'none') return null;
    const m = new Map<string, BusinessLocationRow[]>();
    for (const l of rows) { const k = groupBy === 'brand' ? brandOf(l.title) : STATUS[l.status].label; (m.get(k) || m.set(k, []).get(k)!).push(l); }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows, groupBy]);
  const pctVerified = data.total ? Math.round((data.verified / data.total) * 100) : 0;

  const FILTERS: Array<{ id: 'all' | BusinessLocationRow['status']; label: string; n: number }> = [
    { id: 'all', label: 'All', n: counts.all },
    { id: 'verified', label: 'Verified', n: counts.verified || 0 },
    { id: 'unverified', label: 'Verification required', n: counts.unverified || 0 },
    { id: 'duplicate', label: 'Duplicate', n: counts.duplicate || 0 },
  ];

  return (
    <div className="space-y-3">
      {/* summary strip */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border border-[#E3E6EA] bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(60,64,67,.08)]">
        <span className="text-[16px] font-medium text-[#202124]"><b className="font-bold tabular-nums">{data.total}</b> businesses</span>
        <span className="flex min-w-[160px] flex-1 items-center gap-2.5">
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-[#E8EAED]"><span className="block h-full rounded-full bg-[#1E8E3E] transition-all" style={{ width: `${pctVerified}%` }} /></span>
          <span className="whitespace-nowrap text-[13px] font-medium text-[#5F6368]"><b className="text-[#202124]">{pctVerified}%</b> verified</span>
        </span>
        <span className="flex gap-5">
          <span className="flex flex-col"><span className="text-[17px] font-bold tabular-nums text-[#1E8E3E]">{data.verified}</span><span className="text-[10.5px] font-medium uppercase tracking-wide text-[#80868B]">Verified</span></span>
          <span className="flex flex-col"><span className="text-[17px] font-bold tabular-nums text-[#E37400]">{data.needsAction}</span><span className="text-[10.5px] font-medium uppercase tracking-wide text-[#80868B]">Need action</span></span>
        </span>
      </div>

      {/* controls */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="relative min-w-[200px] flex-1">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#80868B]" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, store code or address" className={cx(inputCls, 'w-full pl-9')} />
        </span>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value as any)} className={cx(inputCls, 'w-auto')} aria-label="Group by">
          <option value="none">Ungrouped</option>
          <option value="brand">Group by brand</option>
          <option value="status">Group by status</option>
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}
            className={cx('inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[13px] font-medium', filter === f.id ? 'border-transparent bg-[#E8F0FE] text-[#1967D2]' : 'border-[#DADCE0] bg-white text-[#3C4043] hover:bg-[#F6FAFE]')}>
            {f.label} <span className={cx('tabular-nums font-bold', filter === f.id ? 'text-[#1967D2]' : 'text-[#80868B]')}>{f.n}</span>
          </button>
        ))}
      </div>

      {/* table */}
      <div className="overflow-hidden rounded-xl border border-[#E3E6EA] bg-white shadow-[0_1px_2px_rgba(60,64,67,.08)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-[13.5px]">
            <thead>
              <tr className="border-b border-[#E3E6EA] text-left text-[11.5px] font-medium uppercase tracking-wide text-[#5F6368]">
                <th className="w-0 p-0" />
                <th className="px-4 py-3">Store code</th>
                <th className="px-4 py-3">Business</th>
                <th className="px-4 py-3">Rating</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-2 py-3 text-center">Quick actions</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {groups ? groups.map(([name, list]) => {
                const ok = list.filter((x) => x.status === 'verified').length;
                return (
                  <React.Fragment key={name}>
                    <tr className="bg-[#F8F9FA]">
                      <td colSpan={7} className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <span className="text-[12.5px] font-bold uppercase tracking-wide text-[#5F6368]">{name}</span>
                          <span className="text-[12px] text-[#80868B]">{list.length} location{list.length > 1 ? 's' : ''}</span>
                          <span className="ml-auto flex items-center gap-2">
                            <span className="h-1.5 w-16 overflow-hidden rounded-full bg-[#E8EAED]"><span className="block h-full rounded-full bg-[#1E8E3E]" style={{ width: `${Math.round((ok / list.length) * 100)}%` }} /></span>
                            <span className="text-[12px] text-[#80868B]">{ok}/{list.length} verified</span>
                          </span>
                        </div>
                      </td>
                    </tr>
                    {list.map((l) => <BizRow key={l.name} l={l} onOpen={onOpen} />)}
                  </React.Fragment>
                );
              }) : rows.map((l) => <BizRow key={l.name} l={l} onOpen={onOpen} />)}
              {rows.length === 0 && <tr><td colSpan={7} className="px-4 py-12 text-center text-[13px] text-[#5F6368]">No businesses match your search.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

/* -------------------------------- Reviews ------------------------------- */

const ReviewRow: React.FC<{ r: AllLocationReview; canReply: boolean; onReplied: () => void }> = ({ r, canReply, onReplied }) => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(r.reply || '');
  const [busy, setBusy] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const draft = async () => {
    setDrafting(true);
    try { const { reply } = await api.businessProfile.aiDraftReply({ stars: r.stars, comment: r.comment, author: r.author }); setText(reply); }
    catch (e) { toast('Could not draft a reply', errText('gbp.allReviews.aiDraft', e), 'alert'); }
    finally { setDrafting(false); }
  };
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
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="Write a reply, or let AI draft one…" className={cx(inputCls, 'w-full resize-y')} />
              <div className="mt-1.5 flex flex-wrap gap-2">
                <Button size="sm" variant="primary" icon={<Send size={13} />} loading={busy} disabled={drafting} onClick={() => void send()}>{r.reply ? 'Update reply' : 'Reply'}</Button>
                <Button size="sm" variant="secondary" icon={<Sparkles size={13} />} loading={drafting} disabled={busy} onClick={() => void draft()}>Draft with AI</Button>
                {open && <Button size="sm" variant="secondary" disabled={busy || drafting} onClick={() => setOpen(false)}>Cancel</Button>}
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
  const [auto, setAuto] = useState<{ enabled: boolean; minStars: number } | null>(null);
  const [autoBusy, setAutoBusy] = useState(false);
  useEffect(() => { if (canReply) api.businessProfile.reviewAutoReply().then(setAuto).catch(() => {}); }, [canReply]);
  const saveAuto = async (next: { enabled: boolean; minStars: number }) => {
    setAutoBusy(true);
    try { setAuto(await api.businessProfile.setReviewAutoReply(next)); toast(next.enabled ? 'Auto-reply on' : 'Auto-reply off', next.enabled ? `New reviews ${next.minStars}★ and up get an AI reply each day.` : undefined, 'success'); }
    catch (e) { toast('Not saved', errText('gbp.autoReply', e), 'alert'); }
    finally { setAutoBusy(false); }
  };
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
      {canReply && auto && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-[#DADCE0] bg-white p-3">
          <label className="inline-flex items-center gap-2 text-[13px] font-medium text-[#202124]"><input type="checkbox" className="h-4 w-4 accent-[#1A73E8]" disabled={autoBusy} checked={auto.enabled} onChange={(e) => void saveAuto({ enabled: e.target.checked, minStars: auto.minStars })} /> Auto-reply to new reviews with AI</label>
          <label className="inline-flex items-center gap-1.5 text-[12px] text-[#5F6368]">from
            <select className={cx(inputCls, 'w-auto py-1')} disabled={autoBusy || !auto.enabled} value={auto.minStars} onChange={(e) => void saveAuto({ enabled: auto.enabled, minStars: Number(e.target.value) })} aria-label="Minimum stars to auto-reply">
              {[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}★{n < 5 ? ' & up' : ''}</option>)}
            </select>
          </label>
          <span className="text-[11px] text-[#5F6368]">Each day, unanswered reviews at or above this rating — across every location — get a short AI reply posted to Google in your name. Lower-rated ones are left for your team to answer personally.</span>
        </div>
      )}
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

export const LocationsOverview: React.FC<{ data: BusinessLocationsView; loading: boolean; onOpen: (name: string, tab?: DetailTab) => void; onRefresh: () => void; canReply: boolean }> = ({ data, loading, onOpen, onRefresh, canReply }) => {
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
