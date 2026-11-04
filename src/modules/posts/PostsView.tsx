/**
 * Post scheduler (/posts, plan feature socialPosts; server: modules/socialPosts.ts): a month planner and a list of the
 * company's posts by status. Create post opens the composer (PostComposer.tsx); a draft or scheduled post opens there
 * to be changed; a posted or failed one shows as it looks on the platform, with retry for what failed, and the text can
 * be changed for a post on one Facebook Page. A new picture means a new post ("Post again").
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Pencil, Plus, RefreshCw, RotateCcw, Send, Trash2 } from 'lucide-react';
import { api, type PostTargetOption, type SocialPost } from '../../core/api';
import { toast } from '../../core/notifications';
import { Badge, Button, EmptyState, InlineNotice, Modal, cx } from '../../components/ui';
import { PostComposer, Preview } from './PostComposer';
import { KIND, STATUS, errText, postDate } from './postShared';

type Tab = 'calendar' | 'list';
type Filter = 'scheduled' | 'published' | 'draft' | 'failed';
const FILTERS: Array<{ id: Filter; label: string; has: Array<SocialPost['status']> }> = [
  { id: 'scheduled', label: 'Scheduled', has: ['scheduled', 'publishing'] },
  { id: 'published', label: 'Published', has: ['published', 'partial'] },
  { id: 'draft', label: 'Drafts', has: ['draft'] },
  { id: 'failed', label: 'Failed', has: ['failed'] },
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const CHIP: Record<SocialPost['status'], string> = {
  draft: 'border-[#CED0D4] bg-[#F5F6F7]', scheduled: 'border-[#BFD4FF] bg-[#E7F0FF]', publishing: 'border-[#F2D49B] bg-[#FFF6E5]', published: 'border-[#BFE3CF] bg-[#F1FAF5]', partial: 'border-[#F2D49B] bg-[#FFF6E5]', failed: 'border-[#F5C2B8] bg-[#FEF3F2]',
};
const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const timeOf = (d: Date) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
/** The six weeks shown for a month, from the Sunday on or before the 1st. */
function monthGrid(month: Date): Date[] {
  const start = new Date(month.getFullYear(), month.getMonth(), 1);
  start.setDate(1 - start.getDay());
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}
const editable = (p: SocialPost) => p.status === 'draft' || p.status === 'scheduled';
const onePage = (p: SocialPost) => p.targets.length === 1 && p.targets[0].kind === 'facebook' && p.targets[0].status === 'posted' && !!p.targets[0].postId;
const PAGE_SIZE = 60;
const listQuery = (filter: Filter, skip: number) => ({ from: '2000-01-01T00:00:00.000Z', statuses: FILTERS.find((f) => f.id === filter)!.has, skip, limit: PAGE_SIZE });
const whenText = (p: SocialPost) => postDate(p).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

const Accounts: React.FC<{ post: SocialPost }> = ({ post }) => (
  <div className="flex flex-wrap gap-1.5">
    {post.targets.map((t) => (
      <span key={t.key} title={t.error || ''} className={cx('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold', t.status === 'posted' ? 'border-[#BFE3CF] bg-[#F1FAF5] text-[#067647]' : t.status === 'failed' ? 'border-[#F5C2B8] bg-[#FEF3F2] text-[#B42318]' : 'border-[#DADDE1] text-[#65676B]')}>
        <span className={cx('h-2 w-2 rounded-full', KIND[t.kind].cls)} />{t.name}
        {t.url && <a href={t.url} target="_blank" rel="noopener noreferrer" aria-label={`Open on ${KIND[t.kind].label}`}><ExternalLink size={10} /></a>}
      </span>
    ))}
  </div>
);

