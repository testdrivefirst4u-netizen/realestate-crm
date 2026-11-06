/**
 * Post scheduler (/posts, plan feature socialPosts; server: modules/socialPosts.ts): Insights (PostInsights.tsx), the Planner (a week or a month, with
 * drafts beside it; drag a scheduled post to another day, same time) and Content (all posts by status). Both filter by
 * account and search the text. Create post opens the composer (PostComposer.tsx); a draft or scheduled post opens there
 * to be changed; a posted or failed one shows as it looks on the platform, with retry for what failed, and the text can
 * be changed for a post on one Facebook Page. A new picture means a new post ("Post again").
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, FileText, Pencil, Plus, RefreshCw, RotateCcw, Search, Send, Trash2 } from 'lucide-react';
import { api, type InsightValue, type PostTargetOption, type SocialPost } from '../../core/api';
import { toast } from '../../core/notifications';
import { Badge, Button, EmptyState, InlineNotice, Modal, cx, inputCls } from '../../components/ui';
import { InstagramView } from './InstagramView';
import { PostCard } from './PostCard';
import { PostComposer, Preview } from './PostComposer';
import { deletableTargets, PostDeleteDialog } from './PostDeleteDialog';
import { PostInsights, insightText } from './PostInsights';
import { KIND, STATUS, errText, postDate } from './postShared';

type Tab = 'calendar' | 'list' | 'instagram' | 'insights';
type CalendarView = 'week' | 'month';
type CalendarStatus = '' | 'scheduled' | 'published' | 'failed';
type Filter = 'scheduled' | 'published' | 'draft' | 'failed' | 'deleted';
const FILTERS: Array<{ id: Filter; label: string; has: Array<SocialPost['status']> }> = [
  { id: 'scheduled', label: 'Scheduled', has: ['scheduled', 'publishing'] },
  { id: 'published', label: 'Published', has: ['published', 'partial'] },
  { id: 'draft', label: 'Drafts', has: ['draft'] },
  { id: 'failed', label: 'Failed', has: ['failed'] },
  { id: 'deleted', label: 'Deleted', has: ['deleted'] },
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CHIP: Record<SocialPost['status'], string> = {
  draft: 'border-[#CED0D4] bg-[#F5F6F7]', scheduled: 'border-[#BFD4FF] bg-[#E7F0FF]', publishing: 'border-[#F2D49B] bg-[#FFF6E5]', published: 'border-[#BFE3CF] bg-[#F1FAF5]', partial: 'border-[#F2D49B] bg-[#FFF6E5]', failed: 'border-[#F5C2B8] bg-[#FEF3F2]', deleted: 'border-[#DADDE1] bg-[#F5F6F7] opacity-60',
};
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const timeOf = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
/** The six weeks shown for a month, from the Sunday on or before the 1st. */
function monthGrid(month: Date): Date[] {
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  start.setDate(1 - start.getDay());
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}
/** The Sunday-to-Saturday week around a day. */
function weekGrid(day: Date): Date[] {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate() - day.getDay());
  return Array.from({ length: 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}
const rangeTitle = (view: CalendarView, days: Date[], anchor: Date) => {
  if (view === 'month') return anchor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const a = days[0], b = days[6];
  const end = b.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${a.toLocaleDateString(undefined, a.getMonth() === b.getMonth() ? { day: 'numeric' } : { day: 'numeric', month: 'short' })} – ${end}`;
};
const editable = (p: SocialPost) => p.status === 'draft' || p.status === 'scheduled';
/** The accounts whose text can change after posting; Instagram has no caption editing, a story has no text. */
const textTargets = (p: SocialPost) => (p.postType === 'story' ? [] : p.targets.filter((t) => t.status === 'posted' && !!t.postId && (t.kind === 'facebook' || t.kind === 'google')));
const textOf = (p: SocialPost, t: SocialPost['targets'][number]) => t.text || p.texts[t.kind] || p.text;
const PAGE_SIZE = 60;
const listQuery = (filter: Filter, skip: number, q: string, account: string) => ({ from: '2000-01-01T00:00:00.000Z', statuses: FILTERS.find((f) => f.id === filter)!.has, skip, limit: PAGE_SIZE, q: q || undefined, account: account || undefined });
const whenText = (p: SocialPost) => postDate(p).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const Accounts: React.FC<{ post: SocialPost }> = ({ post }) => (
  <div className="flex flex-wrap gap-1.5">
    {post.targets.map((t) => (
      <span key={t.key} title={t.error || ''} className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', t.status === 'posted' ? 'border-[#BFE3CF] bg-[#F1FAF5] text-[#067647]' : t.status === 'failed' ? 'border-[#F5C2B8] bg-[#FEF3F2] text-[#B42318]' : 'border-[#DADDE1] text-[#65676B]')}>
        <span className={cx('h-2 w-2 rounded-full', KIND[t.kind].cls)} /><span className={t.status === 'deleted' ? 'line-through' : undefined}>{t.name}</span>{t.status === 'deleted' && ' · deleted'}
        {t.url && t.status !== 'deleted' && <a href={t.url} target="_blank" rel="noopener noreferrer" aria-label={`Open on ${KIND[t.kind].label}`}><ExternalLink size={10} /></a>}
      </span>
    ))}
  </div>
);

/** A post on the calendar; a scheduled one can be dragged to another day. */
const PlannerCard: React.FC<{ post: SocialPost; large: boolean; onOpen: () => void }> = ({ post: p, large, onOpen }) => (
  <button type="button" draggable={p.status === 'scheduled'} onDragStart={(e) => { e.dataTransfer.setData('text/plain', p.id); e.dataTransfer.effectAllowed = 'move'; }} onClick={onOpen}
    title={`${STATUS[p.status].label}: ${p.text}`} className={cx('block w-full rounded border p-1 text-left hover:brightness-95', CHIP[p.status], p.status === 'scheduled' && 'cursor-grab active:cursor-grabbing')}>
    {large && p.imageUrl && <img src={p.imageUrl} alt="" loading="lazy" draggable={false} className="mb-1 aspect-square w-full rounded object-cover" />}
    <span className="flex items-center gap-1.5">
      {!large && p.imageUrl && <img src={p.imageUrl} alt="" loading="lazy" draggable={false} className="h-6 w-6 flex-none rounded object-cover" />}
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-semibold text-[#44505C]">{timeOf(postDate(p))}{p.postType !== 'post' ? ` · ${p.postType[0].toUpperCase()}${p.postType.slice(1)}` : ''}{large ? ` · ${STATUS[p.status].label}` : ''}</span>
        <span className={cx('block text-[11px] text-[#1C2B33]', large ? 'line-clamp-3 whitespace-pre-wrap break-words' : 'truncate')}>{p.text || 'No text'}</span>
      </span>
      {!large && <span className="flex flex-none -space-x-1">{p.targets.slice(0, 3).map((t) => <span key={t.key} title={t.name} className={cx('h-2.5 w-2.5 rounded-full ring-1 ring-white', KIND[t.kind].cls)} />)}</span>}
    </span>
    {large && <span className="mt-1 flex flex-wrap gap-1">{p.targets.slice(0, 4).map((t) => <span key={t.key} className="inline-flex items-center gap-1 text-[10px] text-[#44505C]"><span className={cx('h-2 w-2 rounded-full', KIND[t.kind].cls)} />{KIND[t.kind].label}</span>)}</span>}
  </button>
);

export const PostsView: React.FC = () => {
  const [tab, setTab] = useState<Tab>('calendar');
  const [filter, setFilter] = useState<Filter>('scheduled');
  const [calendarView, setCalendarView] = useState<CalendarView>('week');
  const [anchor, setAnchor] = useState(() => new Date());
  const [account, setAccount] = useState('');
  const [calendarStatus, setCalendarStatus] = useState<CalendarStatus>('');
  const [search, setSearch] = useState('');
  const [searchNow, setSearchNow] = useState('');
  const [dropDay, setDropDay] = useState('');
  const [posts, setPosts] = useState<SocialPost[] | null>(null);
  const [targets, setTargets] = useState<PostTargetOption[]>([]);
  const [composing, setComposing] = useState<{ post?: SocialPost | null; seed?: SocialPost | null; when?: Date | null } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [editText, setEditText] = useState<string | null>(null);
  const [editKey, setEditKey] = useState('');
  const [deleting, setDeleting] = useState<SocialPost | null>(null);
  const [rev, setRev] = useState(0);
  const [comments, setComments] = useState<{ id: string; rows: Array<{ id: string; author: string; text: string; at: string }> | null; error: string } | null>(null);
  const [details, setDetails] = useState<SocialPost | null>(null);
  const [figures, setFigures] = useState<{ id: string; targets: Array<{ key: string; name: string; metrics: InsightValue[]; refused: string[] }> | null; error: string } | null>(null);
  const [busy, setBusy] = useState('');
  const grid = useMemo(() => (calendarView === 'week' ? weekGrid(anchor) : monthGrid(new Date(anchor.getFullYear(), anchor.getMonth(), 1))), [calendarView, anchor]);
  // the Content tab asks the server, so wait for a pause in the typing
  useEffect(() => {
    const t = setTimeout(() => setSearchNow(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const load = useCallback(async () => {
    try {
      const last = grid[grid.length - 1];
      const end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
      const r = await api.posts.list(tab !== 'list' ? { from: grid[0].toISOString(), to: end.toISOString() } : listQuery(filter, 0, searchNow, account));
      setPosts(r.posts);
      setTargets(r.targets);
      setHasMore(tab === 'list' && r.hasMore);
    } catch (e) {
      setPosts((p) => p || []);
      toast('Could not load posts', errText('posts.list', e), 'alert');
    }
  }, [tab, grid, filter, searchNow, account]);
  useEffect(() => void load(), [load]);

  // the figures of the opened post, for what is already out
  const figuresFor = details && (details.status === 'published' || details.status === 'partial') ? details.id : '';
  useEffect(() => {
    if (!figuresFor) { setFigures(null); return; }
    let live = true;
    setFigures({ id: figuresFor, targets: null, error: '' });
    api.posts.postInsights(figuresFor)
      .then((r) => { if (live) setFigures({ id: figuresFor, targets: r.targets, error: '' }); })
      .catch((e) => { if (live) setFigures({ id: figuresFor, targets: [], error: errText('posts.postInsights', e) }); });
    return () => { live = false; };
  }, [figuresFor]);

  // the comments of the opened post
  const openedId = details?.id || '';
  useEffect(() => {
    if (!openedId) { setComments(null); return; }
    let live = true;
    setComments({ id: openedId, rows: null, error: '' });
    api.posts.comments(openedId)
      .then((r) => { if (live) setComments({ id: openedId, rows: r.comments, error: '' }); })
      .catch((e) => { if (live) setComments({ id: openedId, rows: [], error: errText('posts.comments', e) }); });
    return () => { live = false; };
  }, [openedId]);

  const retry = async (p: SocialPost) => {
    setBusy('retry');
    try {
      const r = await api.posts.retry(p.id);
      setDetails(r);
      await load();
    } catch (e) {
      toast('Retry failed', errText('posts.retry', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const remove = async (p: SocialPost) => {
    if (!window.confirm('Delete this post?')) return;
    try {
      await api.posts.remove(p.id);
      setComposing(null);
      setDetails(null);
      setRev((n) => n + 1);
      await load();
    } catch (e) {
      toast('Could not delete', errText('posts.delete', e), 'alert');
    }
  };
  const loadMore = async () => {
    setBusy('more');
    try {
      const r = await api.posts.list(listQuery(filter, (posts || []).length, searchNow, account));
      setPosts((p) => [...(p || []), ...r.posts]);
      setHasMore(r.hasMore);
    } catch (e) {
      toast('Could not load more posts', errText('posts.more', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const saveText = async (p: SocialPost) => {
    setBusy('edit');
    try {
      const r = await api.posts.editPublished(p.id, editText || '', editKey);
      setDetails(r);
      setEditText(null);
      toast(`Post changed on ${KIND[p.targets.find((t) => t.key === editKey)?.kind || 'facebook'].label}`, undefined, 'success');
      await load();
    } catch (e) {
      toast('Not changed', errText('posts.edit', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const syncOld = async () => {
    setBusy('sync');
    try {
      const r = await api.posts.syncOld();
      const failed = [...r.errors.map((e) => `${e.account}: ${e.message}`), ...r.warnings].join(' · ');
      toast(`${r.imported} old post${r.imported === 1 ? '' : 's'} added`, failed || (r.updated ? `${r.updated} already here were refreshed.` : undefined), failed ? 'alert' : 'success');
      await load();
    } catch (e) {
      toast('Could not sync old posts', errText('posts.sync', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  /** Same time of day on the day it was dropped on. */
  const moveTo = async (id: string, day: Date) => {
    const p = (posts || []).find((x) => x.id === id);
    if (!p || p.status !== 'scheduled') return;
    const at = new Date(p.scheduledAt);
    if (sameDay(at, day)) return;
    const when = new Date(day.getFullYear(), day.getMonth(), day.getDate(), at.getHours(), at.getMinutes());
    if (when.getTime() <= Date.now()) return toast('That time has passed', 'Choose a later day, or open the post to change its time.', 'alert');
    try {
      await api.posts.reschedule(id, when.toISOString());
      toast('Post moved', when.toLocaleString(), 'success');
    } catch (e) {
      toast('Not moved', errText('posts.move', e), 'alert');
    }
    await load();
  };
  const step = (by: number) => setAnchor((a) => (calendarView === 'week' ? new Date(a.getFullYear(), a.getMonth(), a.getDate() + by * 7) : new Date(a.getFullYear(), a.getMonth() + by, 1)));
  const openById = async (id: string) => {
    try {
      open((await api.posts.get(id)).post);
    } catch (e) {
      toast('Could not open the post', errText('posts.get', e), 'alert');
    }
  };
  const open = (p: SocialPost) => { setEditText(null); if (editable(p)) setComposing({ post: p }); else setDetails(p); };
  const newOn = (d: Date) => {
    const when = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0);
    setComposing({ when: when.getTime() > Date.now() ? when : new Date(Date.now() + 3600000) });
  };

  const today = new Date();
  const q = search.trim().toLowerCase();
  const matches = (p: SocialPost) => (!account || p.targets.some((t) => t.key === account)) && (!q || p.text.toLowerCase().includes(q));
  const onCalendar = (posts || []).filter((p) => p.status !== 'draft' && matches(p) && (!calendarStatus || FILTERS.find((f) => f.id === calendarStatus)!.has.includes(p.status)));
  const drafts = (posts || []).filter((p) => p.status === 'draft' && matches(p));
  const shown = (posts || []).filter((p) => FILTERS.find((f) => f.id === filter)!.has.includes(p.status));

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="View" className="inline-flex rounded-lg bg-[#E4E6EB] p-0.5">
          {([['calendar', 'Planner'], ['list', 'Content'], ['instagram', 'Instagram'], ['insights', 'Insights']] as Array<[Tab, string]>).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx('rounded-md px-3.5 py-1.5 text-[13px] font-semibold', tab === id ? 'bg-white text-[#0866FF] shadow-sm' : 'text-[#44505C]')}>{label}</button>
          ))}
        </div>
        <span className="flex-1" />
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={busy === 'sync' ? 'animate-spin' : ''} />} disabled={busy === 'sync' || !targets.some((t) => t.kind === 'facebook')} title="Copy the last year of posts from your connected Facebook Pages and Instagram accounts" onClick={() => void syncOld()}>Sync old posts</Button>
        <button type="button" disabled={!targets.length} title={targets.length ? undefined : 'Connect an account first'} onClick={() => setComposing({})} className="inline-flex items-center gap-1.5 rounded-lg bg-[#0866FF] px-3.5 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"><Plus size={15} /> Create post</button>
      </div>

      {tab !== 'instagram' && <div className="flex flex-wrap items-center gap-2">
        {tab !== 'insights' && <label className="relative min-w-[180px] flex-1">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#65676B]" />
          <input className={cx(inputCls, 'pl-8')} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search posts" aria-label="Search posts" />
        </label>}
        <select className={cx(inputCls, 'w-auto max-w-[240px]')} value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Account">
          <option value="">All accounts</option>
          {targets.map((t) => <option key={t.key} value={t.key}>{KIND[t.kind].label} · {t.name}</option>)}
        </select>
        {tab === 'calendar' && (
          <select className={cx(inputCls, 'w-auto')} value={calendarStatus} onChange={(e) => setCalendarStatus(e.target.value as CalendarStatus)} aria-label="Status">
            <option value="">All statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="published">Published</option>
            <option value="failed">Failed</option>
          </select>
        )}
      </div>}

      {posts && !targets.length && <InlineNotice tone="warning">No account connected yet. An Admin connects Facebook, Instagram, Google Business Profile, LinkedIn and Pinterest in Settings.</InlineNotice>}

      {tab === 'instagram' ? <InstagramView targets={targets} rev={rev} onCreate={() => setComposing({})} onEdit={(p) => setComposing({ post: p })} onAgain={(p) => setComposing({ seed: p })} onDelete={(p) => setDeleting(p)} onDetails={(p) => open(p)} /> : tab === 'insights' ? <PostInsights account={account} onOpenPost={(id) => void openById(id)} /> : tab === 'calendar' ? (
        <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1fr)_240px]">
          <div className="rounded-xl border border-[#DADDE1] bg-white">
            <div className="flex flex-wrap items-center gap-2 border-b border-[#DADDE1] p-3">
              <button type="button" aria-label={`Previous ${calendarView}`} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[#F0F2F5]" onClick={() => step(-1)}><ChevronLeft size={17} /></button>
              <button type="button" aria-label={`Next ${calendarView}`} className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[#F0F2F5]" onClick={() => step(1)}><ChevronRight size={17} /></button>
              <h2 className="text-[15px] font-bold text-[#1C2B33]">{rangeTitle(calendarView, grid, anchor)}</h2>
              <button type="button" className="ml-1 rounded-lg border border-[#CED0D4] px-2.5 py-1 text-xs font-semibold text-[#44505C] hover:bg-[#F5F6F7]" onClick={() => setAnchor(new Date())}>Today</button>
              <div role="tablist" aria-label="Calendar view" className="ml-auto inline-flex rounded-lg border border-[#CED0D4] p-0.5">
                {(['week', 'month'] as CalendarView[]).map((v) => <button key={v} type="button" role="tab" aria-selected={calendarView === v} onClick={() => setCalendarView(v)} className={cx('rounded-md px-3 py-1 text-xs font-semibold capitalize', calendarView === v ? 'bg-[#E7F0FF] text-[#0866FF]' : 'text-[#44505C] hover:bg-[#F5F6F7]')}>{v}</button>)}
              </div>
            </div>
            <div className="overflow-x-auto">
              <div className="min-w-[760px]">
                <div className="grid grid-cols-7 border-b border-[#DADDE1] bg-[#F5F6F7]">
                  {WEEKDAYS.map((d) => <div key={d} className="px-2 py-1.5 text-[11px] font-semibold text-[#44505C]">{d}</div>)}
                </div>
                <div className="grid grid-cols-7">
                  {grid.map((d) => {
                    const dayPosts = onCalendar.filter((p) => sameDay(postDate(p), d)).sort((a, b) => postDate(a).getTime() - postDate(b).getTime());
                    const inRange = calendarView === 'week' || d.getMonth() === anchor.getMonth();
                    const isToday = sameDay(d, today);
                    const past = !isToday && d.getTime() < today.getTime();
                    const key = d.toISOString();
                    return (
                      <div key={key} className={cx('group border-b border-r border-[#EBEDF0] p-1.5', calendarView === 'week' ? 'min-h-[420px]' : 'min-h-[110px]', !inRange && 'bg-[#FAFBFC]', past && calendarView === 'week' && 'bg-[#FAFBFC]', dropDay === key && 'bg-[#E7F0FF]')}
                        onDragOver={(e) => { if (past) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropDay(key); }}
                        onDragLeave={() => setDropDay((v) => (v === key ? '' : v))}
                        onDrop={(e) => { e.preventDefault(); setDropDay(''); void moveTo(e.dataTransfer.getData('text/plain'), d); }}>
                        <div className="mb-1 flex items-center justify-between">
                          <span className={cx('flex h-6 w-6 items-center justify-center rounded-full text-xs', isToday ? 'bg-[#0866FF] font-bold text-white' : inRange ? 'text-[#1C2B33]' : 'text-[#A7B4C0]')}>{d.getDate()}</span>
                          {!past && targets.length > 0 && <button type="button" aria-label={`Create a post on ${d.toDateString()}`} onClick={() => newOn(d)} className="flex h-6 w-6 items-center justify-center rounded text-[#65676B] opacity-0 hover:bg-[#F0F2F5] focus:opacity-100 group-hover:opacity-100"><Plus size={14} /></button>}
                        </div>
                        <div className="space-y-1">
                          {dayPosts.map((p) => <PlannerCard key={p.id} post={p} large={calendarView === 'week'} onOpen={() => open(p)} />)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
          <aside className="rounded-xl border border-[#DADDE1] bg-white" aria-label="Drafts">
            <h3 className="flex items-center gap-2 border-b border-[#DADDE1] p-3 text-[13px] font-bold text-[#1C2B33]"><FileText size={14} /> Drafts <span className="font-medium text-[#65676B]">{drafts.length}</span></h3>
            {!drafts.length ? <p className="p-3 text-xs text-[#65676B]">No drafts. Choose Save as draft when you create a post.</p> : (
              <ul className="max-h-[480px] divide-y divide-[#EBEDF0] overflow-y-auto">
                {drafts.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => open(p)} className="flex w-full items-start gap-2 p-2.5 text-left hover:bg-[#F5F9FF]">
                      {p.imageUrl && <img src={p.imageUrl} alt="" loading="lazy" className="h-9 w-9 flex-none rounded object-cover" />}
                      <span className="line-clamp-2 min-w-0 flex-1 text-xs text-[#1C2B33]">{p.text || 'No text'}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>
        </div>
      ) : (
        <div className="rounded-xl border border-[#DADDE1] bg-white">
          <div role="tablist" aria-label="Status" className="flex border-b border-[#DADDE1]">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)} className={cx('-mb-px flex-1 border-b-2 px-3 py-2.5 text-[13px] font-semibold', filter === f.id ? 'border-[#0866FF] text-[#0866FF]' : 'border-transparent text-[#44505C] hover:bg-[#F5F6F7]')}>{f.label}</button>
            ))}
          </div>
          {posts === null ? <p className="p-4 text-xs text-[#65676B]">Loading…</p> : !shown.length ? (
            <EmptyState className="py-10" icon={<Send size={20} />} title={`No ${FILTERS.find((f) => f.id === filter)!.label.toLowerCase()} posts`} description="Posts you create appear here." />
          ) : (
            <>
              <ul className="grid gap-3 bg-[#F0F2F5] p-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {shown.map((p) => (
                  <li key={p.id} className="min-w-0">
                    <button type="button" onClick={() => open(p)} className="flex h-full w-full flex-col text-left transition hover:brightness-[0.98]" aria-label={`Open post: ${p.text || 'No text'}`}>
                      <span className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-[#65676B]"><Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>{p.createdBy}</span>
                      <span className="block min-h-0 flex-1"><PostCard post={p} when={whenText(p)} /></span>
                    </button>
                  </li>
                ))}
              </ul>
              {hasMore && <div className="border-t border-[#DADDE1] p-3 text-center"><Button variant="secondary" size="sm" loading={busy === 'more'} onClick={() => void loadMore()}>Load more</Button></div>}
            </>
          )}
        </div>
      )}

      {composing && <PostComposer targets={targets} post={composing.post} seed={composing.seed} initialWhen={composing.when} onClose={() => setComposing(null)} onSaved={() => { setComposing(null); setRev((n) => n + 1); void load(); }} onDelete={(p) => void remove(p)} />}

      <Modal open={!!details} onClose={() => setDetails(null)} title={details ? STATUS[details.status].label : ''} subtitle={details ? `${postDate(details).toLocaleString()} · ${details.createdBy}` : undefined}
        footer={details && (
          <>
            {(details.status === 'failed' || details.status === 'deleted') && <Button variant="secondary" icon={<Trash2 size={13} />} onClick={() => void remove(details)}>{details.status === 'deleted' ? 'Remove from CRM' : 'Delete'}</Button>}
            {(details.status === 'published' || details.status === 'partial') && deletableTargets(details).length > 0 && <Button variant="secondary" icon={<Trash2 size={13} />} onClick={() => setDeleting(details)}>Delete from platforms</Button>}
            {(details.status === 'failed' || details.status === 'partial') && <Button icon={<RotateCcw size={13} />} loading={busy === 'retry'} onClick={() => void retry(details)}>Retry</Button>}
            {targets.length > 0 && <Button variant="secondary" onClick={() => { const seed = details; setDetails(null); setComposing({ seed }); }}>Post again</Button>}
            {editText !== null ? <Button loading={busy === 'edit'} disabled={!editText.trim() || !editKey} onClick={() => void saveText(details)}>Save on {KIND[details.targets.find((t) => t.key === editKey)?.kind || 'facebook'].label}</Button> : textTargets(details).length > 0 && <Button variant="secondary" icon={<Pencil size={13} />} onClick={() => { const t = textTargets(details)[0]; setEditKey(t.key); setEditText(textOf(details, t)); }}>Edit text</Button>}
            <Button variant="secondary" onClick={() => setDetails(null)}>Close</Button>
          </>
        )}>
        {details && (
          <div className="space-y-3">
            {editText !== null
              ? (
                <div className="space-y-2">
                  {textTargets(details).length > 1 && <select className={inputCls} value={editKey} aria-label="Account to change" onChange={(e) => { const t = details.targets.find((x) => x.key === e.target.value)!; setEditKey(t.key); setEditText(textOf(details, t)); }}>{textTargets(details).map((t) => <option key={t.key} value={t.key}>{KIND[t.kind].label}: {t.name}</option>)}</select>}
                  <textarea className="w-full min-h-[140px] rounded-lg border border-[#CED0D4] p-2.5 text-sm text-[#1C2B33] focus:border-[#0866FF] focus:outline-none" aria-label="Post text" value={editText} maxLength={3000} onChange={(e) => setEditText(e.target.value)} />
                  <p className="text-[11px] text-[#65676B]">Only this account changes. Facebook only lets an app change posts that the same app published, so a post made directly on Facebook may be refused.</p>
                </div>
              )
              : details.targets[0] && <Preview kind={details.targets[0].kind} name={details.targets[0].name} text={textOf(details, details.targets[0])} link={details.link} images={details.imageUrls} when={whenText(details)} metrics={details.metrics} postType={details.postType} video={details.videoUrl} controls />}
            {figures && (
              <div>
                <h3 className="text-[13px] font-bold text-[#1C2B33]">Insights</h3>
                {figures.targets === null ? <p className="mt-1 text-xs text-[#65676B]">Loading…</p> : figures.error ? <p className="mt-1 text-xs text-[#B42318]">{figures.error}</p> : !figures.targets.length ? <p className="mt-1 text-xs text-[#65676B]">Figures are available for Facebook and Instagram posts.</p> : figures.targets.map((t) => (
                  <div key={t.key} className="mt-1.5 rounded-lg border border-[#EBEDF0] p-2.5">
                    <p className="text-[11px] font-semibold text-[#44505C]">{t.name}</p>
                    <dl className="mt-1 grid grid-cols-3 gap-2">{t.metrics.map((m) => <div key={m.id}><dt className="text-[10.5px] text-[#65676B]">{m.label}</dt><dd className="text-sm font-semibold text-[#1C2B33]">{insightText(m)}</dd></div>)}</dl>
                    {t.refused.length > 0 && <details className="mt-1 text-[11px] text-[#9A3412]"><summary className="cursor-pointer font-semibold">Meta did not give {t.refused.length} figure{t.refused.length === 1 ? '' : 's'}</summary><ul className="mt-1 list-disc space-y-0.5 pl-4 break-words">{t.refused.map((r) => <li key={r}>{r}</li>)}</ul></details>}
                  </div>
                ))}
              </div>
            )}
            {comments && (
              <div>
                <h3 className="text-[13px] font-bold text-[#1C2B33]">Comments</h3>
                {comments.rows === null ? <p className="mt-1 text-xs text-[#65676B]">Loading…</p> : comments.error ? <p className="mt-1 text-xs text-[#B42318]">{comments.error}</p> : !comments.rows.length ? <p className="mt-1 text-xs text-[#65676B]">No comments to show.</p> : (
                  <ul className="mt-1.5 max-h-56 space-y-2 overflow-y-auto">
                    {comments.rows.map((c) => (
                      <li key={c.id} className="rounded-xl bg-[#F0F2F5] px-3 py-2 text-xs text-[#1C2B33]">
                        <b className="block font-semibold">{c.author}</b>
                        <span className="whitespace-pre-wrap break-words">{c.text}</span>
                        {c.at && <span className="mt-0.5 block text-[10px] text-[#65676B]">{new Date(c.at).toLocaleString()}</span>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <p className="text-[11px] text-[#65676B]">Facebook and Instagram do not let an app replace the picture of a published post, and Instagram does not let an app change a caption. To change those, delete the post and choose Post again, which loses its likes and comments.</p>
            <Accounts post={details} />
            {details.targets.filter((t) => t.status === 'failed').map((t) => <p key={t.key} className="text-xs text-[#B42318]">{KIND[t.kind].label}: {t.error}</p>)}
            {details.targets.filter((t) => t.commentError).map((t) => <p key={t.key} className="text-xs text-[#9A3412]">{KIND[t.kind].label} first comment was not added: {t.commentError}</p>)}
          </div>
        )}
      </Modal>
      {deleting && <PostDeleteDialog post={deleting} onClose={() => { setDeleting(null); setRev((n) => n + 1); void load(); }} onDone={(p) => { setDeleting(null); if (tab !== 'instagram') setDetails(p); setRev((n) => n + 1); void load(); }} />}
    </div>
  );
};
