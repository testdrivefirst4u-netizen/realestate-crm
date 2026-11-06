/** Our drawing of the Google listing, used on the Profile tab and beside the edit form. It says it is a preview. */
import React from 'react';
import { Globe, MapPin, Navigation, Phone, Star } from 'lucide-react';
import type { BusinessProfileData, ProfileEdit, ProfileView } from '../../core/api';

const n = (v: number) => Math.round(v).toLocaleString('en-IN');
const STATUS: Record<string, string> = { OPEN: 'Open', CLOSED_TEMPORARILY: 'Temporarily closed', CLOSED_PERMANENTLY: 'Permanently closed' };
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];

function clock(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m || 0).padStart(2, '0')} ${h % 24 < 12 ? 'am' : 'pm'}`;
}

/** What the listing would show with the form's values. */
export function draftView(p: ProfileView, d: ProfileEdit): ProfileView {
  const hours = d.hours.length ? DAYS.map((day) => {
    const today = d.hours.filter((h) => h.day === day);
    const allDay = today.some((h) => h.open === '00:00' && h.close === '24:00');
    return { day: day[0] + day.slice(1).toLowerCase(), text: !today.length ? 'Closed' : allDay ? 'Open 24 hours' : today.map((h) => `${clock(h.open)} to ${clock(h.close)}`).join(', ') };
  }) : [];
  return {
    ...p, title: d.title, phone: d.phone, otherPhones: d.otherPhones, website: /^https?:\/\//i.test(d.website) ? d.website : '', description: d.description, status: d.status,
    category: d.category?.displayName || '', otherCategories: d.otherCategories.map((c) => c.displayName),
    address: [...d.address.lines, d.address.sublocality, d.address.locality, d.address.administrativeArea, d.address.postalCode].filter(Boolean).join(', '), hours,
  };
}

export const Preview: React.FC<{ p: ProfileView; rating: BusinessProfileData['rating']; mapsUri: string; photo?: string }> = ({ p, rating, mapsUri, photo }) => {
  const line = (icon: React.ReactNode, body: React.ReactNode) => <div className="flex gap-3 border-t border-[#F1F3F4] py-2.5 text-[13px] text-[#202124]"><span className="mt-0.5 flex-none text-[#1A73E8]">{icon}</span><div className="min-w-0 break-words">{body}</div></div>;
  const action = (href: string, icon: React.ReactNode, label: string) => <a href={href} target={href.startsWith('tel:') ? undefined : '_blank'} rel="noopener noreferrer" className="flex min-w-0 flex-1 flex-col items-center gap-1 rounded-lg p-2 text-[11px] font-medium text-[#1967D2] hover:bg-[#E8F0FE]"><span className="flex h-9 w-9 items-center justify-center rounded-full border border-[#DADCE0]">{icon}</span>{label}</a>;
  return (
    <section className="overflow-hidden rounded-lg border border-[#DADCE0] bg-white" aria-label="Preview of the listing">
      <p className="bg-[#F1F3F4] px-4 py-1.5 text-[11px] text-[#5F6368]">Preview. The real listing can look different, and also shows other details.</p>
      {photo && <img src={photo} alt="" referrerPolicy="no-referrer" className="aspect-[16/9] w-full object-cover" />}
      <div className="p-4">
        <h2 className="break-words text-[22px] font-normal leading-tight text-[#202124]">{p.title || 'No name'}</h2>
        {rating && rating.total > 0 && (
          <p className="mt-1 flex flex-wrap items-center gap-1 text-[13px] text-[#5F6368]">
            <span className="text-[#202124]">{rating.average.toFixed(1)}</span>
            <span className="inline-flex" aria-hidden="true">{[1, 2, 3, 4, 5].map((s) => <Star key={s} size={13} className={s <= Math.round(rating.average) ? 'fill-[#F9AB00] text-[#F9AB00]' : 'text-[#DADCE0]'} />)}</span>
            <span>{n(rating.total)} Google review{rating.total === 1 ? '' : 's'}</span>
          </p>
        )}
        {p.category && <p className="mt-1 text-[13px] text-[#5F6368]">{p.category}</p>}
        {p.status && p.status !== 'OPEN' && <p className="mt-1 text-[13px] font-medium text-[#A50E0E]">{STATUS[p.status] || p.status}</p>}
        <div className="mt-3 flex gap-1 border-t border-[#F1F3F4] pt-2">
          {p.website && action(p.website, <Globe size={16} />, 'Website')}
          {mapsUri && action(mapsUri, <Navigation size={16} />, 'Directions')}
          {p.phone && action(`tel:${p.phone.replace(/[^\d+]/g, '')}`, <Phone size={16} />, 'Call')}
        </div>
        {p.description && <p className="whitespace-pre-line break-words border-t border-[#F1F3F4] py-2.5 text-[13px] text-[#202124]">{p.description}</p>}
        {p.address && line(<MapPin size={16} />, p.address)}
        {p.website && line(<Globe size={16} />, <a href={p.website} target="_blank" rel="noopener noreferrer" className="break-all text-[#1967D2] hover:underline">{p.website}</a>)}
        {p.phone && line(<Phone size={16} />, p.phone)}
        {p.hours.length > 0 && <div className="border-t border-[#F1F3F4] py-2.5"><dl className="grid grid-cols-[100px_1fr] gap-y-1 text-[13px] text-[#202124]">{p.hours.map((h) => <React.Fragment key={h.day}><dt>{h.day}</dt><dd>{h.text}</dd></React.Fragment>)}</dl></div>}
      </div>
    </section>
  );
};
