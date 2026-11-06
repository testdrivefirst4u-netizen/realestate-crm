/**
 * Business Profile › Photos (server: modules/businessPhotos.ts): the company's own photos by what they show, add and delete,
 * and customers' photos, with the credit Google asks to be shown and Google's request link for removing one.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ExternalLink, ImagePlus, RefreshCw, Trash2 } from 'lucide-react';
import { api, type BusinessPhoto, type BusinessPhotos } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, InlineNotice, cx, inputCls } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const CATEGORIES = [
  { id: 'COVER', label: 'Cover' }, { id: 'PROFILE', label: 'Profile' }, { id: 'EXTERIOR', label: 'Exterior' }, { id: 'INTERIOR', label: 'Interior' }, { id: 'PRODUCT', label: 'Product' },
  { id: 'AT_WORK', label: 'At work' }, { id: 'COMMON_AREA', label: 'Common area' }, { id: 'ROOMS', label: 'Rooms' }, { id: 'TEAMS', label: 'Team' }, { id: 'ADDITIONAL', label: 'Additional' },
];
const nameOf = (c: string) => CATEGORIES.find((x) => x.id === c)?.label || 'Other';
const NO_SIZE_RULE = ['COVER', 'PROFILE'];
const MAX_BYTES = 3 * 1024 * 1024;

const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(new Error('The file could not be read.'));
  r.readAsDataURL(file);
});
const sizeOf = (file: File) => new Promise<{ w: number; h: number }>((resolve, reject) => {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
  img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a readable image.')); };
  img.src = url;
});
/** What Google would refuse, said before uploading. */
async function problemWith(file: File, category: string): Promise<string> {
  if (!/^image\/(jpeg|png)$/.test(file.type)) return 'use a JPG or PNG';
  if (file.size > MAX_BYTES) return 'it is larger than 3 MB';
  if (NO_SIZE_RULE.includes(category)) return '';
  if (file.size < 10240) return 'it is smaller than 10 KB';
  const { w, h } = await sizeOf(file);
  return Math.min(w, h) < 250 ? `it is ${w} × ${h} px, and Google needs at least 250 px on each side` : '';
}
/** The picture for a listing: the cover, else the first photo. */
export const coverOf = (photos: BusinessPhoto[]) => {
  const p = photos.find((x) => x.category === 'COVER' && x.format !== 'VIDEO') || photos.find((x) => x.format !== 'VIDEO');
  return p?.url || p?.thumbnail || '';
};

const Tile: React.FC<{ p: BusinessPhoto; canDelete: boolean; busy: boolean; onDelete: () => void }> = ({ p, canDelete, busy, onDelete }) => (
  <li className="group relative overflow-hidden rounded-lg border border-[#DADCE0] bg-[#F1F3F4]">
    <a href={p.url || undefined} target="_blank" rel="noopener noreferrer" aria-label={`Open ${nameOf(p.category)} ${p.format === 'VIDEO' ? 'video' : 'photo'}`}>
      {p.thumbnail || p.url ? <img src={p.thumbnail || p.url} alt={`${nameOf(p.category)} ${p.format === 'VIDEO' ? 'video' : 'photo'}`} loading="lazy" referrerPolicy="no-referrer" className="aspect-square w-full object-cover" /> : <span className="flex aspect-square items-center justify-center text-xs text-[#5F6368]">No preview</span>}
    </a>
    <div className="flex items-center gap-1 px-2 py-1.5">
      <span className="min-w-0 flex-1 truncate text-[11px] text-[#202124]">{nameOf(p.category)}{p.format === 'VIDEO' ? ' · Video' : ''}</span>
      {canDelete && <button type="button" disabled={busy} aria-label={`Delete ${nameOf(p.category)} photo`} title="Delete" onClick={onDelete} className="flex-none rounded-full p-1.5 text-[#5F6368] hover:bg-white hover:text-[#A50E0E] disabled:opacity-40"><Trash2 size={14} /></button>}
    </div>
  </li>
);

