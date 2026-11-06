/**
 * A post in the Content list: the same shape for every platform, so a row lines up. Square picture, three lines of caption,
 * counts at the bottom. Opening the post shows it in full, drawn as its platform draws it. Spans only: it sits inside a button.
 */
import React, { useEffect, useState } from 'react';
import { Film, Heart, Images, MessageCircle, Share2 } from 'lucide-react';
import type { SocialPost } from '../../core/api';
import { cx } from '../../components/ui';
import { KIND } from './postShared';

export const PostCard: React.FC<{ post: SocialPost; when: string }> = ({ post: p, when }) => {
  const t = p.targets[0];
  const [broken, setBroken] = useState(false);
  const src = p.imageUrls[0] || '';
  useEffect(() => setBroken(false), [src]);
  const name = t ? t.name.replace(/^@/, '') : '';
  const text = (t && (t.text || p.texts[t.kind])) || p.text;
  const m = p.metrics;
  const hasCounts = !!m && (m.likes !== null || m.comments !== null || m.shares !== null);
  return (
    <span className="flex h-full flex-col overflow-hidden rounded-lg border border-[#DADDE1] bg-white text-[13px] text-[#1C2B33]">
      <span className="flex items-center gap-2 p-2.5">
        <span className={cx('flex h-8 w-8 flex-none items-center justify-center rounded-full text-xs font-bold text-white', t ? KIND[t.kind].cls : 'bg-[#65676B]')}>{(name[0] || '?').toUpperCase()}</span>
        <span className="min-w-0"><b className="block truncate">{name || 'No account yet'}</b><span className="block truncate text-[11px] text-[#65676B]">{t ? `${KIND[t.kind].label} · ` : ''}{when}</span></span>
      </span>
      <span className="relative block aspect-square w-full flex-none bg-[#F0F2F5]">
        {src && !broken
          ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="absolute inset-0 h-full w-full object-cover" />
          : <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-4 text-center text-xs text-[#65676B]">{p.postType !== 'post' && <Film size={22} aria-hidden="true" />}{p.postType !== 'post' ? 'Video' : src ? "Meta's picture link has expired" : 'No picture'}</span>}
        {p.imageUrls.length > 1 && <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold text-white"><Images size={11} aria-hidden="true" />{p.imageUrls.length}</span>}
        {p.postType !== 'post' && <span className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[10px] font-semibold capitalize text-white">{p.postType}</span>}
      </span>
      <span className="block min-h-[4.4em] flex-1 px-2.5 pt-2 leading-[1.45]"><span className="line-clamp-3 whitespace-pre-line break-words">{text || <span className="text-[#65676B]">No text</span>}</span></span>
      <span className="flex min-h-[32px] items-center gap-3 border-t border-[#EBEDF0] px-2.5 py-1.5 text-xs text-[#65676B]">
        {!hasCounts && <span>No counts yet</span>}
        {m?.likes !== null && m?.likes !== undefined && <span className="inline-flex items-center gap-1"><Heart size={13} aria-hidden="true" />{m.likes.toLocaleString('en-IN')}<span className="sr-only"> likes</span></span>}
        {m?.comments !== null && m?.comments !== undefined && <span className="inline-flex items-center gap-1"><MessageCircle size={13} aria-hidden="true" />{m.comments.toLocaleString('en-IN')}<span className="sr-only"> comments</span></span>}
        {m?.shares !== null && m?.shares !== undefined && <span className="inline-flex items-center gap-1"><Share2 size={13} aria-hidden="true" />{m.shares.toLocaleString('en-IN')}<span className="sr-only"> shares</span></span>}
      </span>
    </span>
  );
};
