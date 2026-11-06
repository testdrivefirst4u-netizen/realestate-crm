/**
 * Business Profile › edit one part of the listing, with the preview beside it. "Check with Google" tests it without
 * changing anything; "Send to Google" sends only what changed, and Google reviews it before customers see it.
 */
import React, { useEffect, useState } from 'react';
import { CheckCircle2, Plus, Trash2, X } from 'lucide-react';
import { api, type BusinessProfileData, type ProfileEdit } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, InlineNotice, Modal, cx, inputCls } from '../../components/ui';
import { draftView, Preview } from './gbpPreview';

export type EditSection = 'title' | 'categories' | 'description' | 'status' | 'contact' | 'address' | 'hours' | 'special';
/** Which part of the form each row of the details opens. Service area needs Google's place lists, so it stays in Google. */
export const SECTION_OF: Record<string, EditSection | undefined> = { title: 'title', categories: 'categories', profile: 'description', openInfo: 'status', phoneNumbers: 'contact', websiteUri: 'contact', storefrontAddress: 'address', regularHours: 'hours', specialHours: 'special' };
const TITLES: Record<EditSection, string> = { title: 'Business name', categories: 'Category', description: 'Description', status: 'Status', contact: 'Phone and website', address: 'Address', hours: 'Hours', special: 'Special hours' };
const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const dayName = (d: string) => d[0] + d.slice(1).toLowerCase();
const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const label = 'block text-xs text-[#5F6368]';

/** The form's values of one part, which is all that is sent. */
function changesOf(section: EditSection, d: ProfileEdit): Partial<ProfileEdit> {
  switch (section) {
    case 'title': return { title: d.title };
    case 'categories': return { category: d.category, otherCategories: d.otherCategories };
    case 'description': return { description: d.description };
    case 'status': return { status: d.status };
    case 'contact': return { phone: d.phone, otherPhones: d.otherPhones.filter((p) => p.trim()), website: d.website };
    case 'address': return { address: d.address };
    case 'hours': return { hours: d.hours };
    case 'special': return { specialHours: d.specialHours };
  }
}

