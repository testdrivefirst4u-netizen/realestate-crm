/**
 * Post scheduler › Instagram: the account as it looks on Instagram (profile header, three-across grid, a post with its
 * picture beside the caption and comments), with planned posts and drafts in the grid so the feed can be seen ahead.
 * Only real actions are offered: no like or share buttons that would do nothing.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Clapperboard, Clock, ExternalLink, FileText, Heart, Images, MessageCircle, Pencil, Play, RefreshCw, RotateCcw, Trash2, X } from 'lucide-react';
import { api, type InstagramProfile, type PostTargetOption, type SocialPost } from '../../core/api';
import { Button, InlineNotice, cx } from '../../components/ui';
import { errText, postDate } from './postShared';

const PAGE = 60;
const STATUSES = ['scheduled', 'publishing', 'draft', 'published', 'partial'];
const INK = 'text-[#262626]';
const SOFT = 'text-[#737373]';
const nice = (v: number | null) => (v === null ? '—' : v.toLocaleString('en-IN'));
const dayText = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
const shortWhen = (d: Date) => d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
type GridTab = 'posts' | 'reels' | 'planned';
const planned = (p: SocialPost) => p.status === 'scheduled' || p.status === 'draft' || p.status === 'publishing';
const textFor = (p: SocialPost, key: string) => p.targets.find((t) => t.key === key)?.text || p.texts.instagram || p.text;

const Avatar: React.FC<{ picture: string; username: string; size: string; text: string }> = ({ picture, username, size, text }) => (
  <span className={cx('flex flex-none items-center justify-center rounded-full bg-gradient-to-tr from-[#F9CE34] via-[#EE2A7B] to-[#6228D7] p-[2px]', size)}>
    <span className="flex h-full w-full items-center justify-center overflow-hidden rounded-full border-2 border-white bg-[#EFEFEF]">
      {picture ? <img src={picture} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" /> : <span className={cx('font-semibold', SOFT, text)}>{(username[0] || '?').toUpperCase()}</span>}
    </span>
  </span>
);

/** The picture, or what stands in when there is none or Meta's old link has expired. */
const Picture: React.FC<{ src: string; p: SocialPost; className: string }> = ({ src, p, className }) => {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);
  if (src && !broken) return <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className={className} />;
  return <span className={cx('flex items-center justify-center overflow-hidden bg-[#EFEFEF] p-2 text-center text-[11px] sm:text-xs', SOFT, className)}><span className="line-clamp-4 break-words">{p.text || (p.postType === 'post' ? 'No picture' : 'Video')}</span></span>;
};

const Tile: React.FC<{ p: SocialPost; onOpen: () => void }> = ({ p, onOpen }) => {
  const when = postDate(p);
  return (
    <li className="relative">
      <button type="button" onClick={onOpen} aria-label={`Open post from ${dayText(when)}: ${p.text.slice(0, 80) || 'no caption'}`} className="group relative block aspect-[3/4] w-full overflow-hidden bg-[#EFEFEF] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0095F6]">
        <Picture src={p.imageUrl} p={p} className={cx('h-full w-full object-cover', planned(p) && 'opacity-80')} />
        <span className="absolute right-1.5 top-1.5 text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.6)]">
          {p.status === 'draft' ? <FileText size={18} aria-hidden="true" /> : p.postType === 'reel' ? <Clapperboard size={18} aria-hidden="true" /> : p.postType === 'video' ? <Play size={18} className="fill-white" aria-hidden="true" /> : p.imageUrls.length > 1 ? <Images size={18} aria-hidden="true" /> : null}
        </span>
        {planned(p) && <span className="absolute inset-x-0 bottom-0 flex items-center gap-1 bg-black/60 px-1.5 py-1 text-[10px] font-semibold text-white sm:text-[11px]">{p.status === 'draft' ? 'Draft' : <><Clock size={11} aria-hidden="true" /><span className="truncate">{shortWhen(when)}</span></>}</span>}
        {!planned(p) && p.metrics && (
          <span className="absolute inset-0 hidden items-center justify-center gap-4 bg-black/40 text-sm font-semibold text-white group-hover:flex group-focus-visible:flex">
            {p.metrics.likes !== null && <span className="inline-flex items-center gap-1"><Heart size={16} className="fill-white" aria-hidden="true" />{nice(p.metrics.likes)}</span>}
            {p.metrics.comments !== null && <span className="inline-flex items-center gap-1"><MessageCircle size={16} className="fill-white" aria-hidden="true" />{nice(p.metrics.comments)}</span>}
          </span>
        )}
      </button>
    </li>
  );
};

