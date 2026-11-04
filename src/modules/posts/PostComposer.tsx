/**
 * Post scheduler › Create post: the accounts, media, text and scheduling on the left, a preview of the post on the
 * chosen platform on the right. Publishes now, schedules, or saves a draft; also edits a draft or a scheduled post.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Bookmark, Globe2, Heart, ImagePlus, MessageCircle, Send, Share2, ThumbsUp, Trash2, X } from 'lucide-react';
import { api, type PostTargetKind, type PostTargetOption, type SocialPost } from '../../core/api';
import { toast } from '../../core/notifications';
import { Button, cx, inputCls } from '../../components/ui';
import { KIND, STATUS, errText, localInput } from './postShared';

type Mode = 'now' | 'schedule' | 'draft';

const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the image'));
  r.readAsDataURL(file);
});
const section = 'rounded-lg border border-[#DADDE1] bg-white p-4';
const heading = 'text-[15px] font-bold text-[#1C2B33]';
const hostOf = (link: string) => { try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** Roughly how the post will look; each platform draws it in its own way. */
export const Preview: React.FC<{ kind: PostTargetKind; name: string; text: string; link: string; image: string; when?: string; metrics?: SocialPost['metrics'] }> = ({ kind, name, text, link, image, when = 'Just now', metrics }) => {
  const initial = (name.replace(/^@/, '')[0] || '?').toUpperCase();
  const avatar = <span className={cx('flex h-9 w-9 flex-none items-center justify-center rounded-full text-sm font-bold text-white', KIND[kind].cls)}>{initial}</span>;
  if (kind === 'instagram') {
    return (
      <div className="rounded-lg border border-[#DADDE1] bg-white text-[13px] text-[#1C2B33]">
        <div className="flex items-center gap-2 p-2.5">{avatar}<b className="truncate">{name.replace(/^@/, '')}</b></div>
        {image ? <img src={image} alt="" className="aspect-square w-full object-cover" /> : <div className="flex aspect-square w-full items-center justify-center bg-[#F0F2F5] px-6 text-center text-xs text-[#65676B]">Instagram needs an image</div>}
        <div className="flex items-center gap-3 p-2.5"><Heart size={20} /><MessageCircle size={20} /><Send size={20} /><Bookmark size={20} className="ml-auto" /></div>
        {metrics && metrics.likes !== null && <p className="px-2.5 pb-1 font-semibold">{metrics.likes.toLocaleString('en-IN')} likes</p>}
        <p className="whitespace-pre-wrap break-words px-2.5 pb-3"><b>{name.replace(/^@/, '')}</b> {text}{link && <span className="block text-[#65676B]">{link}</span>}{metrics && metrics.comments !== null && metrics.comments > 0 && <span className="mt-1 block text-[#65676B]">View all {metrics.comments.toLocaleString('en-IN')} comments</span>}<span className="mt-1 block text-[10px] uppercase text-[#65676B]">{when}</span></p>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-[#DADDE1] bg-white text-[13px] text-[#1C2B33]">
      <div className="flex items-center gap-2 p-3">
        {avatar}
        <span className="min-w-0"><b className="block truncate">{name}</b><span className="inline-flex items-center gap-1 text-[11px] text-[#65676B]">{when} <Globe2 size={10} /></span></span>
      </div>
      {text && <p className="whitespace-pre-wrap break-words px-3 pb-3">{text}</p>}
      {image && <img src={image} alt="" className="w-full object-cover" />}
      {link && !image && <div className="border-y border-[#DADDE1] bg-[#F0F2F5] px-3 py-2"><span className="block text-[10px] uppercase text-[#65676B]">{hostOf(link)}</span><span className="block truncate font-semibold">{link}</span></div>}
      {kind === 'facebook' && metrics && <div className="flex justify-between px-3 py-2 text-xs text-[#65676B]"><span>{(metrics.likes ?? 0).toLocaleString('en-IN')} likes</span><span>{(metrics.comments ?? 0).toLocaleString('en-IN')} comments · {(metrics.shares ?? 0).toLocaleString('en-IN')} shares</span></div>}
      {kind === 'facebook' && <div className="grid grid-cols-3 border-t border-[#DADDE1] py-1 text-xs font-semibold text-[#65676B]"><span className="inline-flex items-center justify-center gap-1.5 py-1.5"><ThumbsUp size={15} /> Like</span><span className="inline-flex items-center justify-center gap-1.5 py-1.5"><MessageCircle size={15} /> Comment</span><span className="inline-flex items-center justify-center gap-1.5 py-1.5"><Share2 size={15} /> Share</span></div>}
    </div>
  );
};

export const PostComposer: React.FC<{ targets: PostTargetOption[]; post?: SocialPost | null; seed?: SocialPost | null; initialWhen?: Date | null; onClose: () => void; onSaved: () => void; onDelete?: (p: SocialPost) => void }> = ({ targets, post, seed, initialWhen, onClose, onSaved, onDelete }) => {
  const [text, setText] = useState(post?.text || seed?.text || '');
  const [link, setLink] = useState(post?.link || seed?.link || '');
  const [image, setImage] = useState<{ fileId: string; previewUrl: string } | null>(post?.imageFileId ? { fileId: post.imageFileId, previewUrl: post.imageUrl } : null);
  // accounts that are no longer connected are dropped: they could not be posted to
  const [chosen, setChosen] = useState<string[]>((post?.targets || seed?.targets || []).map((t) => t.key).filter((k) => targets.some((t) => t.key === k)));
  const [mode, setMode] = useState<Mode>(post?.status === 'draft' ? 'draft' : post || initialWhen ? 'schedule' : 'now');
  const [when, setWhen] = useState(post?.status === 'scheduled' ? localInput(new Date(post.scheduledAt)) : initialWhen ? localInput(initialWhen) : '');
  const [previewKey, setPreviewKey] = useState('');
  const [busy, setBusy] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const picked = targets.filter((t) => chosen.includes(t.key));
  const needsImage = picked.filter((t) => t.needsImage);
  const limit = picked.some((t) => t.kind === 'google') ? 1500 : picked.some((t) => t.kind === 'instagram') ? 2200 : 3000;
  const preview = picked.find((t) => t.key === previewKey) || picked[0];
  const ready = mode === 'draft'
    ? (!!text.trim() || !!image) && text.length <= 3000
    : !!text.trim() && picked.length > 0 && text.length <= limit && (!needsImage.length || !!image) && (mode === 'now' || !!when);

  const pick = async (f: File | undefined) => {
    if (!f) return;
    if (!/^image\/(jpeg|png)$/.test(f.type)) return toast('Use a JPG or PNG image', undefined, 'alert');
    if (f.size > 3 * 1024 * 1024) return toast('The image is larger than 3 MB', 'Make it smaller first.', 'alert');
    setBusy('image');
    try {
      setImage(await api.posts.uploadImage({ name: f.name, mime: f.type, base64: await readBase64(f) }));
    } catch (e) {
      toast('Could not upload the image', errText('posts.image', e), 'alert');
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = async () => {
    setBusy('save');
    try {
      const body = { text, link: link || undefined, imageFileId: image?.fileId, targets: chosen, ...(mode === 'draft' ? { draft: true } : mode === 'schedule' ? { scheduledAt: new Date(when).toISOString() } : {}) };
      const p = post ? await api.posts.update({ id: post.id, ...body }) : await api.posts.create(body);
      const failed = p.targets.filter((t) => t.status === 'failed').map((t) => `${KIND[t.kind].label}: ${t.error}`).join(' · ');
      toast(mode === 'draft' ? 'Draft saved' : mode === 'schedule' ? 'Post scheduled' : p.status === 'published' ? 'Posted' : STATUS[p.status].label, failed || undefined, p.status === 'failed' || p.status === 'partial' ? 'alert' : 'success');
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
        <button type="button" aria-label="Close" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full bg-[#F0F2F5] text-[#44505C] hover:bg-[#E4E6EB]"><X size={18} /></button>
      </div>

      <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_420px] lg:overflow-hidden">
        <div className="space-y-3 p-4 lg:overflow-y-auto">
          <section className={section}>
            <h3 className={heading}>Post to</h3>
            <div className="mt-3 flex flex-wrap gap-2">
              {targets.map((t) => {
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
            <p className="mt-0.5 text-xs text-[#65676B]">{needsImage.length ? `An image is needed for ${[...new Set(needsImage.map((t) => KIND[t.kind].label))].join(' and ')}.` : 'One JPG or PNG image, up to 3 MB. Optional.'}</p>
            <div className="mt-3">
              {image ? (
                <div className="relative inline-block">
                  <img src={image.previewUrl} alt="" className="h-32 rounded-lg border border-[#DADDE1] object-cover" />
                  <button type="button" onClick={() => setImage(null)} aria-label="Remove image" className="absolute -right-2 -top-2 inline-flex h-6 w-6 items-center justify-center rounded-full border border-[#DADDE1] bg-white text-[#44505C]"><X size={13} /></button>
                </div>
              ) : (
                <Button variant="secondary" size="sm" icon={<ImagePlus size={13} />} loading={busy === 'image'} onClick={() => fileRef.current?.click()}>Add photo</Button>
              )}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png" hidden onChange={(e) => void pick(e.target.files?.[0])} />
            </div>
          </section>

          <section className={section}>
            <h3 className={heading}>Post details</h3>
            <label className="mt-3 block text-xs font-semibold text-[#1C2B33]" htmlFor="post-text">Text</label>
            <textarea id="post-text" className={cx(inputCls, 'mt-1 min-h-[130px] text-sm')} value={text} onChange={(e) => setText(e.target.value)} placeholder="What do you want to say?" />
            <p className={cx('mt-1 text-right text-[11px] tabular-nums', text.length > limit ? 'text-[#B42318]' : 'text-[#65676B]')}>{text.length}/{limit}</p>
            <label className="block text-xs font-semibold text-[#1C2B33]" htmlFor="post-link">Link (optional)</label>
            <input id="post-link" className={cx(inputCls, 'mt-1')} value={link} onChange={(e) => setLink(e.target.value.trim())} placeholder="https://" />
          </section>

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
            {preview ? <Preview kind={preview.kind} name={preview.name} text={text} link={link} image={image?.previewUrl || ''} /> : <p className="rounded-lg bg-[#F0F2F5] p-6 text-center text-xs text-[#65676B]">Choose an account to see a preview.</p>}
          </div>
          <p className="mt-2 text-[11px] text-[#65676B]">An approximate preview: the post can look slightly different on each device.</p>
        </aside>
      </div>

      <div className="flex items-center gap-2 border-t border-[#DADDE1] bg-white px-4 py-3">
        {post && onDelete && <Button variant="secondary" icon={<Trash2 size={14} />} onClick={() => onDelete(post)}>Delete</Button>}
        <span className="flex-1" />
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy === 'save'} disabled={!ready || busy === 'image'} onClick={() => void submit()}>{mode === 'now' ? 'Publish' : mode === 'schedule' ? 'Schedule' : 'Save draft'}</Button>
      </div>
    </div>
  );
};
