/** Saving an ad seen on Meta or Google: drop or paste the screenshot first, since that is what the team has in hand. */
import React, { useEffect, useRef, useState } from 'react';
import { ImagePlus, X } from 'lucide-react';
import { api } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, Field, InlineNotice, Modal, Select, cx, inputCls, todayInputValue } from '../../components/ui';
import { screenshotProblem } from './adLibrary';

const META_PLACEMENTS = ['Facebook', 'Instagram', 'Messenger', 'Audience Network'];
const GOOGLE_PLACEMENTS = ['Google Search', 'Display', 'YouTube', 'Maps', 'Shopping'];
const FORMATS = [{ value: 'image', label: 'Image' }, { value: 'video', label: 'Video' }, { value: 'carousel', label: 'Carousel' }, { value: 'text', label: 'Text' }, { value: 'other', label: 'Other' }];

const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the screenshot'));
  r.readAsDataURL(file);
});

export const SaveAdModal: React.FC<{ competitors: Array<{ id: string; name: string }>; competitorId: string; onClose: () => void; onSaved: () => void }> = ({ competitors, competitorId, onClose, onSaved }) => {
  const [f, setF] = useState({ competitorId, platform: 'meta', link: '', offer: '', project: '', price: '', format: 'image', note: '', seenOn: todayInputValue(), startedOn: '', active: 'yes' });
  const [placements, setPlacements] = useState<string[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [problem, setProblem] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const options = f.platform === 'google' ? GOOGLE_PLACEMENTS : META_PLACEMENTS;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((v) => ({ ...v, [k]: e.target.value }));

  const take = (next: File | null | undefined) => {
    if (!next) return;
    const why = screenshotProblem(next);
    setProblem(why);
    if (!why) setFile(next);
  };
  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  // a screenshot pasted anywhere in this window
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const image = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith('image/'));
      if (image) { e.preventDefault(); take(image.getAsFile()); }
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, []);

  const save = async () => {
    setBusy(true);
    try {
      const image = file ? { name: file.name || 'screenshot.png', mime: file.type, base64: await readBase64(file) } : undefined;
      await api.competitors.saveAd({ ...f, active: f.active === 'yes', placements: placements.filter((p) => options.includes(p)), image });
      onSaved();
    } catch (e) {
      toast('Not saved', toAppError(reportError('competitors.saveAd', e)).userMessage, 'alert');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} width="lg" title="Save an ad"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} disabled={!f.competitorId} onClick={() => void save()}>Save ad</Button></>}>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          {preview ? (
            <div className="relative overflow-hidden rounded-lg border border-[#D3E3F0] bg-[#F2F7FB]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={preview} alt="The screenshot you chose" className="max-h-80 w-full object-contain" />
              <button type="button" aria-label="Remove the screenshot" onClick={() => setFile(null)} className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-white text-[#3E5A70] shadow hover:bg-[#F2F7FB]"><X size={15} /></button>
            </div>
          ) : (
            <button type="button" onClick={() => picker.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
              onDrop={(e) => { e.preventDefault(); setOver(false); take(e.dataTransfer.files?.[0]); }}
              className={cx('flex min-h-[220px] w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-5 text-center', over ? 'border-[#0B6BB0] bg-[#EAF4FB]' : 'border-[#BCD2E3] bg-[#F7FBFE] hover:bg-[#F2F7FB]')}>
              <ImagePlus size={24} className="text-[#0B6BB0]" aria-hidden="true" />
              <span className="text-sm font-semibold text-[#0B2A44]">Add the screenshot</span>
              <span className="text-xs text-[#5E778C]">Paste with Ctrl+V, drop it here, or click to choose. JPG or PNG, up to 3 MB.</span>
            </button>
          )}
          <input ref={picker} type="file" accept="image/jpeg,image/png" className="sr-only" tabIndex={-1} aria-label="Choose a screenshot" onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }} />
          {problem && <InlineNotice tone="warning">{problem}</InlineNotice>}
          <Field label="Link to the ad" hint="On Meta's Ad Library, copy the ad's link from its menu. The Library ID is read from it."><input className={inputCls} value={f.link} onChange={set('link')} placeholder="https://" /></Field>
        </div>

        <div className="space-y-3">
          <Field label="Competitor"><Select value={f.competitorId} onChange={set('competitorId')} placeholder="Choose" options={competitors.map((c) => ({ value: c.id, label: c.name }))} /></Field>
          <Field label="Offer"><input className={inputCls} value={f.offer} onChange={set('offer')} maxLength={300} placeholder="No pre-EMI till possession…" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Project"><input className={inputCls} value={f.project} onChange={set('project')} maxLength={120} /></Field>
            <Field label="Price"><input className={inputCls} value={f.price} onChange={set('price')} maxLength={120} /></Field>
            <Field label="Seen on"><Select value={f.platform} onChange={set('platform')} options={[{ value: 'meta', label: 'Meta' }, { value: 'google', label: 'Google' }]} /></Field>
            <Field label="Format"><Select value={f.format} onChange={set('format')} options={FORMATS} /></Field>
            <Field label="Date you saw it"><input type="date" className={inputCls} value={f.seenOn} onChange={set('seenOn')} /></Field>
            <Field label="Started running on" hint="Shows how long it has run."><input type="date" className={inputCls} value={f.startedOn} onChange={set('startedOn')} /></Field>
          </div>
          <Field label="Status"><Select value={f.active} onChange={set('active')} options={[{ value: 'yes', label: 'Active' }, { value: 'no', label: 'Inactive' }]} /></Field>
          <Field label="Platforms">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {options.map((p) => <label key={p} className="inline-flex items-center gap-1.5 text-xs text-[#0B2A44]"><input type="checkbox" className="h-3.5 w-3.5" checked={placements.includes(p)} onChange={(e) => setPlacements((v) => (e.target.checked ? [...v, p] : v.filter((x) => x !== p)))} /> {p}</label>)}
            </div>
          </Field>
          <Field label="Note"><textarea className={inputCls} rows={2} value={f.note} onChange={set('note')} maxLength={1000} /></Field>
        </div>
      </div>
    </Modal>
  );
};