const PostWindow: React.FC<{ post: SocialPost; account: string; profile: InstagramProfile | null; onClose: () => void; onEdit: () => void; onDelete: () => void; onAgain: () => void; onDetails: () => void }> = ({ post, account, profile, onClose, onEdit, onDelete, onAgain, onDetails }) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const [at, setAt] = useState(0);
  const [videoBroken, setVideoBroken] = useState(false);
  const [comments, setComments] = useState<{ rows: Array<{ id: string; author: string; text: string; at: string }> | null; error: string }>({ rows: null, error: '' });
  const target = post.targets.find((t) => t.key === account);
  const out = target?.status === 'posted';
  const username = profile?.username || account.slice('instagram:'.length);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => {
    if (!out) { setComments({ rows: [], error: '' }); return; }
    let live = true;
    api.posts.comments(post.id).then((r) => { if (live) setComments({ rows: r.comments, error: '' }); }).catch((e) => { if (live) setComments({ rows: [], error: errText('posts.comments', e) }); });
    return () => { live = false; };
  }, [post.id, out]);
  const photos = post.imageUrls;
  const when = postDate(post);
  return (
    <dialog ref={dialog} aria-label={`Post by ${username}`} onClose={onClose} onClick={(e) => { if (e.target === dialog.current) onClose(); }} className="m-auto h-[92vh] max-h-[860px] w-[95vw] max-w-[1080px] overflow-hidden rounded-md border-0 bg-white p-0 backdrop:bg-black/70 max-lg:h-[92vh]">
      <div className="flex h-full flex-col lg:flex-row">
        <div className="relative flex min-h-0 flex-[1_1_45%] items-center justify-center bg-black lg:flex-[1_1_60%]">
          {post.videoUrl && !videoBroken ? <video src={post.videoUrl} poster={photos[0]} controls playsInline onError={() => setVideoBroken(true)} className="max-h-full max-w-full" /> : photos[at] ? <Picture src={photos[at]} p={post} className="max-h-full max-w-full object-contain" /> : <p className="p-6 text-center text-sm text-white/80">{post.postType === 'post' ? 'No picture' : 'The video is on Instagram'}</p>}
          {post.postType !== 'post' && (!post.videoUrl || videoBroken) && target?.url && <a href={target.url} target="_blank" rel="noopener noreferrer" className="absolute bottom-3 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-[#262626]"><Play size={13} className="fill-[#262626]" aria-hidden="true" />Watch on Instagram</a>}
          {photos.length > 1 && !post.videoUrl && (
            <>
              {at > 0 && <button type="button" aria-label="Previous photo" onClick={() => setAt(at - 1)} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-1 text-[#262626]"><ChevronLeft size={18} /></button>}
              {at < photos.length - 1 && <button type="button" aria-label="Next photo" onClick={() => setAt(at + 1)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-1 text-[#262626]"><ChevronRight size={18} /></button>}
              <span className="absolute bottom-3 rounded-full bg-black/60 px-2 py-0.5 text-[11px] text-white">{at + 1} of {photos.length}</span>
            </>
          )}
        </div>
        <div className="flex min-h-0 flex-[1_1_55%] flex-col lg:w-[400px] lg:flex-none">
          <header className="flex items-center gap-3 border-b border-[#EFEFEF] p-3">
            <Avatar picture={profile?.picture || ''} username={username} size="h-9 w-9" text="text-xs" />
            <b className={cx('min-w-0 flex-1 truncate text-sm font-semibold', INK)}>{username}</b>
            <button type="button" aria-label="Close" onClick={onClose} className={cx('rounded-full p-1 hover:bg-[#EFEFEF]', INK)}><X size={20} /></button>
          </header>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
            {planned(post) && <InlineNotice tone="info">{post.status === 'draft' ? 'A draft. Nobody can see this yet.' : `Goes out ${shortWhen(when)}. Nobody can see this yet.`}</InlineNotice>}
            {target?.status === 'failed' && <InlineNotice tone="warning">Not posted: {target.error}</InlineNotice>}
            {textFor(post, account) && (
              <div className="flex gap-3">
                <Avatar picture={profile?.picture || ''} username={username} size="h-8 w-8" text="text-[11px]" />
                <p className={cx('min-w-0 whitespace-pre-wrap break-words text-sm', INK)}><b className="mr-1 font-semibold">{username}</b>{textFor(post, account)}</p>
              </div>
            )}
            {comments.error && <p className="text-xs text-[#B42318]">{comments.error}</p>}
            {comments.rows === null && <p className={cx('text-xs', SOFT)}>Loading comments…</p>}
            {comments.rows?.map((c) => (
              <div key={c.id} className="flex gap-3">
                <span aria-hidden="true" className={cx('flex h-8 w-8 flex-none items-center justify-center rounded-full bg-[#EFEFEF] text-[11px] font-semibold', SOFT)}>{(c.author[0] || '?').toUpperCase()}</span>
                <div className="min-w-0">
                  <p className={cx('whitespace-pre-wrap break-words text-sm', INK)}><b className="mr-1 font-semibold">{c.author}</b>{c.text}</p>
                  {c.at && <p className={cx('mt-0.5 text-[11px]', SOFT)}>{new Date(c.at).toLocaleDateString()}</p>}
                </div>
              </div>
            ))}
            {out && comments.rows?.length === 0 && !comments.error && <p className={cx('text-center text-xs', SOFT)}>No comments to show.</p>}
          </div>
          <div className="border-t border-[#EFEFEF] p-3">
            {post.metrics && (
              <p className={cx('text-sm font-semibold', INK)}>
                {post.metrics.likes === null ? 'Likes not available' : `${nice(post.metrics.likes)} like${post.metrics.likes === 1 ? '' : 's'}`} · {post.metrics.comments === null ? 'comments not available' : `${nice(post.metrics.comments)} comment${post.metrics.comments === 1 ? '' : 's'}`}
              </p>
            )}
            <p className={cx('mt-0.5 text-[11px] uppercase', SOFT)}>{dayText(when)}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {(post.status === 'draft' || post.status === 'scheduled') && <Button variant="primary" size="xs" icon={<Pencil size={12} />} onClick={onEdit}>Edit</Button>}
              {out && target?.url && <a href={target.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-[#DBDBDB] px-2 py-1 text-xs font-semibold text-[#262626] hover:bg-[#FAFAFA]">Open on Instagram <ExternalLink size={11} /></a>}
              {out && <Button variant="secondary" size="xs" onClick={onDetails}>Insights and details</Button>}
              {!planned(post) && <Button variant="secondary" size="xs" icon={<RotateCcw size={12} />} onClick={onAgain}>Post again</Button>}
              {out && <Button variant="secondary" size="xs" icon={<Trash2 size={12} />} onClick={onDelete}>Delete</Button>}
            </div>
          </div>
        </div>
      </div>
    </dialog>
  );
};

export const InstagramView: React.FC<{ targets: PostTargetOption[]; rev: number; onCreate: () => void; onEdit: (p: SocialPost) => void; onAgain: (p: SocialPost) => void; onDelete: (p: SocialPost) => void; onDetails: (p: SocialPost) => void }> = ({ targets, rev, onCreate, onEdit, onAgain, onDelete, onDetails }) => {
  const accounts = targets.filter((t) => t.kind === 'instagram');
  const [chosen, setChosen] = useState('');
  const account = accounts.some((a) => a.key === chosen) ? chosen : accounts[0]?.key || '';
  const [profile, setProfile] = useState<InstagramProfile | null>(null);
  const [posts, setPosts] = useState<SocialPost[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [failed, setFailed] = useState('');
  const [tab, setTab] = useState<GridTab>('posts');
  const [opened, setOpened] = useState<SocialPost | null>(null);
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  const loadProfile = useCallback(async (refresh = false) => {
    if (!account) return;
    try {
      setProfile(await api.posts.instagramProfile(account, refresh));
    } catch (e) {
      setFailed(errText('posts.instagramProfile', e));
    }
  }, [account]);
  const loadPosts = useCallback(async (skip = 0) => {
    if (!account) return;
    const mine = ++latest.current;
    setBusy(true);
    try {
      const r = await api.posts.list({ from: '2000-01-01T00:00:00.000Z', statuses: STATUSES, account, skip, limit: PAGE });
      if (mine !== latest.current) return;
      const here = r.posts.filter((p) => ['posted', 'pending'].includes(p.targets.find((t) => t.key === account)?.status || ''));
      setPosts((old) => (skip ? [...(old || []), ...here] : here));
      setHasMore(r.hasMore);
      setFailed('');
    } catch (e) {
      if (mine === latest.current) { setPosts((old) => old || []); setFailed(errText('posts.list', e)); }
    } finally {
      if (mine === latest.current) setBusy(false);
    }
  }, [account]);
  useEffect(() => { setProfile(null); setPosts(null); void loadProfile(); }, [loadProfile]);
  useEffect(() => void loadPosts(), [loadPosts, rev]);

  if (!accounts.length) return <InlineNotice tone="info">No Instagram account is connected yet. An Admin connects it in Settings › Social accounts.</InlineNotice>;

  const username = profile?.username || accounts.find((a) => a.key === account)?.name.replace(/^@/, '') || '';
  const shown = (posts || []).filter((p) => (tab === 'planned' ? planned(p) : tab === 'reels' ? p.postType === 'reel' : p.status !== 'draft'));
  const stat = (v: number | null, label: string) => <li className={cx('text-sm', INK)}><b className="font-semibold">{nice(v)}</b> {label}</li>;
  const finish = (act: () => void) => { setOpened(null); act(); };

  return (
    <div className="mx-auto max-w-[935px] rounded-xl border border-[#DBDBDB] bg-white p-3 sm:p-6">
      <header className="flex items-start gap-4 sm:gap-10 sm:px-6">
        <Avatar picture={profile?.picture || ''} username={username} size="h-20 w-20 sm:h-36 sm:w-36" text="text-2xl sm:text-4xl" />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            {accounts.length > 1 ? (
              <select value={account} onChange={(e) => setChosen(e.target.value)} aria-label="Instagram account" className={cx('max-w-full rounded-lg border border-[#DBDBDB] bg-white px-2 py-1.5 text-base', INK)}>{accounts.map((a) => <option key={a.key} value={a.key}>{a.name.replace(/^@/, '')}</option>)}</select>
            ) : <h2 className={cx('truncate text-xl font-normal', INK)}>{username}</h2>}
            <button type="button" onClick={onCreate} className="rounded-lg bg-[#0095F6] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#1877F2]">Create post</button>
            <a href={`https://www.instagram.com/${encodeURIComponent(username)}/`} target="_blank" rel="noopener noreferrer" className={cx('inline-flex items-center gap-1 rounded-lg bg-[#EFEFEF] px-3 py-1.5 text-sm font-semibold hover:bg-[#DBDBDB]', INK)}>View on Instagram <ExternalLink size={12} /></a>
            <button type="button" aria-label="Refresh" title="Refresh" onClick={() => { void loadProfile(true); void loadPosts(); }} className={cx('rounded-full p-1.5 hover:bg-[#EFEFEF]', INK)}><RefreshCw size={15} className={busy ? 'animate-spin' : ''} /></button>
          </div>
          <ul className="hidden gap-8 sm:flex">{stat(profile?.posts ?? null, 'posts')}{stat(profile?.followers ?? null, 'followers')}{stat(profile?.following ?? null, 'following')}</ul>
          <div className="hidden text-sm sm:block">
            {profile?.name && <p className={cx('font-semibold', INK)}>{profile.name}</p>}
            {profile?.bio && <p className={cx('whitespace-pre-wrap break-words', INK)}>{profile.bio}</p>}
            {profile?.website && <a href={profile.website} target="_blank" rel="noopener noreferrer" className="break-all font-semibold text-[#00376B] hover:underline">{profile.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}</a>}
          </div>
        </div>
      </header>
      <div className="mt-3 sm:hidden">
        {profile?.name && <p className={cx('text-sm font-semibold', INK)}>{profile.name}</p>}
        {profile?.bio && <p className={cx('whitespace-pre-wrap break-words text-sm', INK)}>{profile.bio}</p>}
        <ul className="mt-3 grid grid-cols-3 border-t border-[#DBDBDB] pt-2 text-center">{stat(profile?.posts ?? null, 'posts')}{stat(profile?.followers ?? null, 'followers')}{stat(profile?.following ?? null, 'following')}</ul>
      </div>
      {profile?.error && <div className="mt-3"><InlineNotice tone="warning">Meta did not give the profile details: {profile.error}</InlineNotice></div>}
      {failed && <div className="mt-3"><InlineNotice tone="warning">{failed}</InlineNotice></div>}

      <div role="tablist" aria-label="Posts shown" className="mt-5 flex justify-center gap-10 border-t border-[#DBDBDB]">
        {([['posts', 'Posts'], ['reels', 'Reels'], ['planned', 'Planned']] as Array<[GridTab, string]>).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx('-mt-px border-t py-3 text-xs font-semibold uppercase tracking-wider', tab === id ? cx('border-[#262626]', INK) : cx('border-transparent', SOFT))}>{label}</button>
        ))}
      </div>
      {posts === null ? <p className={cx('p-10 text-center text-sm', SOFT)}>Loading…</p> : !shown.length ? (
        <p className={cx('p-10 text-center text-sm', SOFT)}>{tab === 'planned' ? 'Nothing planned for this account' : tab === 'reels' ? 'No Reels here yet' : 'No posts here yet. Click Sync old posts to bring them in.'}</p>
      ) : (
        <ul className="grid grid-cols-3 gap-0.5 sm:gap-1">{shown.map((p) => <Tile key={p.id} p={p} onOpen={() => setOpened(p)} />)}</ul>
      )}
      {hasMore && <div className="mt-4 text-center"><Button variant="secondary" size="sm" loading={busy} onClick={() => void loadPosts((posts || []).length)}>Load more</Button></div>}
      <p className={cx('mt-4 text-center text-[11px]', SOFT)}>A view of your account, not Instagram itself. The profile picture and bio can only be changed in Instagram, and older pictures can stop loading when Meta's links expire. Sync old posts refreshes them.</p>

      {opened && <PostWindow post={opened} account={account} profile={profile} onClose={() => setOpened(null)} onEdit={() => finish(() => onEdit(opened))} onDelete={() => finish(() => onDelete(opened))} onAgain={() => finish(() => onAgain(opened))} onDetails={() => finish(() => onDetails(opened))} />}
    </div>
  );
};
