/**
 * Social inbox (/inbox, plan feature socialInbox; server: modules/socialInbox.ts): Facebook / Instagram comments
 * and messages and Google reviews in one list; open a conversation, answer it, or turn it into a lead. A comment shows
 * the post it is on, and all the comments of one post can be listed together. Direct messages are laid out like Instagram's:
 * people with their picture and username, the latest message beside the time, grey and blue bubbles, times between them.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Inbox, MessageSquare, RefreshCw, Search, Send, Star, UserPlus } from 'lucide-react';
import { api, type InboxMedia, type InboxMessage, type InboxPlatform, type InboxPost, type InboxThread } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { phoneProblem } from '../../core/phone';
import { Button, EmptyState, Field, Modal, Tabs, cx, inputCls } from '../../components/ui';

type Filter = 'all' | 'message' | 'comment' | 'review';
const PLATFORM: Record<InboxPlatform, { label: string; dot: string; short: string }> = {
  facebook: { label: 'Facebook', dot: 'bg-[#1877F2]', short: 'f' },
  instagram: { label: 'Instagram', dot: 'bg-gradient-to-br from-[#F58529] via-[#DD2A7B] to-[#8134AF]', short: 'ig' },
  google: { label: 'Google', dot: 'bg-[#34A853]', short: 'G' },
};
const KIND: Record<string, string> = { message: 'Message', comment: 'Comment', review: 'Review' };
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};
const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;

const Stars: React.FC<{ n?: number }> = ({ n }) => (n ? (
  <span className="inline-flex items-center gap-0.5" aria-label={`${n} stars`}>
    {Array.from({ length: 5 }, (_, i) => <Star key={i} size={11} className={i < n ? 'fill-[#F5A524] text-[#F5A524]' : 'text-[#C9D6E2]'} />)}
  </span>
) : null);

/** The embed page of a public Instagram post or reel; anything else gets a plain link. */
const instagramEmbed = (url: string) => {
  const hit = /^https:\/\/(?:www\.)?instagram\.com\/(p|reel|reels|tv)\/([\w-]+)/.exec(url);
  return hit ? `https://www.instagram.com/${hit[1] === 'reels' ? 'reel' : hit[1]}/${hit[2]}/embed/` : '';
};

/** A shared post shows itself, loading from Instagram as it scrolls into view; other links stay links. */
const SharedPost: React.FC<{ item: InboxMedia; light: boolean }> = ({ item, light }) => {
  const embed = instagramEmbed(item.url);
  const linkCls = cx('inline-flex items-center gap-1 text-xs font-semibold hover:underline', light ? 'text-white' : 'text-[#0B5E9C]');
  return (
    <span className="block space-y-1.5">
      {!embed && <span className="block text-xs font-semibold">Shared a post{item.name ? `: ${item.name}` : ''}</span>}
      {embed && <iframe src={embed} title="Shared Instagram post" className="block h-[560px] w-[320px] max-w-full rounded-xl border border-[#DBDBDB] bg-white" sandbox="allow-scripts allow-same-origin allow-popups" referrerPolicy="no-referrer" loading="lazy" />}
      <a href={item.url} target="_blank" rel="noopener noreferrer" className={linkCls}>{embed ? 'Open on Instagram' : 'Open'} <ExternalLink size={11} /></a>
    </span>
  );
};

const MediaItem: React.FC<{ item: InboxMedia; light: boolean }> = ({ item, light }) => {
  const [broken, setBroken] = useState(false);
  const open = <a href={item.url} target="_blank" rel="noopener noreferrer" className={cx('inline-flex items-center gap-1 text-xs font-semibold hover:underline', light ? 'text-white' : 'text-[#0B5E9C]')}>{item.type === 'file' ? item.name : `Open the ${item.type}`} <ExternalLink size={11} /></a>;
  if (item.type === 'link') return <SharedPost item={item} light={light} />;
  if (item.type === 'file' || broken) return open;
  if (item.type === 'video') return <video controls preload="metadata" poster={item.preview || undefined} src={item.url} onError={() => setBroken(true)} className="max-h-96 w-[320px] max-w-full rounded-lg bg-black" />;
  return <a href={item.url} target="_blank" rel="noopener noreferrer" className="block"><img src={item.url} alt="Sent in this message" loading="lazy" onError={() => setBroken(true)} className="max-h-96 max-w-full rounded-lg object-contain" /></a>;
};

