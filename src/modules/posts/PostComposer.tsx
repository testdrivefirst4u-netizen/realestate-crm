/**
 * Post scheduler › Create post: the type (post, video, reel, story), the accounts, photos or video, text (the same everywhere or different per platform), a first
 * comment and scheduling on the left, a preview of the post on the chosen platform on the right. Publishes now,
 * schedules, or saves a draft; also edits a draft or a scheduled post.
 */
import React, { useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Bookmark, ChevronLeft, ChevronRight, Film, Globe2, Hash, Heart, ImagePlus, MessageCircle, Send, Share2, Smile, ThumbsUp, Trash2, X } from 'lucide-react';
import { api, type PostTargetKind, type PostTargetOption, type PostType, type SocialPost } from '../../core/api';
import { toast } from '../../core/notifications';
import { Button, cx, inputCls } from '../../components/ui';
import { KIND, STATUS, errText, localInput } from './postShared';

type Mode = 'now' | 'schedule' | 'draft';
interface Picked { fileId: string; previewUrl: string }

const MAX_PHOTOS = 10;
const MAX_VIDEO_MB = 45;
const VIDEO_CHUNK = 3 * 1024 * 1024;
const TYPES: Array<{ id: PostType; label: string; hint: string; kinds: PostTargetKind[] | null }> = [
  { id: 'post', label: 'Post', hint: 'Photos and text, on every connected account.', kinds: null },
  { id: 'video', label: 'Video', hint: 'A video post on Facebook. For Instagram, choose Reel.', kinds: ['facebook'] },
  { id: 'reel', label: 'Reel', hint: 'A short vertical video on Facebook and Instagram.', kinds: ['facebook', 'instagram'] },
  { id: 'story', label: 'Story', hint: 'One photo or video that shows for 24 hours on Facebook and Instagram. No text.', kinds: ['facebook', 'instagram'] },
];
const MAX_HASHTAGS = 30;
const LIMIT: Record<PostTargetKind, number> = { facebook: 3000, instagram: 2200, google: 1500, linkedin: 3000, pinterest: 3000 };
const EMOJI = ['😀', '😍', '🎉', '🔥', '✨', '👍', '🙏', '❤️', '🏠', '🏡', '🏢', '🔑', '📍', '📞', '✅', '⭐', '🌿', '🌇', '💰', '📅'];
const hashtagCount = (text: string) => (text.match(/#[\p{L}\p{N}_]+/gu) || []).length;

const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the image'));
  r.readAsDataURL(file);
});
const section = 'rounded-lg border border-[#DADDE1] bg-white p-4';
const heading = 'text-[15px] font-bold text-[#1C2B33]';
const hostOf = (link: string) => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Instagram shows a carousel one photo at a time. */
const Carousel: React.FC<{ images: string[] }> = ({ images }) => {
  const [at, setAt] = useState(0);
  const i = Math.min(at, images.length - 1);
  const stop = (e: React.SyntheticEvent, next: number) => { e.preventDefault(); e.stopPropagation(); setAt(next); };
  const keys = (next: number) => (e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') stop(e, next); };
  return (
    <span className="relative block">
      <img src={images[i]} alt="" className="aspect-square w-full object-cover" />
      {i > 0 && <span role="button" tabIndex={0} aria-label="Previous photo" onClick={(e) => stop(e, i - 1)} onKeyDown={keys(i - 1)} className="absolute left-2 top-1/2 flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/90 text-[#1C2B33]"><ChevronLeft size={16} /></span>}
      {i < images.length - 1 && <span role="button" tabIndex={0} aria-label="Next photo" onClick={(e) => stop(e, i + 1)} onKeyDown={keys(i + 1)} className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-white/90 text-[#1C2B33]"><ChevronRight size={16} /></span>}
      <span className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white">{i + 1}/{images.length}</span>
      <span className="absolute bottom-2 left-0 right-0 flex justify-center gap-1">{images.map((u, n) => <span key={u + n} className={cx('h-1.5 w-1.5 rounded-full', n === i ? 'bg-[#0866FF]' : 'bg-white/70')} />)}</span>
    </span>
  );
};

/** Facebook shows several photos as a grid, with the rest counted on the last one. */
const PhotoGrid: React.FC<{ images: string[] }> = ({ images }) => {
  if (images.length === 1) return <img src={images[0]} alt="" className="block w-full object-cover" />;
  const shown = images.slice(0, 4);
  const more = images.length - shown.length;
  return (
    <span className="grid grid-cols-2 gap-0.5">
      {shown.map((u, i) => (
        <span key={u + i} className={cx('relative block', shown.length === 3 && i === 0 && 'col-span-2')}>
          <img src={u} alt="" className={cx('block w-full object-cover', shown.length === 3 && i === 0 ? 'aspect-video' : 'aspect-square')} />
          {more > 0 && i === 3 && <span className="absolute inset-0 flex items-center justify-center bg-black/50 text-xl font-bold text-white">+{more}</span>}
        </span>
      ))}
    </span>
  );
};

/** Roughly how the post will look; each platform draws it in its own way. Spans only: a card can sit inside a button. */
export const Preview: React.FC<{ kind: PostTargetKind; name: string; text: string; link: string; image?: string; images?: string[]; when?: string; metrics?: SocialPost['metrics']; postType?: PostType; video?: string; controls?: boolean }> = ({ kind, name, text, link, image, images, when = 'Just now', metrics, postType = 'post', video, controls }) => {
  const photos = images && images.length ? images : image ? [image] : [];
  // a platform's video link can stop working: the cover shows instead
  const [videoBroken, setVideoBroken] = useState(false);
  useEffect(() => setVideoBroken(false), [video]);
  const initial = (name.replace(/^@/, '')[0] || '?').toUpperCase();
  const avatar = <span className={cx('flex h-9 w-9 flex-none items-center justify-center rounded-full text-sm font-bold text-white', KIND[kind].cls)}>{initial}</span>;
  if (postType !== 'post') {
    const label = TYPES.find((t) => t.id === postType)!.label;
    const media = video && !videoBroken
      ? <video src={video} poster={photos[0]} controls={controls} muted preload="metadata" playsInline onError={() => setVideoBroken(true)} className="h-full w-full object-cover" />
      : photos[0] ? <img src={photos[0]} alt="" className="h-full w-full object-cover" />
        : <span className="flex h-full w-full flex-col items-center justify-center gap-1 px-4 text-center text-xs text-white/80"><Film size={22} />{when === 'Just now' ? `Add a video` : 'Posted: open it on the platform to watch'}</span>;
    if (postType === 'video') {
      return (
        <span className="block rounded-lg border border-[#DADDE1] bg-white text-[13px] text-[#1C2B33]">
          <span className="flex items-center gap-2 p-3">{avatar}<span className="min-w-0"><b className="block truncate">{name}</b><span className="text-[11px] text-[#65676B]">{when} · {label}</span></span></span>
          {text && <span className="block whitespace-pre-wrap break-words px-3 pb-3">{text}</span>}
          <span className="block aspect-video w-full bg-[#1C2B33]">{media}</span>
        </span>
      );
    }
    return (
      <span className="relative mx-auto block aspect-[9/16] w-full max-w-[280px] overflow-hidden rounded-xl bg-[#1C2B33] text-white">
        {media}
        <span className="pointer-events-none absolute left-2 right-2 top-2 flex items-center gap-2"><span className="scale-75">{avatar}</span><b className="truncate text-xs drop-shadow">{name.replace(/^@/, '')}</b><span className="ml-auto rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-semibold">{KIND[kind].label} {label}</span></span>
        {postType === 'reel' && text && <span className="pointer-events-none absolute bottom-12 left-2 right-2 line-clamp-3 whitespace-pre-wrap break-words text-xs drop-shadow">{text}</span>}
      </span>
    );
  }
  if (kind === 'instagram') {
    return (
      <span className="block rounded-lg border border-[#DADDE1] bg-white text-[13px] text-[#1C2B33]">
        <span className="flex items-center gap-2 p-2.5">{avatar}<b className="truncate">{name.replace(/^@/, '')}</b></span>
        {photos.length > 1 ? <Carousel images={photos} /> : photos.length ? <img src={photos[0]} alt="" className="aspect-square w-full object-cover" /> : <span className="flex aspect-square w-full items-center justify-center bg-[#F0F2F5] px-6 text-center text-xs text-[#65676B]">Instagram needs an image</span>}
        <span className="flex items-center gap-3 p-2.5"><Heart size={20} /><MessageCircle size={20} /><Send size={20} /><Bookmark size={20} className="ml-auto" /></span>
        {metrics && metrics.likes !== null && <span className="block px-2.5 pb-1 font-semibold">{metrics.likes.toLocaleString('en-IN')} likes</span>}
        <span className="block whitespace-pre-wrap break-words px-2.5 pb-3"><b>{name.replace(/^@/, '')}</b> {text}{link && <span className="block text-[#65676B]">{link}</span>}{metrics && metrics.comments !== null && metrics.comments > 0 && <span className="mt-1 block text-[#65676B]">View all {metrics.comments.toLocaleString('en-IN')} comments</span>}<span className="mt-1 block text-[10px] uppercase text-[#65676B]">{when}</span></span>
      </span>
    );
  }
  return (
    <span className="block rounded-lg border border-[#DADDE1] bg-white text-[13px] text-[#1C2B33]">
      <span className="flex items-center gap-2 p-3">
        {avatar}
        <span className="min-w-0"><b className="block truncate">{name}</b><span className="inline-flex items-center gap-1 text-[11px] text-[#65676B]">{when} <Globe2 size={10} /></span></span>
      </span>
      {text && <span className="block whitespace-pre-wrap break-words px-3 pb-3">{text}</span>}
      {photos.length > 0 && (kind === 'facebook' ? <PhotoGrid images={photos} /> : <img src={photos[0]} alt="" className="block w-full object-cover" />)}
      {link && !photos.length && <span className="block border-y border-[#DADDE1] bg-[#F0F2F5] px-3 py-2"><span className="block text-[10px] uppercase text-[#65676B]">{hostOf(link)}</span><span className="block truncate font-semibold">{link}</span></span>}
      {kind === 'facebook' && metrics && (metrics.likes !== null || metrics.comments !== null) && <span className="flex justify-between gap-2 px-3 py-2 text-xs text-[#65676B]"><span>{metrics.likes !== null && `${metrics.likes.toLocaleString('en-IN')} reactions`}</span><span>{[metrics.comments !== null && `${metrics.comments.toLocaleString('en-IN')} comments`, metrics.shares !== null && `${metrics.shares.toLocaleString('en-IN')} shares`].filter(Boolean).join(' · ')}</span></span>}
      {kind === 'facebook' && <span className="grid grid-cols-3 border-t border-[#DADDE1] py-1 text-xs font-semibold text-[#65676B]"><span className="inline-flex items-center justify-center gap-1.5 py-1.5"><ThumbsUp size={15} /> Like</span><span className="inline-flex items-center justify-center gap-1.5 py-1.5"><MessageCircle size={15} /> Comment</span><span className="inline-flex items-center justify-center gap-1.5 py-1.5"><Share2 size={15} /> Share</span></span>}
    </span>
  );
};

export const PostComposer: React.FC<{ targets: PostTargetOption[]; post?: SocialPost | null; seed?: SocialPost | null; initialWhen?: Date | null; onClose: () => void; onSaved: () => void; onDelete?: (p: SocialPost) => void }> = ({ targets, post, seed, initialWhen, onClose, onSaved, onDelete }) => {
  const from = post || seed;
  const [text, setText] = useState(from?.text || '');
  const [link, setLink] = useState(from?.link || '');
  const [images, setImages] = useState<Picked[]>((from?.imageFileIds || []).map((fileId, i) => ({ fileId, previewUrl: from?.imageUrls?.[i] || `/api/files/${fileId}` })));
  const [texts, setTexts] = useState<Partial<Record<PostTargetKind, string>>>(from?.texts || {});
  const [perPlatform, setPerPlatform] = useState(Object.values(from?.texts || {}).some(Boolean));
  const [textTab, setTextTab] = useState<PostTargetKind | ''>('');
  const [firstComment, setFirstComment] = useState(from?.firstComment || '');
  const [postType, setPostType] = useState<PostType>(from?.postType || 'post');
  const [video, setVideo] = useState<Picked | null>(post?.videoFileId ? { fileId: post.videoFileId, previewUrl: post.videoUrl } : null);
  const [videoProgress, setVideoProgress] = useState(-1);
  const videoRef = useRef<HTMLInputElement>(null);
  // a video picked here and not saved in a post is removed again
  const unsaved = useRef<string[]>([]);
  const [showEmoji, setShowEmoji] = useState(false);
  // accounts that are no longer connected are dropped: they could not be posted to
  const [chosen, setChosen] = useState<string[]>((from?.targets || []).map((t) => t.key).filter((k) => targets.some((t) => t.key === k)));
  const [mode, setMode] = useState<Mode>(post?.status === 'draft' ? 'draft' : post || initialWhen ? 'schedule' : 'now');
  const [when, setWhen] = useState(post?.status === 'scheduled' ? localInput(new Date(post.scheduledAt)) : initialWhen ? localInput(initialWhen) : '');
  const [previewKey, setPreviewKey] = useState('');
  const [busy, setBusy] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const typeDef = TYPES.find((t) => t.id === postType)!;
  const allowed = (k: PostTargetKind) => !typeDef.kinds || typeDef.kinds.includes(k);
  const close = () => {
    unsaved.current.forEach((id) => void api.posts.discardVideo(id).catch(() => undefined));
    onClose();
  };
  const picked = targets.filter((t) => chosen.includes(t.key) && allowed(t.kind));
  const kinds = [...new Set(picked.map((t) => t.kind))];
  const needsImage = picked.filter((t) => t.needsImage);
  const preview = picked.find((t) => t.key === previewKey) || picked[0];
  const textFor = (k: PostTargetKind) => (perPlatform && texts[k]?.trim()) || text;
  const tab = perPlatform && textTab && kinds.includes(textTab) ? textTab : '';
  const current = tab ? texts[tab] || '' : text;
  const setCurrent = (v: string) => (tab ? setTexts((t) => ({ ...t, [tab]: v })) : setText(v));
  const limit = tab ? LIMIT[tab] : perPlatform || !kinds.length ? 3000 : Math.min(...kinds.map((k) => LIMIT[k]));
  const tooLong = kinds.filter((k) => textFor(k).length > LIMIT[k]);
  const igHashtags = kinds.includes('instagram') ? hashtagCount(textFor('instagram')) : 0;
  const isPost = postType === 'post';
  const isStory = postType === 'story';
  const commentable = !isStory && (kinds.includes('facebook') || kinds.includes('instagram'));
  const onlyFirstPhoto = isPost && images.length > 1 ? kinds.filter((k) => k !== 'facebook' && k !== 'instagram') : [];
  const mediaReady = isPost ? !needsImage.length || images.length > 0 : isStory ? !!video || images.length > 0 : !!video;
  const textReady = isPost ? !!text.trim() : true;
  const uploading = videoProgress >= 0;
  const ready = !uploading && (mode === 'draft'
    ? (!!text.trim() || images.length > 0 || !!video) && text.length <= 3000
    : textReady && picked.length > 0 && text.length <= 3000 && !tooLong.length && igHashtags <= MAX_HASHTAGS && mediaReady && (mode === 'now' || !!when));
  const dropVideo = () => {
    if (video && unsaved.current.includes(video.fileId)) {
      void api.posts.discardVideo(video.fileId).catch(() => undefined);
      unsaved.current = unsaved.current.filter((id) => id !== video.fileId);
    }
    setVideo(null);
  };
  const pickVideo = async (file: File | undefined) => {
    if (videoRef.current) videoRef.current.value = '';
    if (!file) return;
    if (!/^video\/(mp4|quicktime)$/.test(file.type)) return toast('Use an MP4 or MOV video', undefined, 'alert');
    if (file.size > MAX_VIDEO_MB * 1024 * 1024) return toast(`The video is larger than ${MAX_VIDEO_MB} MB`, 'Make it shorter or compress it first.', 'alert');
    setVideoProgress(0);
    try {
      const uploadId = crypto.randomUUID();
      const parts = Math.max(1, Math.ceil(file.size / VIDEO_CHUNK));
      for (let i = 0; i < parts; i++) {
        const piece = file.slice(i * VIDEO_CHUNK, (i + 1) * VIDEO_CHUNK);
        await api.posts.uploadVideoPart(uploadId, i, await readBase64(new File([piece], file.name)));
        setVideoProgress(Math.round(((i + 1) / parts) * 100));
      }
      const up = await api.posts.finishVideo({ uploadId, parts, name: file.name, mime: file.type });
      dropVideo();
      unsaved.current = [...unsaved.current, up.fileId];
      setVideo(up);
    } catch (e) {
      toast('Could not upload the video', errText('posts.video', e), 'alert');
    } finally {
      setVideoProgress(-1);
    }
  };

  const insert = (piece: string) => {
    const el = areaRef.current;
    const at = el ? el.selectionStart : current.length;
    const end = el ? el.selectionEnd : current.length;
    setCurrent(current.slice(0, at) + piece + current.slice(end));
    requestAnimationFrame(() => { if (el) { el.focus(); el.selectionStart = el.selectionEnd = at + piece.length; } });
  };

  const addFiles = async (list: FileList | null) => {
    const files = Array.from(list || []);
    if (!files.length) return;
    const room = (isPost ? MAX_PHOTOS : 1) - images.length;
    if (files.length > room) toast(`Up to ${MAX_PHOTOS} photos in a post`, room ? `Only the first ${room} were added.` : undefined, 'warning');
    setBusy('image');
    try {
      for (const f of files.slice(0, Math.max(room, 0))) {
        if (!/^image\/(jpeg|png)$/.test(f.type)) { toast('Use JPG or PNG images', f.name, 'alert'); continue; }
        if (f.size > 3 * 1024 * 1024) { toast('A photo is larger than 3 MB', f.name, 'alert'); continue; }
        const up = await api.posts.uploadImage({ name: f.name, mime: f.type, base64: await readBase64(f) });
        setImages((v) => [...v, up]);
      }
    } catch (e) {
      toast('Could not upload the image', errText('posts.image', e), 'alert');
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const move = (i: number, by: number) => setImages((v) => {
    const out = [...v];
    const [x] = out.splice(i, 1);
    out.splice(i + by, 0, x);
    return out;
  });

  const submit = async () => {
    setBusy('save');
    try {
      const body = {
        text: isStory ? '' : text, link: isPost ? link || undefined : undefined, imageFileIds: images.map((i) => i.fileId), targets: picked.map((t) => t.key), postType, videoFileId: video?.fileId || '',
        texts: perPlatform ? Object.fromEntries(kinds.filter((k) => texts[k]?.trim()).map((k) => [k, texts[k] as string])) : {},
        firstComment: commentable ? firstComment.trim() : '',
        ...(mode === 'draft' ? { draft: true } : mode === 'schedule' ? { scheduledAt: new Date(when).toISOString() } : {}),
      };
      const p = post ? await api.posts.update({ id: post.id, ...body }) : await api.posts.create(body);
      const failed = p.targets.filter((t) => t.status === 'failed').map((t) => `${KIND[t.kind].label}: ${t.error}`);
      const noComment = p.targets.filter((t) => t.commentError).map((t) => `${KIND[t.kind].label} first comment: ${t.commentError}`);
      const said = [...failed, ...noComment].join(' · ');
      unsaved.current = [];
      toast(mode === 'draft' ? 'Draft saved' : mode === 'schedule' ? 'Post scheduled' : p.status === 'published' ? 'Posted' : p.status === 'scheduled' ? 'Instagram is still processing the video' : STATUS[p.status].label, said || (mode === 'now' && p.status === 'scheduled' ? 'It goes out when ready, within a few minutes.' : undefined), failed.length ? 'alert' : noComment.length ? 'warning' : 'success');
      onSaved();
    } catch (e) {
      toast('Not saved', errText('posts.save', e), 'alert');
    } finally {
      setBusy('');
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-label={post ? 'Edit post' : 'Create post'} className="fixed inset-0 z-50 flex flex-col bg-[#F0F2F5]">
      <div className="flex items-center gap-3 border-b border-[#DADDE1] bg-white px-4 py-3">
        <h2 className="flex-1 text-lg font-bold text-[#1C2B33]">{post ? 'Edit post' : 'Create post'}</h2>
        <button type="button" aria-label="Close" onClick={close} className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F0F2F5] text-[#44505C] hover:bg-[#E4E6EB]"><X size={18} /></button>
      </div>

      <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_420px] lg:overflow-hidden">
        <div className="space-y-3 p-4 lg:overflow-y-auto">
          <section className={section}>
            <h3 className={heading}>Type</h3>
            <div role="radiogroup" aria-label="Type" className="mt-3 inline-flex flex-wrap rounded-lg bg-[#F0F2F5] p-0.5">
              {TYPES.map((t) => <button key={t.id} type="button" role="radio" aria-checked={postType === t.id} disabled={!!post && post.status === 'scheduled' && t.id !== postType} onClick={() => { setPostType(t.id); if (t.id !== 'post') setImages((v) => v.slice(0, 1)); }} className={cx('rounded-md px-3.5 py-1.5 text-[13px] font-semibold disabled:opacity-40', postType === t.id ? 'bg-white text-[#0866FF] shadow-sm' : 'text-[#44505C]')}>{t.label}</button>)}
            </div>
            <p className="mt-1.5 text-xs text-[#65676B]">{typeDef.hint}</p>
          </section>

          <section className={section}>
            <h3 className={heading}>Post to</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {targets.filter((t) => allowed(t.kind)).map((t) => {
                const on = chosen.includes(t.key);
                return (
                  <button key={t.key} type="button" aria-pressed={on} onClick={() => setChosen((c) => (on ? c.filter((k) => k !== t.key) : [...c, t.key]))}
                    className={cx('inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold', on ? 'border-[#0866FF] bg-[#E7F0FF] text-[#0B3D91]' : 'border-[#CED0D4] bg-white text-[#44505C] hover:bg-[#F5F6F7]')}>
                    <span className={cx('h-2.5 w-2.5 rounded-full', KIND[t.kind].cls)} />{KIND[t.kind].label} · {t.name}
                  </button>
                );
              })}
            </div>
          </section>

          <section className={section}>
            <h3 className={heading}>Media</h3>
            {isPost ? (
              <p className="mt-0.5 text-xs text-[#65676B]">{needsImage.length ? `A photo is needed for ${[...new Set(needsImage.map((t) => KIND[t.kind].label))].join(' and ')}. ` : ''}Up to {MAX_PHOTOS} JPG or PNG photos, 3 MB each. The first is the cover.</p>
            ) : (
              <p className="mt-0.5 text-xs text-[#65676B]">MP4 or MOV, up to {MAX_VIDEO_MB} MB.{postType === 'reel' ? ' Vertical (9:16) works best. An optional photo becomes the Instagram cover.' : isStory ? ' Or one JPG or PNG photo instead.' : ''}</p>
            )}
            {!isPost && (
              <div className="mt-3">
                {video ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <video src={video.previewUrl} controls muted preload="metadata" className="h-40 rounded-lg bg-black" />
                    <Button variant="secondary" size="sm" icon={<X size={13} />} onClick={dropVideo}>Remove video</Button>
                  </div>
                ) : uploading ? (
                  <div className="max-w-xs" role="status">
                    <p className="text-xs text-[#1C2B33]">Uploading the video… {videoProgress}%</p>
                    <div className="mt-1 h-1.5 rounded-full bg-[#E4E6EB]"><div className="h-1.5 rounded-full bg-[#0866FF]" style={{ width: `${videoProgress}%` }} /></div>
                  </div>
                ) : (
                  <Button variant="secondary" size="sm" icon={<Film size={13} />} onClick={() => videoRef.current?.click()}>Add video</Button>
                )}
                <input ref={videoRef} type="file" accept="video/mp4,video/quicktime" hidden onChange={(e) => void pickVideo(e.target.files?.[0])} />
              </div>
            )}
            {(isPost || postType === 'reel' || (isStory && !video)) && <div className="mt-3 flex flex-wrap gap-2">
              {images.map((img, i) => (
                <div key={img.fileId} className="relative h-24 w-24 overflow-hidden rounded-lg border border-[#DADDE1]">
                  <img src={img.previewUrl} alt={`Photo ${i + 1}`} className="h-full w-full object-cover" />
                  {i === 0 && images.length > 1 && <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 text-[10px] font-semibold text-white">Cover</span>}
                  <button type="button" onClick={() => setImages((v) => v.filter((x) => x.fileId !== img.fileId))} aria-label={`Remove photo ${i + 1}`} className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-[#44505C]"><X size={12} /></button>
                  {images.length > 1 && (
                    <span className="absolute bottom-1 left-1 right-1 flex justify-between">
                      <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move photo ${i + 1} earlier`} className="flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-[#44505C] disabled:opacity-30"><ArrowLeft size={12} /></button>
                      <button type="button" disabled={i === images.length - 1} onClick={() => move(i, 1)} aria-label={`Move photo ${i + 1} later`} className="flex h-5 w-5 items-center justify-center rounded-full bg-white/90 text-[#44505C] disabled:opacity-30"><ArrowRight size={12} /></button>
                    </span>
                  )}
                </div>
              ))}
              {images.length < (isPost ? MAX_PHOTOS : 1) && <Button variant="secondary" size="sm" className="h-24 w-24" icon={<ImagePlus size={13} />} loading={busy === 'image'} onClick={() => fileRef.current?.click()}>{isPost ? 'Add photos' : postType === 'reel' ? 'Add cover' : 'Add photo'}</Button>}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png" multiple={isPost} hidden onChange={(e) => void addFiles(e.target.files)} />
            </div>}
            {onlyFirstPhoto.length > 0 && <p className="mt-2 text-xs text-[#9A3412]">{onlyFirstPhoto.map((k) => KIND[k].label).join(' and ')} will use only the first photo.</p>}
          </section>

          {!isStory && <section className={section}>
            <div className="flex flex-wrap items-center gap-3">
              <h3 className={cx(heading, 'flex-1')}>Post details</h3>
              {kinds.length > 1 && <label className="inline-flex items-center gap-2 text-xs text-[#1C2B33]"><input type="checkbox" className="h-4 w-4 accent-[#0866FF]" checked={perPlatform} onChange={(e) => { setPerPlatform(e.target.checked); setTextTab(''); }} /> Different text for each platform</label>}
            </div>
            {perPlatform && kinds.length > 1 && (
              <div role="tablist" aria-label="Text for" className="mt-3 flex flex-wrap gap-1">
                {[{ id: '' as PostTargetKind | '', label: 'All platforms' }, ...kinds.map((k) => ({ id: k as PostTargetKind | '', label: KIND[k].label }))].map((x) => (
                  <button key={x.id || 'all'} type="button" role="tab" aria-selected={tab === x.id} onClick={() => setTextTab(x.id)} className={cx('rounded-full px-3 py-1 text-xs font-semibold', tab === x.id ? 'bg-[#E7F0FF] text-[#0866FF]' : 'text-[#44505C] hover:bg-[#F5F6F7]')}>{x.label}{x.id && texts[x.id as PostTargetKind]?.trim() ? ' •' : ''}</button>
                ))}
              </div>
            )}
            <label className="mt-3 block text-xs font-semibold text-[#1C2B33]" htmlFor="post-text">{tab ? `Text for ${KIND[tab].label}` : 'Text'}</label>
            <textarea ref={areaRef} id="post-text" className={cx(inputCls, 'mt-1 min-h-[130px] text-sm')} value={current} onChange={(e) => setCurrent(e.target.value)} placeholder={tab ? 'Empty: uses the text for all platforms' : 'What do you want to say?'} />
            <div className="mt-1 flex items-center gap-1">
              <button type="button" aria-label="Add an emoji" aria-expanded={showEmoji} onClick={() => setShowEmoji((v) => !v)} className="flex h-7 w-7 items-center justify-center rounded-lg text-[#44505C] hover:bg-[#F0F2F5]"><Smile size={16} /></button>
              <button type="button" aria-label="Add a hashtag" onClick={() => insert('#')} className="flex h-7 w-7 items-center justify-center rounded-lg text-[#44505C] hover:bg-[#F0F2F5]"><Hash size={16} /></button>
              <span className="ml-auto text-right text-[11px] tabular-nums text-[#65676B]">
                {kinds.includes('instagram') && <span className={cx('mr-3', igHashtags > MAX_HASHTAGS && 'font-semibold text-[#B42318]')}>{igHashtags}/{MAX_HASHTAGS} Instagram hashtags</span>}
                <span className={cx(current.length > limit && 'font-semibold text-[#B42318]')}>{current.length}/{limit}</span>
              </span>
            </div>
            {showEmoji && <div className="mt-1 flex flex-wrap gap-0.5 rounded-lg border border-[#DADDE1] p-1.5">{EMOJI.map((e) => <button key={e} type="button" aria-label={`Add ${e}`} onClick={() => insert(e)} className="flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-[#F0F2F5]">{e}</button>)}</div>}
            {tooLong.length > 0 && <p className="mt-1 text-xs text-[#B42318]">Too long for {tooLong.map((k) => `${KIND[k].label} (${LIMIT[k]})`).join(' and ')}.</p>}
            {isPost && <><label className="mt-3 block text-xs font-semibold text-[#1C2B33]" htmlFor="post-link">Link (optional)</label>
            <input id="post-link" className={cx(inputCls, 'mt-1')} value={link} onChange={(e) => setLink(e.target.value.trim())} placeholder="https://" /></>}
            {commentable && (
              <>
                <label className="mt-3 block text-xs font-semibold text-[#1C2B33]" htmlFor="post-first-comment">First comment (optional)</label>
                <textarea id="post-first-comment" className={cx(inputCls, 'mt-1 min-h-[60px] text-sm')} maxLength={2000} value={firstComment} onChange={(e) => setFirstComment(e.target.value)} placeholder="Added on Facebook and Instagram straight after the post goes out, for example your link or hashtags" />
              </>
            )}
          </section>}

          <section className={section}>
            <h3 className={heading}>Scheduling options</h3>
            <div className="mt-3 space-y-2 text-[13px] text-[#1C2B33]">
              {([['now', 'Publish now', 'Share it straight away.'], ['schedule', 'Schedule', 'Choose a date and time. It goes out within 10 minutes of that time.'], ['draft', 'Save as draft', 'Keep it here and finish it later. Nothing is posted.']] as Array<[Mode, string, string]>).map(([id, label, hint]) => (
                <label key={id} className="flex cursor-pointer items-start gap-2.5">
                  <input type="radio" name="post-mode" className="mt-0.5 h-4 w-4 accent-[#0866FF]" checked={mode === id} onChange={() => setMode(id)} />
                  <span><b className="font-semibold">{label}</b><span className="block text-xs text-[#65676B]">{hint}</span></span>
                </label>
              ))}
              {mode === 'schedule' && <input type="datetime-local" className={cx(inputCls, 'ml-6 w-auto')} min={localInput(new Date())} value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Date and time" />}
            </div>
          </section>
        </div>

        <aside className="border-t border-[#DADDE1] bg-white p-4 lg:overflow-y-auto lg:border-l lg:border-t-0" aria-label="Post preview">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className={cx(heading, 'flex-1')}>Preview</h3>
            {picked.length > 1 && (
              <select className={cx(inputCls, 'w-auto max-w-[220px]')} value={preview?.key} onChange={(e) => setPreviewKey(e.target.value)} aria-label="Preview on">
                {picked.map((t) => <option key={t.key} value={t.key}>{KIND[t.kind].label} · {t.name}</option>)}
              </select>
            )}
          </div>
          <div className="mt-3">
            {preview ? <Preview kind={preview.kind} name={preview.name} text={isStory ? '' : textFor(preview.kind)} link={isPost ? link : ''} postType={postType} video={video?.previewUrl} controls images={(preview.kind === 'facebook' || preview.kind === 'instagram' ? images : images.slice(0, 1)).map((i) => i.previewUrl)} /> : <p className="rounded-lg bg-[#F0F2F5] p-6 text-center text-xs text-[#65676B]">Choose an account to see a preview.</p>}
            {preview && commentable && firstComment.trim() && (preview.kind === 'facebook' || preview.kind === 'instagram') && (
              <div className="mt-2 rounded-xl bg-[#F0F2F5] px-3 py-2 text-xs text-[#1C2B33]"><b className="block font-semibold">{preview.name} · First comment</b><span className="whitespace-pre-wrap break-words">{firstComment}</span></div>
            )}
          </div>
          <p className="mt-2 text-[11px] text-[#65676B]">An approximate preview: the post can look slightly different on each device.</p>
        </aside>
      </div>

      <div className="flex items-center gap-2 border-t border-[#DADDE1] bg-white px-4 py-3">
        {post && onDelete && <Button variant="secondary" icon={<Trash2 size={14} />} onClick={() => onDelete(post)}>Delete</Button>}
        <span className="flex-1" />
        <Button variant="secondary" onClick={close}>Cancel</Button>
        <Button variant="primary" loading={busy === 'save'} disabled={!ready || busy === 'image'} onClick={() => void submit()}>{mode === 'now' ? 'Publish' : mode === 'schedule' ? 'Schedule' : 'Save draft'}</Button>
      </div>
    </div>
  );
};
