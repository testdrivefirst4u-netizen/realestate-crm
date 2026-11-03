/**
 * Post scheduler (/posts, plan feature socialPosts; server: modules/socialPosts.ts): write a post once, choose the
 * connected accounts, post now or schedule it; see what went out where, retry what failed.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarClock, ExternalLink, ImagePlus, RotateCcw, Send, Trash2, X } from 'lucide-react';
import { api, type PostTargetKind, type PostTargetOption, type SocialPost } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, EmptyState, Field, cx, inputCls } from '../../components/ui';

const KIND: Record<PostTargetKind, { label: string; cls: string }> = {
  facebook: { label: 'Facebook', cls: 'bg-[#1877F2]' },
  instagram: { label: 'Instagram', cls: 'bg-gradient-to-br from-[#F58529] via-[#DD2A7B] to-[#8134AF]' },
  google: { label: 'Google', cls: 'bg-[#34A853]' },
  linkedin: { label: 'LinkedIn', cls: 'bg-[#0A66C2]' },
  pinterest: { label: 'Pinterest', cls: 'bg-[#E60023]' },
};
const STATUS: Record<SocialPost['status'], { label: string; tone: 'sage' | 'amber' | 'rust' | 'muted' | 'navy' }> = {
  scheduled: { label: 'Scheduled', tone: 'navy' }, publishing: { label: 'Posting…', tone: 'amber' }, published: { label: 'Posted', tone: 'sage' }, partial: { label: 'Partly posted', tone: 'amber' }, failed: { label: 'Failed', tone: 'rust' },
};
const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the image'));
  r.readAsDataURL(file);
});

export const PostsView: React.FC = () => {
  const [posts, setPosts] = useState<SocialPost[] | null>(null);
  const [targets, setTargets] = useState<PostTargetOption[]>([]);
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const [image, setImage] = useState<{ fileId: string; previewUrl: string } | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.posts.list();
      setPosts(r.posts);
      setTargets(r.targets);
    } catch (e) {
      setPosts((p) => p || []);
      toast('Could not load posts', errText('posts.list', e), 'alert');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const needsImage = targets.filter((t) => chosen.includes(t.key) && t.needsImage);
  const googleChosen = targets.some((t) => chosen.includes(t.key) && t.kind === 'google');
  const limit = googleChosen ? 1500 : chosen.some((k) => k.startsWith('instagram:')) ? 2200 : 3000;

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

  const submit = async (schedule: boolean) => {
    if (schedule && !when) return toast('Choose the date and time', undefined, 'alert');
    setBusy(schedule ? 'schedule' : 'now');
    try {
      const p = await api.posts.create({ text, link: link || undefined, imageFileId: image?.fileId, targets: chosen, ...(schedule ? { scheduledAt: new Date(when).toISOString() } : {}) });
      toast(schedule ? 'Post scheduled' : p.status === 'published' ? 'Posted' : STATUS[p.status].label, p.targets.filter((t) => t.status === 'failed').map((t) => `${KIND[t.kind].label}: ${t.error}`).join(' · ') || undefined, p.status === 'failed' || p.status === 'partial' ? 'alert' : 'success');
      setText(''); setLink(''); setImage(null); setWhen('');
      await load();
    } catch (e) {
      toast('Could not post', errText('posts.create', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const retry = async (id: string) => {
    setBusy('retry' + id);
    try { await api.posts.retry(id); await load(); } catch (e) { toast('Retry failed', errText('posts.retry', e), 'alert'); } finally { setBusy(''); }
  };
  const remove = async (id: string) => {
    if (!window.confirm('Delete this post?')) return;
    try { await api.posts.remove(id); await load(); } catch (e) { toast('Could not delete', errText('posts.delete', e), 'alert'); }
  };

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-start">
      <Card title="New post" subtitle="One post, published to every account you tick.">
        {!targets.length ? (
          <p className="text-xs text-[#5E778C]">No account connected yet. Platform support connects Facebook / Instagram, Google Business Profile, LinkedIn and Pinterest in Settings.</p>
        ) : (
          <div className="space-y-4">
            <Field label="Post to">
              <div className="flex flex-wrap gap-2">
                {targets.map((t) => {
                  const on = chosen.includes(t.key);
                  return (
                    <button key={t.key} type="button" aria-pressed={on} onClick={() => setChosen((c) => (on ? c.filter((k) => k !== t.key) : [...c, t.key]))}
                      className={cx('inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold', on ? 'border-[#0B2A44] bg-[#0B2A44] text-white' : 'border-[#D3E3F0] bg-white text-[#2B4A63]')}>
                      <span className={cx('h-2.5 w-2.5 rounded-full', KIND[t.kind].cls)} />{KIND[t.kind].label} · {t.name}
                    </button>
                  );
                })}
              </div>
            </Field>
            <Field label={<span className="flex justify-between"><span>Text</span><span className={cx('tabular-nums', text.length > limit ? 'text-[#B42318]' : 'text-[#7E93A6]')}>{text.length}/{limit}</span></span>}>
              <textarea className={cx(inputCls, 'min-h-[140px] text-sm')} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Site visits open this weekend at Amaya by Vera Vita. Book a slot: …" />
            </Field>
            <Field label="Link (optional)"><input className={inputCls} value={link} onChange={(e) => setLink(e.target.value.trim())} placeholder="https://…" /></Field>
            <Field label={`Image${needsImage.length ? ' (needed for ' + [...new Set(needsImage.map((t) => KIND[t.kind].label))].join(' and ') + ')' : ' (optional)'}`}>
              {image ? (
                <div className="relative inline-block">
                  <img src={image.previewUrl} alt="" className="h-32 rounded-lg border border-[#D3E3F0] object-cover" />
                  <button type="button" onClick={() => setImage(null)} aria-label="Remove image" className="absolute -right-2 -top-2 h-6 w-6 inline-flex items-center justify-center rounded-full bg-white border border-[#D3E3F0] text-[#5E778C]"><X size={13} /></button>
                </div>
              ) : (
                <Button variant="secondary" size="sm" icon={<ImagePlus size={13} />} loading={busy === 'image'} onClick={() => fileRef.current?.click()}>Add a JPG or PNG (up to 3 MB)</Button>
              )}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png" hidden onChange={(e) => void pick(e.target.files?.[0])} />
            </Field>
            <div className="flex flex-wrap items-end gap-2 pt-1">
              <Button variant="primary" icon={<Send size={14} />} loading={busy === 'now'} disabled={!text.trim() || !chosen.length || text.length > limit || (!!needsImage.length && !image)} onClick={() => void submit(false)}>Post now</Button>
              <span className="text-xs text-[#7E93A6] px-1">or</span>
              <input type="datetime-local" className={cx(inputCls, 'w-auto')} min={localInput(new Date())} value={when} onChange={(e) => setWhen(e.target.value)} aria-label="Schedule for" />
              <Button variant="secondary" icon={<CalendarClock size={14} />} loading={busy === 'schedule'} disabled={!text.trim() || !chosen.length || !when || text.length > limit || (!!needsImage.length && !image)} onClick={() => void submit(true)}>Schedule</Button>
            </div>
          </div>
        )}
      </Card>

      <Card title="Posts" subtitle="Scheduled posts go out within 10 minutes of their time.">
        {posts === null ? <p className="text-xs text-[#5E778C]">Loading…</p> : !posts.length ? (
          <EmptyState icon={<Send size={20} />} title="No posts yet" description="Posts you publish or schedule appear here with where they went." />
        ) : (
          <ul className="divide-y divide-[#EEF4F9]">
            {posts.map((p) => (
              <li key={p.id} className="py-3 flex gap-3">
                {p.imageUrl && <img src={p.imageUrl} alt="" className="h-14 w-14 rounded-lg object-cover flex-shrink-0 border border-[#E3EDF5]" />}
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                    <span className="text-[#5E778C]">{new Date(p.status === 'scheduled' ? p.scheduledAt : p.publishedAt || p.scheduledAt).toLocaleString()} · {p.createdBy}</span>
                    <span className="ml-auto flex gap-1">
                      {(p.status === 'failed' || p.status === 'partial') && <Button variant="secondary" size="xs" icon={<RotateCcw size={12} />} loading={busy === 'retry' + p.id} onClick={() => void retry(p.id)}>Retry</Button>}
                      {(p.status === 'scheduled' || p.status === 'failed') && <button type="button" aria-label="Delete" onClick={() => void remove(p.id)} className="h-7 w-7 inline-flex items-center justify-center rounded-lg text-[#9A3412] hover:bg-[#FDF2EC]"><Trash2 size={13} /></button>}
                    </span>
                  </div>
                  <p className="text-sm text-[#0B2A44] whitespace-pre-wrap break-words line-clamp-3">{p.text}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {p.targets.map((t) => (
                      <span key={t.key} title={t.error || ''} className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold border', t.status === 'posted' ? 'border-[#BFE3CF] text-[#067647] bg-[#F1FAF5]' : t.status === 'failed' ? 'border-[#F5C2B8] text-[#B42318] bg-[#FEF3F2]' : 'border-[#D3E3F0] text-[#5E778C]')}>
                        <span className={cx('h-2 w-2 rounded-full', KIND[t.kind].cls)} />{t.name}
                        {t.url && <a href={t.url} target="_blank" rel="noopener noreferrer" aria-label={`Open on ${KIND[t.kind].label}`}><ExternalLink size={10} /></a>}
                      </span>
                    ))}
                  </div>
                  {p.targets.filter((t) => t.status === 'failed').map((t) => <p key={t.key} className="text-[11px] text-[#B42318]">{KIND[t.kind].label}: {t.error}</p>)}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
};