const CategoryPicker: React.FC<{ regionCode: string; onPick: (c: { name: string; displayName: string }) => void; placeholder: string }> = ({ regionCode, onPick, placeholder }) => {
  const [q, setQ] = useState('');
  const [found, setFound] = useState<Array<{ name: string; displayName: string }>>([]);
  const [failed, setFailed] = useState('');
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setFound([]); return; }
    let live = true;
    const t = setTimeout(() => {
      api.businessProfile.categories(term, regionCode).then((r) => { if (live) { setFound(r); setFailed(''); } }).catch((e) => { if (live) setFailed(errText('gbp.categories', e)); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [q, regionCode]);
  return (
    <div>
      <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder} />
      {failed && <p className="mt-1 text-xs text-[#A50E0E]">{failed}</p>}
      {found.length > 0 && <ul className="mt-1 max-h-40 divide-y divide-[#F1F3F4] overflow-y-auto rounded-lg border border-[#DADCE0]">{found.map((c) => <li key={c.name}><button type="button" className="block w-full px-3 py-2 text-left text-[13px] text-[#202124] hover:bg-[#F1F3F4]" onClick={() => { onPick(c); setQ(''); setFound([]); }}>{c.displayName}</button></li>)}</ul>}
    </div>
  );
};

export const EditDialog: React.FC<{ section: EditSection; data: BusinessProfileData; onClose: () => void; onSaved: (fresh: BusinessProfileData) => void }> = ({ section, data, onClose, onSaved }) => {
  const [d, setD] = useState<ProfileEdit>(() => JSON.parse(JSON.stringify(data.edit)));
  const [busy, setBusy] = useState<'' | 'check' | 'send'>('');
  const [problem, setProblem] = useState('');
  const [checked, setChecked] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const set = (patch: Partial<ProfileEdit>) => { setD((x) => ({ ...x, ...patch })); setChecked(''); setProblem(''); };
  const sensitive = section === 'title' || section === 'address' || section === 'categories' || (section === 'status' && d.status === 'CLOSED_PERMANENTLY');

  const submit = async (validateOnly: boolean) => {
    setBusy(validateOnly ? 'check' : 'send');
    setProblem('');
    setChecked('');
    try {
      const r = await api.businessProfile.update({ location: data.location, version: data.version, changes: changesOf(section, d), validateOnly, confirm: confirmed });
      if (validateOnly) {
        setChecked('Google accepts this. Nothing has been changed.');
      } else {
        toast('Sent to Google', `${r.changed.join(', ')}. Google reviews it first, usually within minutes but sometimes up to 30 days.`, 'success');
        if (r.profile) onSaved(r.profile);
      }
    } catch (e) {
      setProblem(errText('gbp.update', e));
    } finally {
      setBusy('');
    }
  };

  const hoursRow = (day: string) => {
    const rows = d.hours.map((h, i) => ({ h, i })).filter((x) => x.h.day === day);
    const change = (i: number, patch: Partial<ProfileEdit['hours'][number]>) => set({ hours: d.hours.map((h, j) => (j === i ? { ...h, ...patch } : h)) });
    return (
      <div key={day} className="grid gap-1 border-t border-[#F1F3F4] py-2 sm:grid-cols-[92px_1fr]">
        <span className="pt-1.5 text-[13px] text-[#202124]">{dayName(day)}</span>
        <div className="space-y-1.5">
          {!rows.length && <span className="inline-block pt-1.5 text-[13px] text-[#5F6368]">Closed</span>}
          {rows.map(({ h, i }) => (
            <div key={i} className="flex flex-wrap items-center gap-1.5">
              <input type="time" className={cx(inputCls, 'w-[7.5rem] py-1.5')} value={h.open} aria-label={`${dayName(day)} opens`} onChange={(e) => change(i, { open: e.target.value })} />
              <span className="text-xs text-[#5F6368]">to</span>
              {h.close === '24:00' ? <span className="w-[7.5rem] text-[13px] text-[#202124]">Midnight</span> : <input type="time" className={cx(inputCls, 'w-[7.5rem] py-1.5')} value={h.close} aria-label={`${dayName(day)} closes`} onChange={(e) => change(i, { close: e.target.value })} />}
              <label className="inline-flex items-center gap-1 text-[11px] text-[#5F6368]"><input type="checkbox" className="h-3.5 w-3.5 accent-[#1A73E8]" checked={h.close === '24:00'} onChange={(e) => change(i, { close: e.target.checked ? '24:00' : '18:00' })} />Until midnight</label>
              <button type="button" aria-label={`Remove ${dayName(day)} hours`} className="rounded-full p-1.5 text-[#5F6368] hover:bg-[#F1F3F4]" onClick={() => set({ hours: d.hours.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
            </div>
          ))}
          <div className="flex flex-wrap gap-3">
            <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-[#1967D2] hover:underline" onClick={() => set({ hours: [...d.hours, { day, open: '09:00', close: '18:00' }] })}><Plus size={12} />Add hours</button>
            <button type="button" className="text-xs font-medium text-[#1967D2] hover:underline" onClick={() => set({ hours: [...d.hours.filter((h) => h.day !== day), { day, open: '00:00', close: '24:00' }] })}>Open 24 hours</button>
          </div>
        </div>
      </div>
    );
  };

  return (
    <Modal open onClose={onClose} title={`Edit: ${TITLES[section]}`} width="lg" footer={
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
        <Button variant="secondary" size="sm" loading={busy === 'check'} disabled={!!busy} onClick={() => void submit(true)}>Check with Google</Button>
        <Button variant="primary" size="sm" loading={busy === 'send'} disabled={!!busy || (sensitive && !confirmed)} onClick={() => void submit(false)}>Send to Google</Button>
      </div>
    }>
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="min-w-0 space-y-3">
          {problem && <InlineNotice tone="warning">{problem}</InlineNotice>}
          {checked && <p className="inline-flex items-center gap-1.5 text-xs font-medium text-[#137333]"><CheckCircle2 size={15} />{checked}</p>}

          {section === 'title' && (
            <label className={label}>Business name<input className={cx(inputCls, 'mt-1')} value={d.title} onChange={(e) => set({ title: e.target.value })} /><span className="mt-1 block text-[11px]">Use the real-world name. Google says not to add taglines, store codes, special characters, hours or open/closed status.</span></label>
          )}
          {section === 'description' && (
            <label className={label}>Description<textarea rows={7} className={cx(inputCls, 'mt-1')} value={d.description} onChange={(e) => set({ description: e.target.value })} /><span className={cx('mt-1 block text-right text-[11px]', d.description.length > 750 && 'font-medium text-[#A50E0E]')}>{d.description.length} / 750</span></label>
          )}
          {section === 'status' && (
            <div className="space-y-1">
              {[{ id: 'OPEN', t: 'Open' }, { id: 'CLOSED_TEMPORARILY', t: 'Temporarily closed' }, { id: 'CLOSED_PERMANENTLY', t: 'Permanently closed' }].map((o) => <label key={o.id} className="flex cursor-pointer items-center gap-2.5 py-1 text-[13px] text-[#202124]"><input type="radio" name="gbp-status" className="h-4 w-4 accent-[#1A73E8]" checked={d.status === o.id} onChange={() => set({ status: o.id })} />{o.t}</label>)}
            </div>
          )}
          {section === 'contact' && (
            <>
              <label className={label}>Primary phone<input className={cx(inputCls, 'mt-1')} value={d.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="+91 98765 43210" /></label>
              {[0, 1].map((i) => <label key={i} className={label}>Other phone {i + 1} (optional)<input className={cx(inputCls, 'mt-1')} value={d.otherPhones[i] || ''} onChange={(e) => { const o = [d.otherPhones[0] || '', d.otherPhones[1] || '']; o[i] = e.target.value; set({ otherPhones: o }); }} /></label>)}
              <label className={label}>Website<input className={cx(inputCls, 'mt-1')} value={d.website} onChange={(e) => set({ website: e.target.value })} placeholder="https://" /></label>
            </>
          )}
          {section === 'address' && (
            <>
              {[0, 1].map((i) => <label key={i} className={label}>Address line {i + 1}<input className={cx(inputCls, 'mt-1')} value={d.address.lines[i] || ''} onChange={(e) => { const l = [d.address.lines[0] || '', d.address.lines[1] || '']; l[i] = e.target.value; set({ address: { ...d.address, lines: l.filter((x, j) => x || j === 0) } }); }} /></label>)}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className={label}>City<input className={cx(inputCls, 'mt-1')} value={d.address.locality} onChange={(e) => set({ address: { ...d.address, locality: e.target.value } })} /></label>
                <label className={label}>Area (optional)<input className={cx(inputCls, 'mt-1')} value={d.address.sublocality} onChange={(e) => set({ address: { ...d.address, sublocality: e.target.value } })} /></label>
                <label className={label}>State<input className={cx(inputCls, 'mt-1')} value={d.address.administrativeArea} onChange={(e) => set({ address: { ...d.address, administrativeArea: e.target.value } })} /></label>
                <label className={label}>PIN code<input className={cx(inputCls, 'mt-1')} value={d.address.postalCode} onChange={(e) => set({ address: { ...d.address, postalCode: e.target.value } })} /></label>
              </div>
            </>
          )}
          {section === 'categories' && (
            <>
              <div className={label}>Primary category<p className="mt-1 text-[13px] font-medium text-[#202124]">{d.category?.displayName || 'None'}</p></div>
              <CategoryPicker regionCode={d.regionCode} placeholder="Search to change the primary category" onPick={(c) => set({ category: c, otherCategories: d.otherCategories.filter((x) => x.name !== c.name) })} />
              <div className={label}>Other categories
                <div className="mt-1 flex flex-wrap gap-1.5">
                  {!d.otherCategories.length && <span className="text-[13px] text-[#5F6368]">None</span>}
                  {d.otherCategories.map((c) => <span key={c.name} className="inline-flex items-center gap-1 rounded-full border border-[#DADCE0] py-0.5 pl-2.5 pr-1 text-xs text-[#202124]">{c.displayName}<button type="button" aria-label={`Remove ${c.displayName}`} className="rounded-full p-0.5 hover:bg-[#F1F3F4]" onClick={() => set({ otherCategories: d.otherCategories.filter((x) => x.name !== c.name) })}><X size={12} /></button></span>)}
                </div>
              </div>
              <CategoryPicker regionCode={d.regionCode} placeholder="Search to add another category" onPick={(c) => { if (c.name !== d.category?.name && !d.otherCategories.some((x) => x.name === c.name)) set({ otherCategories: [...d.otherCategories, c] }); }} />
            </>
          )}
          {section === 'hours' && <div>{DAYS.map(hoursRow)}</div>}
          {section === 'special' && (
            <div className="space-y-2">
              {!d.specialHours.length && <p className="text-[13px] text-[#5F6368]">No special hours. Use these for holidays and one-off days.</p>}
              {d.specialHours.map((s, i) => {
                const change = (patch: Partial<ProfileEdit['specialHours'][number]>) => set({ specialHours: d.specialHours.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
                return (
                  <div key={i} className="flex flex-wrap items-center gap-1.5 border-t border-[#F1F3F4] pt-2">
                    <input type="date" className={cx(inputCls, 'w-auto py-1.5')} value={s.date} aria-label="Date" onChange={(e) => change({ date: e.target.value })} />
                    <label className="inline-flex items-center gap-1 text-xs text-[#202124]"><input type="checkbox" className="h-3.5 w-3.5 accent-[#1A73E8]" checked={s.closed} onChange={(e) => change({ closed: e.target.checked, open: e.target.checked ? '' : '09:00', close: e.target.checked ? '' : '18:00' })} />Closed</label>
                    {!s.closed && <><input type="time" className={cx(inputCls, 'w-[7.5rem] py-1.5')} value={s.open} aria-label="Opens" onChange={(e) => change({ open: e.target.value })} /><span className="text-xs text-[#5F6368]">to</span><input type="time" className={cx(inputCls, 'w-[7.5rem] py-1.5')} value={s.close} aria-label="Closes" onChange={(e) => change({ close: e.target.value })} /></>}
                    <button type="button" aria-label="Remove this day" className="rounded-full p-1.5 text-[#5F6368] hover:bg-[#F1F3F4]" onClick={() => set({ specialHours: d.specialHours.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
                  </div>
                );
              })}
              <button type="button" className="inline-flex items-center gap-1 text-xs font-medium text-[#1967D2] hover:underline" onClick={() => set({ specialHours: [...d.specialHours, { date: '', closed: true, open: '', close: '' }] })}><Plus size={12} />Add a day</button>
            </div>
          )}

          {sensitive && (
            <div className="rounded-lg border border-[#F9DEAA] bg-[#FEF7E0] p-3">
              <p className="text-xs text-[#5F4B00]">{section === 'status' ? 'Permanently closed tells customers on Google Search and Maps that the business no longer exists.' : 'Changing this can make Google review the profile closely, and may ask you to verify the business again.'}</p>
              <label className="mt-2 flex items-start gap-2 text-xs font-medium text-[#3C3000]"><input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#1A73E8]" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />I understand, and this is correct</label>
            </div>
          )}
          <p className="text-[11px] text-[#5F6368]">Check with Google tests this without changing anything. Send to Google publishes it after Google's review.</p>
        </div>
        {data.profile && <Preview p={draftView(data.profile, d)} rating={data.rating} mapsUri={data.mapsUri} />}
      </div>
    </Modal>
  );
};