export const PostsView: React.FC = () => {
  const [tab, setTab] = useState<Tab>('calendar');
  const [filter, setFilter] = useState<Filter>('scheduled');
  const [month, setMonth] = useState(() => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), 1); });
  const [posts, setPosts] = useState<SocialPost[] | null>(null);
  const [targets, setTargets] = useState<PostTargetOption[]>([]);
  const [composing, setComposing] = useState<{ post?: SocialPost | null; seed?: SocialPost | null; when?: Date | null } | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [editText, setEditText] = useState<string | null>(null);
  const [comments, setComments] = useState<{ id: string; rows: Array<{ id: string; author: string; text: string; at: string }> | null; error: string } | null>(null);
  const [details, setDetails] = useState<SocialPost | null>(null);
  const [busy, setBusy] = useState('');
  const grid = useMemo(() => monthGrid(month), [month]);

  const load = useCallback(async () => {
    try {
      const end = new Date(grid[41].getFullYear(), grid[41].getMonth(), grid[41].getDate() + 1);
      const r = await api.posts.list(tab === 'calendar' ? { from: grid[0].toISOString(), to: end.toISOString() } : listQuery(filter, 0));
      setPosts(r.posts);
      setTargets(r.targets);
      setHasMore(tab === 'list' && r.hasMore);
    } catch (e) {
      setPosts((p) => p || []);
      toast('Could not load posts', errText('posts.list', e), 'alert');
    }
  }, [tab, grid, filter]);
  useEffect(() => void load(), [load]);

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
      await load();
    } catch (e) {
      toast('Could not delete', errText('posts.delete', e), 'alert');
    }
  };
  const loadMore = async () => {
    setBusy('more');
    try {
      const r = await api.posts.list(listQuery(filter, (posts || []).length));
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
      const r = await api.posts.editPublished(p.id, editText || '');
      setDetails(r);
      setEditText(null);
      toast('Post changed on Facebook', undefined, 'success');
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
  const open = (p: SocialPost) => { setEditText(null); if (editable(p)) setComposing({ post: p }); else setDetails(p); };
  const newOn = (d: Date) => {
    const when = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 10, 0);
    setComposing({ when: when.getTime() > Date.now() ? when : new Date(Date.now() + 3600000) });
  };

  const today = new Date();
  const onCalendar = (posts || []).filter((p) => p.status !== 'draft');
  const shown = (posts || []).filter((p) => FILTERS.find((f) => f.id === filter)!.has.includes(p.status));

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="View" className="inline-flex rounded-lg bg-[#E4E6EB] p-0.5">
          {([['calendar', 'Calendar'], ['list', 'Posts']] as Array<[Tab, string]>).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx('rounded-md px-3.5 py-1.5 text-[13px] font-semibold', tab === id ? 'bg-white text-[#0866FF] shadow-sm' : 'text-[#44505C]')}>{label}</button>
          ))}
        </div>
        <span className="flex-1" />
        <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={busy === 'sync' ? 'animate-spin' : ''} />} disabled={busy === 'sync' || !targets.some((t) => t.kind === 'facebook')} title="Copy the last year of posts from your connected Facebook Pages and Instagram accounts" onClick={() => void syncOld()}>Sync old posts</Button>
        <button type="button" disabled={!targets.length} title={targets.length ? undefined : 'Connect an account first'} onClick={() => setComposing({})} className="inline-flex items-center gap-1.5 rounded-lg bg-[#0866FF] px-3.5 py-2 text-[13px] font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"><Plus size={15} /> Create post</button>
      </div>

      {posts && !targets.length && <InlineNotice tone="warning">No account connected yet. An Admin connects Facebook, Instagram, Google Business Profile, LinkedIn and Pinterest in Settings.</InlineNotice>}

      {tab === 'calendar' ? (
        <div className="rounded-xl border border-[#DADDE1] bg-white">
          <div className="flex items-center gap-2 border-b border-[#DADDE1] p-3">
            <button type="button" aria-label="Previous month" className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[#F0F2F5]" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))}><ChevronLeft size={17} /></button>
            <button type="button" aria-label="Next month" className="flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[#F0F2F5]" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))}><ChevronRight size={17} /></button>
            <h2 className="text-[15px] font-bold text-[#1C2B33]">{month.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</h2>
            <button type="button" className="ml-1 rounded-lg border border-[#CED0D4] px-2.5 py-1 text-xs font-semibold text-[#44505C] hover:bg-[#F5F6F7]" onClick={() => setMonth(new Date(today.getFullYear(), today.getMonth(), 1))}>Today</button>
          </div>
          <div className="overflow-x-auto">
            <div className="min-w-[760px]">
              <div className="grid grid-cols-7 border-b border-[#DADDE1] bg-[#F5F6F7]">
                {WEEKDAYS.map((d) => <div key={d} className="px-2 py-1.5 text-[11px] font-semibold text-[#44505C]">{d}</div>)}
              </div>
              <div className="grid grid-cols-7">
                {grid.map((d) => {
                  const dayPosts = onCalendar.filter((p) => sameDay(postDate(p), d)).sort((a, b) => postDate(a).getTime() - postDate(b).getTime());
                  const inMonth = d.getMonth() === month.getMonth();
                  const isToday = sameDay(d, today);
                  const past = !isToday && d.getTime() < today.getTime();
                  return (
                    <div key={d.toISOString()} className={cx('group min-h-[110px] border-b border-r border-[#EBEDF0] p-1.5', !inMonth && 'bg-[#FAFBFC]')}>
                      <div className="mb-1 flex items-center justify-between">
                        <span className={cx('flex h-6 w-6 items-center justify-center rounded-full text-xs', isToday ? 'bg-[#0866FF] font-bold text-white' : inMonth ? 'text-[#1C2B33]' : 'text-[#A7B4C0]')}>{d.getDate()}</span>
                        {!past && targets.length > 0 && <button type="button" aria-label={`Create a post on ${d.toDateString()}`} onClick={() => newOn(d)} className="flex h-6 w-6 items-center justify-center rounded text-[#65676B] opacity-0 hover:bg-[#F0F2F5] focus:opacity-100 group-hover:opacity-100"><Plus size={14} /></button>}
                      </div>
                      <div className="space-y-1">
                        {dayPosts.map((p) => (
                          <button key={p.id} type="button" onClick={() => open(p)} title={`${STATUS[p.status].label}: ${p.text}`} className={cx('flex w-full items-center gap-1.5 rounded border p-1 text-left hover:brightness-95', CHIP[p.status])}>
                            {p.imageUrl && <img src={p.imageUrl} alt="" className="h-6 w-6 flex-none rounded object-cover" />}
                            <span className="min-w-0 flex-1">
                              <span className="block text-[10px] font-semibold text-[#44505C]">{timeOf(postDate(p))}</span>
                              <span className="block truncate text-[11px] text-[#1C2B33]">{p.text || 'No text'}</span>
                            </span>
                            <span className="flex flex-none -space-x-1">{p.targets.slice(0, 3).map((t) => <span key={t.key} title={t.name} className={cx('h-2.5 w-2.5 rounded-full ring-1 ring-white', KIND[t.kind].cls)} />)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
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
              <ul className="grid items-start gap-3 bg-[#F0F2F5] p-3 sm:grid-cols-2 lg:grid-cols-3">
                {shown.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => open(p)} className="block w-full text-left transition hover:brightness-[0.98]" aria-label={`Open post: ${p.text || 'No text'}`}>
                      <span className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-[#65676B]"><Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>{p.createdBy}</span>
                      {p.targets[0] ? <Preview kind={p.targets[0].kind} name={p.targets[0].name} text={p.text.length > 280 ? p.text.slice(0, 280) + '…' : p.text} link={p.link} image={p.imageUrl} when={whenText(p)} metrics={p.metrics} /> : <span className="block rounded-lg border border-[#DADDE1] bg-white p-4 text-[13px] text-[#1C2B33]">{p.text || 'No text'}</span>}
                    </button>
                  </li>
                ))}
              </ul>
              {hasMore && <div className="border-t border-[#DADDE1] p-3 text-center"><Button variant="secondary" size="sm" loading={busy === 'more'} onClick={() => void loadMore()}>Load more</Button></div>}
            </>
          )}
        </div>
      )}

      {composing && <PostComposer targets={targets} post={composing.post} seed={composing.seed} initialWhen={composing.when} onClose={() => setComposing(null)} onSaved={() => { setComposing(null); void load(); }} onDelete={(p) => void remove(p)} />}

      <Modal open={!!details} onClose={() => setDetails(null)} title={details ? STATUS[details.status].label : ''} subtitle={details ? `${postDate(details).toLocaleString()} · ${details.createdBy}` : undefined}
        footer={details && (
          <>
            {details.status === 'failed' && <Button variant="secondary" icon={<Trash2 size={13} />} onClick={() => void remove(details)}>Delete</Button>}
            {(details.status === 'failed' || details.status === 'partial') && <Button icon={<RotateCcw size={13} />} loading={busy === 'retry'} onClick={() => void retry(details)}>Retry</Button>}
            {targets.length > 0 && <Button variant="secondary" onClick={() => { const seed = details; setDetails(null); setComposing({ seed }); }}>Post again</Button>}
            {editText !== null ? <Button loading={busy === 'edit'} disabled={!editText.trim()} onClick={() => void saveText(details)}>Save on Facebook</Button> : onePage(details) && <Button variant="secondary" icon={<Pencil size={13} />} onClick={() => setEditText(details.text)}>Edit text</Button>}
            <Button variant="secondary" onClick={() => setDetails(null)}>Close</Button>
          </>
        )}>
        {details && (
          <div className="space-y-3">
            {editText !== null
              ? <textarea className="w-full min-h-[140px] rounded-lg border border-[#CED0D4] p-2.5 text-sm text-[#1C2B33] focus:border-[#0866FF] focus:outline-none" aria-label="Post text" value={editText} maxLength={3000} onChange={(e) => setEditText(e.target.value)} />
              : details.targets[0] && <Preview kind={details.targets[0].kind} name={details.targets[0].name} text={details.text} link={details.link} image={details.imageUrl} when={whenText(details)} metrics={details.metrics} />}
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
            <p className="text-[11px] text-[#65676B]">Facebook and Instagram do not let an app replace the picture of a published post. To use a new picture, choose Post again, then remove the old post on the platform (open it from the account below).</p>
            <Accounts post={details} />
            {details.targets.filter((t) => t.status === 'failed').map((t) => <p key={t.key} className="text-xs text-[#B42318]">{KIND[t.kind].label}: {t.error}</p>)}
          </div>
        )}
      </Modal>
    </div>
  );
};