export const PhotosTab: React.FC<{ location: string; canEdit: boolean; onChanged: (photos: BusinessPhoto[]) => void }> = ({ location, canEdit, onChanged }) => {
  const [data, setData] = useState<BusinessPhotos | null>(null);
  const [failed, setFailed] = useState('');
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('ADDITIONAL');
  const [uploading, setUploading] = useState('');
  const [problems, setProblems] = useState<string[]>([]);
  const [removing, setRemoving] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const latest = useRef(0);

  const load = useCallback(async () => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const r = await api.businessProfile.photos(location);
      if (mine !== latest.current) return;
      setData(r);
      setFailed('');
      onChanged(r.photos);
    } catch (e) {
      if (mine === latest.current) setFailed(errText('gbp.photos', e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [location, onChanged]);
  useEffect(() => void load(), [load]);

  const add = async (files: File[]) => {
    const notes: string[] = [];
    let added = 0;
    for (const [i, file] of files.entries()) {
      setUploading(`Adding ${i + 1} of ${files.length}…`);
      try {
        const problem = await problemWith(file, category);
        if (problem) { notes.push(`${file.name}: ${problem}.`); continue; }
        await api.businessProfile.addPhoto({ location, category, name: file.name, mime: file.type, base64: await readBase64(file) });
        added += 1;
      } catch (e) {
        notes.push(`${file.name}: ${errText('gbp.addPhoto', e)}`);
      }
    }
    setUploading('');
    setProblems(notes);
    if (added) {
      toast(`${added} photo${added === 1 ? '' : 's'} sent to Google`, 'It can take a while to appear on your listing.', 'success');
      await load();
    }
  };
  const remove = async (p: BusinessPhoto) => {
    if (!window.confirm(`Delete this ${nameOf(p.category).toLowerCase()} photo from Google? This cannot be undone.`)) return;
    setRemoving(p.name);
    try {
      await api.businessProfile.deletePhoto(location, p.name);
      toast('Photo deleted', undefined, 'success');
      await load();
    } catch (e) {
      toast('Photo not deleted', errText('gbp.deletePhoto', e), 'alert');
    } finally {
      setRemoving('');
    }
  };

  const photos = data?.photos || [];
  const present = CATEGORIES.filter((c) => photos.some((p) => p.category === c.id));
  const shown = filter ? photos.filter((p) => p.category === filter) : photos;
  const single = category === 'COVER' || category === 'PROFILE';
  return (
    <div className="space-y-3">
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {data?.error && <InlineNotice tone="warning">{data.error}</InlineNotice>}
      {!data && !failed && <p className="p-6 text-center text-[13px] text-[#5F6368]">Loading…</p>}
      {canEdit && data && !data.error && (
        <section className="rounded-lg border border-[#DADCE0] bg-white p-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="block text-xs text-[#5F6368]">What the photo shows<select className={cx(inputCls, 'mt-1 w-44')} value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</select></label>
            <input ref={input} type="file" accept="image/jpeg,image/png" multiple={!single} className="sr-only" aria-label="Choose photos" tabIndex={-1} onChange={(e) => { const f = [...(e.target.files || [])]; e.target.value = ''; if (f.length) void add(f); }} />
            <Button variant="primary" size="sm" icon={<ImagePlus size={13} />} loading={!!uploading} onClick={() => input.current?.click()}>{uploading || (single ? 'Add photo' : 'Add photos')}</Button>
            <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} onClick={() => void load()}>Refresh</Button>
          </div>
          <p className="mt-2 text-[11px] text-[#5F6368]">JPG or PNG, up to 3 MB. Google recommends at least 720 × 720 px, and photos that show the real place without heavy filters.{single ? ` A location has only one ${nameOf(category).toLowerCase()} photo, so this should take the place of the current one.` : ''}</p>
          {problems.map((m) => <p key={m} className="mt-1 text-xs text-[#A50E0E]">{m}</p>)}
        </section>
      )}
      {data && !data.error && (
        <>
          <section className="rounded-lg border border-[#DADCE0] bg-white p-4">
            <h2 className="text-[15px] font-medium text-[#202124]">Your photos <span className="font-normal text-[#5F6368]">({data.photos.length})</span></h2>
            {present.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {[{ id: '', label: 'All' }, ...present].map((c) => <button key={c.id || 'all'} type="button" aria-pressed={filter === c.id} onClick={() => setFilter(c.id)} className={cx('rounded-full border px-2.5 py-1 text-xs', filter === c.id ? 'border-[#1A73E8] bg-[#E8F0FE] font-medium text-[#1967D2]' : 'border-[#DADCE0] text-[#3C4043] hover:bg-[#F1F3F4]')}>{c.label}</button>)}
              </div>
            )}
            {!shown.length ? <p className="p-6 text-center text-[13px] text-[#5F6368]">No photos yet</p> : (
              <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">{shown.map((p) => <Tile key={p.name} p={p} canDelete={canEdit} busy={removing === p.name} onDelete={() => void remove(p)} />)}</ul>
            )}
            {data.total > data.photos.length + data.customerTotal && <p className="mt-2 text-[11px] text-[#5F6368]">Showing the first {data.photos.length} of about {data.total}.</p>}
          </section>
          <section className="rounded-lg border border-[#DADCE0] bg-white p-4">
            <h2 className="text-[15px] font-medium text-[#202124]">Photos by customers <span className="font-normal text-[#5F6368]">({data.customerTotal})</span></h2>
            {data.customersError && <div className="mt-2"><InlineNotice tone="warning">{data.customersError}</InlineNotice></div>}
            {!data.customersError && !data.customerPhotos.length && <p className="p-6 text-center text-[13px] text-[#5F6368]">None yet</p>}
            {data.customerPhotos.length > 0 && (
              <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                {data.customerPhotos.map((p) => (
                  <li key={p.name} className="overflow-hidden rounded-lg border border-[#DADCE0] bg-[#F1F3F4]">
                    <a href={p.url || undefined} target="_blank" rel="noopener noreferrer" aria-label={`Open photo by ${p.author || 'a customer'}`}>
                      {p.thumbnail || p.url ? <img src={p.thumbnail || p.url} alt={`By ${p.author || 'a customer'}`} loading="lazy" referrerPolicy="no-referrer" className="aspect-square w-full object-cover" /> : <span className="flex aspect-square items-center justify-center text-xs text-[#5F6368]">No preview</span>}
                    </a>
                    <div className="px-2 py-1.5 text-[11px]">
                      {p.authorUrl ? <a href={p.authorUrl} target="_blank" rel="noopener noreferrer" className="block truncate text-[#1967D2] hover:underline">{p.author || 'Customer'}</a> : <span className="block truncate text-[#202124]">{p.author || 'Customer'}</span>}
                      {p.removalUrl && <a href={p.removalUrl} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex items-center gap-0.5 text-[#5F6368] hover:underline">Request removal <ExternalLink size={10} /></a>}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-2 text-[11px] text-[#5F6368]">Customers' photos can't be deleted here. Google decides on removal requests.</p>
          </section>
        </>
      )}
    </div>
  );
};
