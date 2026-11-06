/** A saved ad: a card in the library, and the full view it opens. */
import React, { useState } from 'react';
import { CalendarDays, ExternalLink, Film, Image as ImageIcon, Images, Layers, Type } from 'lucide-react';
import type { CompetitorAd } from '../../core/api';
import { formatDate } from '../../core/dates';
import { Button, Modal, cx } from '../../components/ui';
import { runningDays } from './adLibrary';

const FORMAT: Record<string, { label: string; icon: React.ReactNode }> = {
  image: { label: 'Image', icon: <ImageIcon size={11} aria-hidden="true" /> },
  video: { label: 'Video', icon: <Film size={11} aria-hidden="true" /> },
  carousel: { label: 'Carousel', icon: <Images size={11} aria-hidden="true" /> },
  text: { label: 'Text', icon: <Type size={11} aria-hidden="true" /> },
  other: { label: 'Other', icon: <Layers size={11} aria-hidden="true" /> },
};
const days = (n: number) => (n === 0 ? 'Started today' : `Running ${n} day${n === 1 ? '' : 's'}`);

const StatusPill: React.FC<{ active: boolean }> = ({ active }) => (
  <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold', active ? 'bg-[#E7F6EE] text-[#067647]' : 'bg-[#EEF2F6] text-[#5E778C]')}>
    <span className={cx('h-1.5 w-1.5 rounded-full', active ? 'bg-[#12A150]' : 'bg-[#9AAEBF]')} aria-hidden="true" />
    {active ? 'Active' : 'Inactive'}
  </span>
);

/** The screenshot, or the words of the ad when none was saved or it will not load, so cards keep one shape. */
const Media: React.FC<{ ad: CompetitorAd; name: string; className?: string }> = ({ ad, name, className }) => {
  const [broken, setBroken] = useState(false);
  if (ad.imageUrl && !broken) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={ad.imageUrl} alt={ad.offer || `Ad by ${name}`} loading="lazy" onError={() => setBroken(true)} className={cx('h-full w-full object-contain', className)} />;
  }
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-5 text-center">
      <ImageIcon size={20} className="text-[#9AAEBF]" aria-hidden="true" />
      <p className="line-clamp-4 break-words text-xs text-[#5E778C]">{ad.offer || ad.note || 'No screenshot saved'}</p>
    </div>
  );
};

export const AdCard: React.FC<{ ad: CompetitorAd; name: string; today: string; onOpen: () => void }> = ({ ad, name, today, onOpen }) => {
  const f = FORMAT[ad.format] || FORMAT.other;
  const running = runningDays(ad, today);
  return (
    <article className="group flex h-full flex-col overflow-hidden rounded-xl border border-[#D3E3F0] bg-white transition hover:border-[#9CC3E0] hover:shadow-md">
      <button type="button" onClick={onOpen} className="flex flex-1 flex-col text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#0B6BB0]" aria-label={`Open ad by ${name}${ad.offer ? `: ${ad.offer}` : ''}`}>
        <div className="relative aspect-[4/3] w-full flex-none overflow-hidden bg-[#F2F7FB]">
          <div className="absolute inset-0"><Media ad={ad} name={name} /></div>
          <span className="absolute left-2 top-2"><StatusPill active={ad.active} /></span>
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-white/95 px-2 py-0.5 text-[11px] font-medium text-[#3E5A70]">{f.icon}{f.label}</span>
        </div>
        <div className="flex flex-1 flex-col gap-1.5 p-3">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-[#E3EEF7] text-xs font-bold text-[#0B5E9C]" aria-hidden="true">{(name[0] || '?').toUpperCase()}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[#0B2A44]">{name}</span>
            <span className="flex-none text-[11px] font-medium text-[#5E778C]">{ad.platform === 'google' ? 'Google' : 'Meta'}</span>
          </div>
          {ad.offer && <p className="line-clamp-2 break-words text-[13px] font-semibold leading-snug text-[#0B2A44]">{ad.offer}</p>}
          {(ad.project || ad.price) && <p className="truncate text-xs text-[#3E5A70]">{[ad.project, ad.price].filter(Boolean).join(' · ')}</p>}
          <p className="mt-auto flex items-center gap-1.5 pt-1 text-[11px] text-[#5E778C]">
            <CalendarDays size={12} aria-hidden="true" />
            {running !== null ? <b className="font-semibold text-[#0B2A44]">{days(running)}</b> : `Seen ${formatDate(ad.seenOn)}`}
          </p>
        </div>
      </button>
    </article>
  );
};

const Fact: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div><dt className="text-[11px] text-[#5E778C]">{label}</dt><dd className="break-words text-[13px] font-medium text-[#0B2A44]">{children}</dd></div>
);

export const AdDetail: React.FC<{ ad: CompetitorAd; name: string; today: string; canChange: boolean; busy: boolean; onClose: () => void; onActive: (v: boolean) => void; onRemove: () => void }> = ({ ad, name, today, canChange, busy, onClose, onActive, onRemove }) => {
  const running = runningDays(ad, today);
  const platforms = ad.placements.length ? ad.placements.join(', ') : ad.platform === 'google' ? 'Google' : 'Meta';
  return (
    <Modal open onClose={onClose} width="lg" title={name} subtitle={ad.project || undefined}
      footer={<>
        {canChange && <Button variant="secondary" onClick={onRemove}>Remove</Button>}
        {canChange && <Button variant="secondary" loading={busy} onClick={() => onActive(!ad.active)}>Mark {ad.active ? 'inactive' : 'active'}</Button>}
        {ad.link && <a href={ad.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 rounded-lg bg-[#0B6BB0] px-3 py-2 text-xs font-semibold text-white hover:bg-[#095A94]">See the ad <ExternalLink size={12} aria-hidden="true" /></a>}
      </>}>
      <div className="grid gap-4 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-h-[220px] overflow-hidden rounded-lg bg-[#F2F7FB]">
          {ad.imageUrl ? <a href={ad.imageUrl} target="_blank" rel="noopener noreferrer" className="block h-full" title="Open the full screenshot"><Media ad={ad} name={name} className="max-h-[60vh]" /></a> : <Media ad={ad} name={name} />}
        </div>
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2"><StatusPill active={ad.active} />{running !== null && <span className="text-xs font-semibold text-[#0B2A44]">{days(running)}</span>}</div>
          {ad.offer && <p className="break-words text-base font-bold leading-snug text-[#0B2A44]">{ad.offer}</p>}
          {ad.note && <p className="whitespace-pre-wrap break-words text-[13px] text-[#3E5A70]">{ad.note}</p>}
          <dl className="grid grid-cols-2 gap-3 border-t border-[#E3EDF5] pt-3">
            {ad.price && <Fact label="Price">{ad.price}</Fact>}
            <Fact label="Format">{(FORMAT[ad.format] || FORMAT.other).label}</Fact>
            <Fact label="Platforms">{platforms}</Fact>
            {ad.startedOn && <Fact label="Started">{formatDate(ad.startedOn)}</Fact>}
            <Fact label={ad.active ? 'Last seen' : 'Marked or seen'}>{formatDate(ad.seenOn)}</Fact>
            {ad.libraryId && <Fact label="Library ID">{ad.libraryId}</Fact>}
            <Fact label="Saved by">{ad.createdBy}</Fact>
          </dl>
          <p className="text-[11px] text-[#5E778C]">Status is what your team last recorded, not live from {ad.platform === 'google' ? 'Google' : 'Meta'}.</p>
        </div>
      </div>
    </Modal>
  );
};