/** The person's picture, or their initial when Meta gives none or the link has expired; the platform sits on its corner. */
const Avatar: React.FC<{ p: InboxPlatform; name: string; picture?: string; size?: 'md' | 'lg' }> = ({ p, name, picture, size = 'md' }) => {
  const [broken, setBroken] = useState(false);
  const box = size === 'lg' ? 'h-24 w-24 text-3xl' : 'h-12 w-12 text-base';
  return (
    <span className={cx('relative inline-block flex-none rounded-full', box)}>
      {picture && !broken
        ? <img src={picture} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="h-full w-full rounded-full object-cover" />
        : <span className="flex h-full w-full items-center justify-center rounded-full bg-[#DBDBDB] font-semibold text-[#262626]" aria-hidden="true">{(name.replace(/^@/, '')[0] || '?').toUpperCase()}</span>}
      <span title={PLATFORM[p].label} className={cx('absolute -bottom-0.5 -right-0.5 flex h-[18px] w-[18px] items-center justify-center rounded-full text-[8px] font-bold text-white ring-2 ring-white', PLATFORM[p].dot)}>{PLATFORM[p].short}</span>
    </span>
  );
};

/** How a message reads in the list; "You:" stays, the label and link of something shared become words. */
const previewOf = (text: string) => {
  const mine = text.startsWith('You: ');
  const body = mine ? text.slice(5) : text;
  const label = /^\[Shared a post\]/.test(body)
    ? (/\/(reel|reels|tv)\//.test(body) ? 'Sent a reel' : 'Sent a post')
    : /^\[Replied to a story\]/.test(body) ? 'Replied to a story'
      : /^\[Mentioned you in a story\]/.test(body) ? 'Mentioned you in a story'
        : /^\[(attachment|image|video|audio|file)/i.test(body) ? 'Sent an attachment'
          : /^\[Shared content/.test(body) ? 'Shared something' : body;
  return (mine ? 'You: ' : '') + label;
};
const TIME_GAP_MS = 60 * 60000;
const timeLabel = (iso: string) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};

const Badge: React.FC<{ p: InboxPlatform }> = ({ p }) => (
  <span className={cx('inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white', PLATFORM[p].dot)} title={PLATFORM[p].label}>{PLATFORM[p].short}</span>
);

export const InboxView: React.FC<{ canReply: boolean; canCreateLead: boolean; canSync?: boolean; onOpenLead: (id: string) => void; initialThread?: string | null }> = ({ canReply, canCreateLead, canSync, onOpenLead, initialThread }) => {
  const [filter, setFilter] = useState<Filter>('all');
  const [platform, setPlatform] = useState<InboxPlatform | ''>('');
  const [threads, setThreads] = useState<InboxThread[] | null>(null);
  const [active, setActive] = useState<string | null>(initialThread || null);
  const [items, setItems] = useState<InboxMessage[]>([]);
  const [post, setPost] = useState<InboxPost | null>(null);
  const [onlyPost, setOnlyPost] = useState<{ id: string; text: string } | null>(null);
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [limit, setLimit] = useState(100);
  const [hasMore, setHasMore] = useState(false);
  const [leadFor, setLeadFor] = useState<{ name: string; phone: string; email: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const asked = useRef(new Set<string>());
  const [peopleNote, setPeopleNote] = useState('');
  const [askingPeople, setAskingPeople] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const loadList = useCallback(async () => {
    try {
      const r = await api.inbox.list({ platform, kind: filter === 'all' ? '' : filter, limit, parent: onlyPost?.id });
      setThreads(r.threads);
      setHasMore(r.hasMore);
      setPeopleNote(r.peopleNote);
      // who these people are: only those Meta has not been asked about lately, each once per visit
      const ask = r.threads.filter((t) => t.personStale && !asked.current.has(t.thread)).slice(0, 30).map((t) => t.thread);
      if (ask.length) {
        ask.forEach((x) => asked.current.add(x));
        void api.inbox.people(ask).then(({ people }) => {
          const by = new Map(people.map((p) => [p.thread, p]));
          setPeopleNote((n) => people.find((p) => !p.picture && p.reason)?.reason || n);
          setThreads((ts) => ts?.map((t) => { const p = by.get(t.thread); return p ? { ...t, username: p.username, picture: p.picture, authorName: t.authorName || p.name } : t; }) || ts);
        }).catch(() => undefined);
      }
    } catch (e) {
      setThreads((t) => t || []);
      toast('Could not load the inbox', errText('inbox.list', e), 'alert');
    }
  }, [platform, filter, limit, onlyPost]);
  useEffect(() => {
    void loadList();
    const t = setInterval(() => void loadList(), 30000);
    return () => clearInterval(t);
  }, [loadList]);

  const loadThread = useCallback(async (id: string) => {
    try {
      const r = await api.inbox.thread(id);
      setItems(r.items);
      setPost(r.post);
      setThreads((ts) => ts?.map((t) => (t.thread === id ? { ...t, unread: 0 } : t)) || ts);
    } catch (e) {
      toast('Could not open the conversation', errText('inbox.thread', e), 'alert');
    }
  }, []);
  useEffect(() => {
    if (active) void loadThread(active);
    else { setItems([]); setPost(null); }
  }, [active, loadThread]);
  // in braces: browsers can return a promise from scrollIntoView, and React would call an effect's return value as its cleanup
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [items]);

  const current = useMemo(() => threads?.find((t) => t.thread === active) || null, [threads, active]);
  const leadId = items.find((i) => i.leadId)?.leadId || current?.leadId || '';
  const first = items.find((i) => i.direction === 'in');
  const isDm = current?.kind === 'message' || (active || '').includes(':dm:');
  const personName = first?.authorName || current?.authorName || 'Conversation';
  const shownThreads = useMemo(() => {
    const q = search.trim().toLowerCase();
    return !q || !threads ? threads : threads.filter((t) => `${t.authorName} ${t.username} ${t.text}`.toLowerCase().includes(q));
  }, [threads, search]);

  const send = async () => {
    if (!active || !reply.trim()) return;
    setSending(true);
    try {
      await api.inbox.reply(active, reply.trim());
      setReply('');
      await loadThread(active);
      void loadList();
    } catch (e) {
      toast('Reply not sent', errText('inbox.reply', e), 'alert');
    } finally {
      setSending(false);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      const r = await api.inbox.refresh();
      if (r.reviews) toast(`${r.reviews} new Google review${r.reviews === 1 ? '' : 's'}`, undefined, 'success');
      await loadList();
    } catch (e) {
      toast('Could not refresh', errText('inbox.refresh', e), 'alert');
    } finally {
      setRefreshing(false);
    }
  };
  const syncOld = async () => {
    setSyncing(true);
    try {
      const r = await api.inbox.syncOld();
      const said = r.errors.map((e) => `${e.account}: ${e.message}`).join(' · ');
      const more = r.partial ? 'Not everything fitted in one go: click Sync old messages again to continue.' : '';
      toast(`${r.added} old item${r.added === 1 ? '' : 's'} added`, [more, said].filter(Boolean).join(' ') || undefined, said ? 'alert' : r.partial ? 'warning' : 'success');
      await loadList();
    } catch (e) {
      toast('Could not sync old messages', errText('inbox.sync', e), 'alert');
    } finally {
      setSyncing(false);
    }
  };
  /** The people shown now, asked about again at once. */
  const retryPeople = async () => {
    const ask = (threads || []).filter((t) => t.thread.includes(':dm:') && !t.picture).slice(0, 30).map((t) => t.thread);
    if (!ask.length) return;
    setAskingPeople(true);
    try {
      const { people } = await api.inbox.people(ask, true);
      const got = people.filter((p) => p.picture).length;
      toast(`${got} of ${people.length} profile pictures found`, got ? undefined : people.find((p) => p.reason)?.reason, got ? 'success' : 'warning');
      await loadList();
    } catch (e) {
      toast('Could not ask Meta', errText('inbox.people', e), 'alert');
    } finally {
      setAskingPeople(false);
    }
  };
  const createLead = async () => {
    if (!active || !leadFor) return;
    const bad = leadFor.phone ? phoneProblem(leadFor.phone) : 'Enter the phone number';
    if (bad) return toast('Check the phone number', bad, 'alert');
    setCreating(true);
    try {
      const r = await api.inbox.createLead({ thread: active, ...leadFor });
      setLeadFor(null);
      toast('Lead created', r.leadId, 'success');
      await loadThread(active);
      void loadList();
      onOpenLead(r.leadId);
    } catch (e) {
      toast('Could not create the lead', errText('inbox.lead', e), 'alert');
    } finally {
      setCreating(false);
    }
  };

  const list = (
    <div className={cx('flex flex-col min-h-0 border-r border-[#E3EDF5] bg-white', active ? 'hidden lg:flex' : 'flex', 'lg:w-[360px] w-full')}>
      <div className="p-3 space-y-2 border-b border-[#EEF4F9]">
        <div className="flex items-center gap-2">
          <Tabs<Filter> value={filter} onChange={setFilter} tabs={[{ id: 'all', label: 'All' }, { id: 'message', label: 'Messages' }, { id: 'comment', label: 'Comments' }, { id: 'review', label: 'Reviews' }]} />
          {canSync && <Button variant="secondary" size="xs" className="ml-auto" icon={<RefreshCw size={12} className={syncing ? 'animate-spin' : ''} />} disabled={syncing} onClick={() => void syncOld()}>{syncing ? 'Syncing…' : 'Sync old messages'}</Button>}
          <button type="button" onClick={() => void refresh()} aria-label="Refresh Google reviews" title="Check for new Google reviews" className={cx(!canSync && 'ml-auto', 'h-9 w-9 inline-flex items-center justify-center rounded-lg text-[#5E778C] hover:bg-[#F2F7FB]')}><RefreshCw size={15} className={refreshing ? 'animate-spin' : ''} /></button>
        </div>
        <label className="relative block">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#737373]" />
          <input className="w-full rounded-lg bg-[#EFEFEF] py-2 pl-9 pr-3 text-[13px] text-[#262626] placeholder:text-[#737373] focus:outline-none" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" aria-label="Search conversations" />
        </label>
        <select className={inputCls} value={platform} onChange={(e) => setPlatform(e.target.value as InboxPlatform | '')} aria-label="Platform">
          <option value="">Every platform</option>
          <option value="facebook">Facebook</option>
          <option value="instagram">Instagram</option>
          <option value="google">Google reviews</option>
        </select>
        {peopleNote && (
          <details className="rounded-lg bg-[#FFF8F1] px-2.5 py-1.5 text-[11px] text-[#9A3412]">
            <summary className="cursor-pointer font-semibold">Meta is not giving some profile pictures</summary>
            <p className="mt-1 break-words">{peopleNote}</p>
            <button type="button" disabled={askingPeople} className="mt-1 font-semibold text-[#0B5E9C] hover:underline disabled:opacity-50" onClick={() => void retryPeople()}>{askingPeople ? 'Asking…' : 'Try again'}</button>
          </details>
        )}
        {onlyPost && (
          <div className="flex items-center gap-2 rounded-lg bg-[#EEF5FC] px-2.5 py-1.5 text-xs text-[#0B2A44]">
            <span className="min-w-0 flex-1 truncate">Comments on: <b>{onlyPost.text || 'this post'}</b></span>
            <button type="button" className="font-semibold text-[#0B5E9C] hover:underline" onClick={() => setOnlyPost(null)}>Show all</button>
          </div>
        )}
      </div>
      <ul className="flex-1 overflow-y-auto py-1">
        {shownThreads === null ? <li className="p-6 text-center text-xs text-[#7E93A6]">Loading…</li> : !shownThreads.length ? (
          <li className="p-6"><EmptyState icon={<Inbox size={22} />} title={search.trim() ? 'No conversations match' : 'Nothing here yet'} description={search.trim() ? 'Only the conversations loaded so far are searched.' : 'New Facebook and Instagram comments and messages, and Google reviews, arrive here.'} /></li>
        ) : shownThreads.map((t) => (
          <li key={t.thread}>
            <button type="button" onClick={() => setActive(t.thread)} className={cx('flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-[#FAFAFA]', active === t.thread && 'bg-[#EFEFEF] hover:bg-[#EFEFEF]')}>
              <Avatar p={t.platform} name={t.authorName || PLATFORM[t.platform].label} picture={t.picture} />
              <span className="min-w-0 flex-1">
                <span className={cx('flex items-center gap-2 text-sm text-[#262626]', t.unread ? 'font-semibold' : 'font-normal')}>
                  <span className="truncate">{t.authorName || (t.username ? `@${t.username}` : PLATFORM[t.platform].label)}</span>
                  <Stars n={t.rating} />
                </span>
                <span className={cx('flex items-center gap-1 text-xs', t.unread ? 'font-semibold text-[#262626]' : 'text-[#737373]')}>
                  <span className="truncate">{previewOf(t.text || '') || '—'}</span>
                  <span className="flex-none">· {ago(t.at)}</span>
                </span>
                {t.kind !== 'message' && <span className="block truncate text-[10.5px] text-[#737373]">{KIND[t.kind]}{t.kind === 'comment' ? ` on: ${t.postText || 'a post'}` : ''}</span>}
                {t.leadId && <span className="block text-[10.5px] text-[#737373]">Lead {t.leadId}</span>}
              </span>
              {t.kind === 'comment' && t.postImage && <img src={t.postImage} alt="" loading="lazy" className="h-11 w-11 flex-none rounded object-cover" />}
              {t.unread > 0 && <span className="h-2 w-2 flex-none rounded-full bg-[#0095F6]" aria-label="unread" />}
            </button>
          </li>
        ))}
      </ul>
      {hasMore && <div className="border-t border-[#EEF4F9] p-2 text-center"><Button variant="secondary" size="xs" onClick={() => setLimit((n) => n + 100)}>Load more</Button></div>}
    </div>
  );

  const pane = active ? (
    <div className={cx('flex-1 min-w-0 flex flex-col min-h-0', isDm ? 'bg-white' : 'bg-[#F7FAFD]')}>
      <div className="px-3 sm:px-4 py-2.5 border-b border-[#E3EDF5] bg-white flex flex-wrap items-center gap-2">
        <button type="button" className="lg:hidden h-9 w-9 inline-flex items-center justify-center rounded-lg hover:bg-[#F2F7FB]" onClick={() => setActive(null)} aria-label="Back"><ArrowLeft size={16} /></button>
        {current && (isDm ? <span className="scale-75 -mx-1.5 inline-flex"><Avatar p={current.platform} name={personName} picture={current.picture} /></span> : <Badge p={current.platform} />)}
        <span className="min-w-0 flex-1">
          <b className="block truncate text-sm text-[#0B2A44]">{personName}</b>
          <span className="text-[11px] text-[#7E93A6]">{current?.username ? `@${current.username}` : current ? `${PLATFORM[current.platform].label} ${KIND[current.kind].toLowerCase()}` : ''}</span>
        </span>
        {leadId ? (
          <Button variant="secondary" size="sm" icon={<ExternalLink size={13} />} onClick={() => onOpenLead(leadId)}>Open lead {leadId}</Button>
        ) : canCreateLead && first ? (
          <Button variant="secondary" size="sm" icon={<UserPlus size={13} />} onClick={() => setLeadFor({ name: (first.authorName || '').replace(/^@/, ''), phone: '', email: '' })}>Create lead</Button>
        ) : null}
      </div>
      {post && (
        <div className="flex gap-3 border-b border-[#E3EDF5] bg-white px-3 py-2.5 sm:px-4">
          {post.imageUrl && <img src={post.imageUrl} alt="" className="h-16 w-16 flex-none rounded-lg border border-[#E3EDF5] object-cover" />}
          <div className="min-w-0 flex-1">
            <span className="block text-[10.5px] font-bold uppercase tracking-wider text-[#5E778C]">Comments on this post{post.at ? ` · ${new Date(post.at).toLocaleDateString()}` : ''}</span>
            <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap break-words text-xs text-[#0B2A44]">{post.text || 'This post has no caption.'}</p>
            <span className="mt-1 flex flex-wrap gap-3 text-[11px] font-semibold text-[#0B5E9C]">
              <button type="button" className="hover:underline" onClick={() => { setOnlyPost({ id: post.id, text: post.text }); setFilter('comment'); }}>All comments on this post</button>
              {post.url && <a href={post.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">Open post <ExternalLink size={10} /></a>}
            </span>
          </div>
        </div>
      )}
      <div className={cx('flex-1 overflow-y-auto p-3 sm:p-4', isDm ? 'space-y-0.5' : 'space-y-2')}>
        {isDm && current && (
          <div className="flex flex-col items-center pb-6 pt-2 text-center">
            <Avatar p={current.platform} name={personName} picture={current.picture} size="lg" />
            <b className="mt-2 text-lg font-semibold text-[#262626]">{personName}</b>
            <span className="text-sm text-[#737373]">{current.username ? `@${current.username} · ` : ''}{PLATFORM[current.platform].label}</span>
            {current.platform === 'instagram' && current.username && <a href={`https://www.instagram.com/${encodeURIComponent(current.username)}/`} target="_blank" rel="noopener noreferrer" className="mt-3 rounded-lg bg-[#EFEFEF] px-4 py-1.5 text-[13px] font-semibold text-[#262626] hover:bg-[#DBDBDB]">View profile</a>}
          </div>
        )}
        {items.map((m, i) => {
          // like Instagram: something shared stands on its own, without a coloured bubble around it;
          // a label like [Attachment] is only for when the media itself cannot be shown
          const bare = !!m.media?.length && m.text.startsWith('[');
          if (isDm) {
            const before = items[i - 1];
            const gap = !before || Date.parse(m.at) - Date.parse(before.at) >= TIME_GAP_MS;
            const out = m.direction === 'out';
            return (
              <React.Fragment key={m.id}>
                {gap && <p className="py-3 text-center text-xs text-[#737373]">{timeLabel(m.at)}</p>}
                <div title={`${new Date(m.at).toLocaleString()}${m.by ? ` · ${m.by}` : ''}`} className={cx('w-fit max-w-[70%] text-sm', out && 'ml-auto', bare ? 'py-1 text-[#262626]' : cx('rounded-[22px] px-3 py-2', out ? 'bg-[#3797F0] text-white' : 'bg-[#EFEFEF] text-[#262626]'))}>
                  {m.media?.length ? <span className="block space-y-2">{m.media.map((x) => <MediaItem key={x.url} item={x} light={out && !bare} />)}</span> : null}
                  {!bare && <span className="whitespace-pre-wrap break-words">{m.text || <i className="opacity-70">(no text)</i>}</span>}
                </div>
              </React.Fragment>
            );
          }
          return (
            <div key={m.id} className={cx('w-fit max-w-[85%] text-sm', m.direction === 'out' && 'ml-auto', bare ? 'text-[#0B2A44]' : cx('rounded-2xl px-3 py-2 shadow-2xs', m.direction === 'out' ? 'bg-[#1E6FB0] text-white' : 'bg-white text-[#0B2A44] border border-[#E3EDF5]'))}>
              {m.direction === 'in' && <span className="flex items-center gap-2 text-[11px] font-semibold text-[#5E778C] mb-0.5">{m.authorName || 'Customer'} <Stars n={m.rating} /></span>}
              {m.media?.length ? <span className="block space-y-2">{m.media.map((x) => <MediaItem key={x.url} item={x} light={m.direction === 'out' && !bare} />)}</span> : null}
              {!bare && <span className="whitespace-pre-wrap break-words">{m.text || <i className="opacity-70">(no text)</i>}</span>}
              <span className={cx('block text-[10.5px] mt-1', m.direction === 'out' && !bare ? 'text-white/75' : 'text-[#7E93A6]')}>{new Date(m.at).toLocaleString()}{m.by ? ` · ${m.by}` : ''}</span>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>
      {canReply && items.length > 0 && !first && <p className="border-t border-[#E3EDF5] bg-white p-3 text-xs text-[#5E778C]">Only your own messages are in this conversation. Meta lets you reply once the person writes.</p>}
      {canReply && (items.length === 0 || !!first) && (isDm ? (
        <div className="bg-white p-3">
          <div className="flex items-end gap-2 rounded-[22px] border border-[#DBDBDB] px-4 py-2">
            <textarea className="max-h-32 min-h-[22px] flex-1 resize-none bg-transparent text-sm text-[#262626] placeholder:text-[#737373] focus:outline-none" rows={1} value={reply} maxLength={2000} onChange={(e) => setReply(e.target.value)} placeholder="Message…"
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} aria-label="Message" />
            {reply.trim() && <button type="button" disabled={sending} onClick={() => void send()} className="text-sm font-semibold text-[#0095F6] hover:text-[#00376B] disabled:opacity-50">Send</button>}
          </div>
        </div>
      ) : (
        <div className="p-3 border-t border-[#E3EDF5] bg-white flex gap-2 items-end">
          <textarea className={cx(inputCls, 'min-h-[42px] max-h-40 text-sm')} rows={2} value={reply} maxLength={2000} onChange={(e) => setReply(e.target.value)}
            placeholder={current?.kind === 'review' ? 'Reply publicly to the review…' : 'Reply publicly to the comment…'}
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void send(); }} aria-label="Reply" />
          <Button variant="primary" icon={<Send size={14} />} loading={sending} disabled={!reply.trim()} onClick={() => void send()}>Send</Button>
        </div>
      ))}
    </div>
  ) : (
    <div className="hidden lg:flex flex-1 items-center justify-center text-sm text-[#7E93A6] gap-2"><MessageSquare size={18} /> Choose a conversation</div>
  );

  return (
    <div className="p-0 sm:p-4 lg:p-6 max-w-7xl mx-auto">
      <div className="flex h-[calc(100dvh-7.5rem)] min-h-[420px] rounded-none sm:rounded-2xl border border-[#E3EDF5] overflow-hidden bg-white">
        {list}
        {pane}
      </div>
      {leadFor && (
        <Modal open onClose={() => setLeadFor(null)} title="Create a lead from this conversation" width="sm"
          footer={<><Button variant="secondary" onClick={() => setLeadFor(null)}>Cancel</Button><Button variant="primary" loading={creating} onClick={() => void createLead()}>Create lead</Button></>}>
          <div className="space-y-3">
            <Field label="Name"><input className={inputCls} value={leadFor.name} onChange={(e) => setLeadFor((f) => f && { ...f, name: e.target.value })} /></Field>
            <Field label="Phone number" hint="Ask for it in the conversation first."><input className={inputCls} inputMode="tel" value={leadFor.phone} onChange={(e) => setLeadFor((f) => f && { ...f, phone: e.target.value })} /></Field>
            <Field label="E-mail (optional)"><input className={inputCls} type="email" value={leadFor.email} onChange={(e) => setLeadFor((f) => f && { ...f, email: e.target.value })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
};
