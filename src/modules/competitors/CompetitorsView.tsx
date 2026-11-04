/**
 * Competitor ads (/competitors, plan feature competitorAds; server: modules/competitors.ts): the company's competitors,
 * links to their ads on Meta and Google, what the team saw there and when, and an Ad Library of the ads it saved
 * (search, filters, cards). Live ads open on Meta's and Google's own libraries: they cannot be read into the CRM for India.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Binoculars, ExternalLink, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api, type CompetitorAd, type CompetitorCheck, type CompetitorView } from '../../core/api';
import { formatDate, formatRelative } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, InlineNotice, LoadingState, Modal, Select, cx, inputCls, todayInputValue } from '../../components/ui';

type Platform = 'meta' | 'google';
const PLATFORM_LABEL: Record<Platform, string> = { meta: 'Meta', google: 'Google' };
const FORMAT_OPTIONS = [{ value: 'image', label: 'Image' }, { value: 'video', label: 'Video' }, { value: 'carousel', label: 'Carousel' }, { value: 'text', label: 'Text' }, { value: 'other', label: 'Other' }];
const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const linkBtn = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-[#D3E3F0] bg-white text-xs font-semibold text-[#0B5E9C] hover:bg-[#F2F7FB]';

const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the screenshot'));
  r.readAsDataURL(file);
});

interface CompetitorForm { id?: string; name: string; pageName: string; website: string; area: string; assignedToId: string }
const emptyCompetitor: CompetitorForm = { name: '', pageName: '', website: '', area: '', assignedToId: '' };

const CompetitorModal: React.FC<{ form: CompetitorForm; checkers: Array<{ id: string; name: string }>; onClose: () => void; onSaved: () => void }> = ({ form, checkers, onClose, onSaved }) => {
  const [f, setF] = useState(form);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof CompetitorForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((v) => ({ ...v, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      await api.competitors.save(f);
      onSaved();
    } catch (e) {
      toast('Not saved', errText('competitors.save', e), 'alert');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={f.id ? `Edit ${form.name}` : 'Add a competitor'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} disabled={!f.name.trim()} onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-3">
        <Field label="Name"><input className={inputCls} value={f.name} onChange={set('name')} maxLength={120} autoFocus /></Field>
        <Field label="Facebook Page name" hint="Searched in Meta's Ad Library. Empty: the name above is searched."><input className={inputCls} value={f.pageName} onChange={set('pageName')} maxLength={120} /></Field>
        <Field label="Website" hint="Google shows ads by website, for example example.com."><input className={inputCls} value={f.website} onChange={set('website')} placeholder="example.com" /></Field>
        <Field label="City or project"><input className={inputCls} value={f.area} onChange={set('area')} maxLength={120} placeholder="Gachibowli, senior living…" /></Field>
        <Field label="Who checks it"><Select value={f.assignedToId} onChange={set('assignedToId')} placeholder="Nobody yet" options={checkers.map((p) => ({ value: p.id, label: p.name }))} /></Field>
      </div>
    </Modal>
  );
};

const META_PLACEMENTS = ['Facebook', 'Instagram', 'Messenger', 'Audience Network'];
const GOOGLE_PLACEMENTS = ['Google Search', 'Display', 'YouTube', 'Maps', 'Shopping'];

const AdModal: React.FC<{ competitor: CompetitorView; onClose: () => void; onSaved: () => void }> = ({ competitor, onClose, onSaved }) => {
  const [f, setF] = useState({ platform: 'meta', link: '', offer: '', project: '', price: '', format: 'image', note: '', seenOn: todayInputValue(), startedOn: '', active: 'yes' });
  const [placements, setPlacements] = useState<string[]>([]);
  const options = f.platform === 'google' ? GOOGLE_PLACEMENTS : META_PLACEMENTS;
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((v) => ({ ...v, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      const image = file ? { name: file.name, mime: file.type, base64: await readBase64(file) } : undefined;
      await api.competitors.saveAd({ ...f, active: f.active === 'yes', placements: placements.filter((p) => options.includes(p)), competitorId: competitor.id, image });
      onSaved();
    } catch (e) {
      toast('Not saved', errText('competitors.saveAd', e), 'alert');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Save an ad of ${competitor.name}`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Seen on"><Select value={f.platform} onChange={set('platform')} options={[{ value: 'meta', label: 'Meta' }, { value: 'google', label: 'Google' }]} /></Field>
          <Field label="Date you saw it"><input type="date" className={inputCls} value={f.seenOn} onChange={set('seenOn')} /></Field>
          <Field label="Status"><Select value={f.active} onChange={set('active')} options={[{ value: 'yes', label: 'Active' }, { value: 'no', label: 'Inactive' }]} /></Field>
          <Field label="Started running on"><input type="date" className={inputCls} value={f.startedOn} onChange={set('startedOn')} /></Field>
        </div>
        <Field label="Platforms">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {options.map((p) => <label key={p} className="inline-flex items-center gap-1.5 text-xs text-[#0B2A44]"><input type="checkbox" className="h-3.5 w-3.5" checked={placements.includes(p)} onChange={(e) => setPlacements((v) => (e.target.checked ? [...v, p] : v.filter((x) => x !== p)))} /> {p}</label>)}
          </div>
        </Field>
        <Field label="Link to the ad" hint="On Meta's Ad Library, open the ad's menu and copy its link: the Library ID is read from it."><input className={inputCls} value={f.link} onChange={set('link')} placeholder="https://" /></Field>
        <Field label="Screenshot (JPG or PNG, up to 3 MB)"><input type="file" accept="image/jpeg,image/png" className={inputCls} onChange={(e) => setFile(e.target.files?.[0] || null)} /></Field>
        <Field label="Offer"><input className={inputCls} value={f.offer} onChange={set('offer')} maxLength={300} placeholder="No pre-EMI till possession…" /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Project"><input className={inputCls} value={f.project} onChange={set('project')} maxLength={120} /></Field>
          <Field label="Price"><input className={inputCls} value={f.price} onChange={set('price')} maxLength={120} /></Field>
        </div>
        <Field label="Format"><Select value={f.format} onChange={set('format')} options={FORMAT_OPTIONS} /></Field>
        <Field label="Note"><textarea className={inputCls} rows={2} value={f.note} onChange={set('note')} maxLength={1000} /></Field>
      </div>
    </Modal>
  );
};

/** A saved ad, laid out like a card in an ad library. */
const LibraryCard: React.FC<{ ad: CompetitorAd; name: string; canChange: boolean; busy: boolean; onActive: (v: boolean) => void; onDelete: () => void }> = ({ ad, name, canChange, busy, onActive, onDelete }) => {
  const [hideImage, setHideImage] = useState(false);
  const started = ad.startedOn ? formatDate(ad.startedOn) : '';
  return (
    <article className="flex flex-col rounded-lg border border-[#DADDE1] bg-white text-[#1C2B33]">
      <div className="space-y-1 border-b border-[#EBEDF0] p-3 text-xs">
        <p className={cx('inline-flex items-center gap-1.5 font-semibold', ad.active ? 'text-[#067647]' : 'text-[#65676B]')}><span className={cx('h-2 w-2 rounded-full', ad.active ? 'bg-[#31A24C]' : 'bg-[#A7B4C0]')} aria-hidden="true" />{ad.active ? 'Active' : 'Inactive'}</p>
        {ad.libraryId && <p className="text-[#65676B]">Library ID: {ad.libraryId}</p>}
        <p className="text-[#65676B]">{started ? `Started running on ${started}` : `Seen on ${formatDate(ad.seenOn)}`}</p>
        <p className="text-[#65676B]">Platforms: {ad.placements.length ? ad.placements.join(', ') : ad.platform === 'google' ? 'Google' : 'Meta'}</p>
      </div>
      <div className="flex-1 p-3">
        <div className="flex items-center gap-2">
          <span className="flex h-8 w-8 flex-none items-center justify-center rounded-full bg-[#E4E6EB] text-sm font-bold text-[#44505C]" aria-hidden="true">{(name[0] || '?').toUpperCase()}</span>
          <span className="min-w-0"><b className="block truncate text-[13px]">{name}</b><span className="block text-[11px] text-[#65676B]">Sponsored</span></span>
        </div>
        {ad.note && <p className="mt-2 line-clamp-4 whitespace-pre-wrap break-words text-xs">{ad.note}</p>}
        {ad.imageUrl && !hideImage && (
          <a href={ad.imageUrl} target="_blank" rel="noopener noreferrer" className="mt-2 block">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={ad.imageUrl} alt={ad.offer || 'Saved ad'} loading="lazy" className="max-h-72 w-full rounded bg-[#F0F2F5] object-contain" onError={() => setHideImage(true)} />
          </a>
        )}
        {(ad.offer || ad.project || ad.price) && (
          <div className="mt-2 rounded bg-[#F0F2F5] p-2 text-xs">
            {ad.offer && <b className="block break-words">{ad.offer}</b>}
            {(ad.project || ad.price) && <span className="block text-[11px] text-[#65676B]">{[ad.project, ad.price].filter(Boolean).join(' · ')}</span>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-[#EBEDF0] p-2.5 text-[11px]">
        {ad.link ? <a href={ad.link} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-md border border-[#CED0D4] px-2.5 py-1 font-semibold text-[#1C2B33] hover:bg-[#F5F6F7]">See ad details <ExternalLink size={11} /></a> : <span className="text-[#65676B]">No link saved</span>}
        <span className="ml-auto flex gap-2">
          {canChange && <button type="button" disabled={busy} className="font-semibold text-[#0B5E9C] hover:underline disabled:opacity-50" onClick={() => onActive(!ad.active)}>Mark {ad.active ? 'inactive' : 'active'}</button>}
          {canChange && <button type="button" className="text-[#9A3412] hover:underline" onClick={onDelete}>Remove</button>}
        </span>
      </div>
      <p className="border-t border-[#EBEDF0] px-3 py-1.5 text-[10.5px] text-[#65676B]">Saved by {ad.createdBy}</p>
    </article>
  );
};

/** One platform: the link to its ads, what was recorded last, and the buttons to record now. */
const PlatformRow: React.FC<{ platform: Platform; href: string; check: CompetitorCheck | null; canChange: boolean; busy: boolean; hint?: string; onRecord: (status: 'running' | 'not_running') => void }> = ({ platform, href, check, canChange, busy, hint, onRecord }) => (
  <div className="flex flex-wrap items-center gap-2 py-2">
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkBtn} title={hint}>See {PLATFORM_LABEL[platform]} ads <ExternalLink size={12} /></a>
    {check ? <Badge tone={check.status === 'running' ? 'sage' : 'muted'}>{check.status === 'running' ? 'Running' : 'Not running'}</Badge> : <Badge tone="amber">Not checked</Badge>}
    {check && <span className="text-[11px] text-[#5E778C]" title={formatDate(check.at)}>{formatRelative(check.at)} · {check.by}</span>}
    {canChange && (
      <span className="ml-auto flex gap-1.5">
        <Button variant="secondary" size="xs" disabled={busy} onClick={() => onRecord('running')}>Running</Button>
        <Button variant="secondary" size="xs" disabled={busy} onClick={() => onRecord('not_running')}>Not running</Button>
      </span>
    )}
  </div>
);

export const CompetitorsView: React.FC<{ canChange: boolean }> = ({ canChange }) => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.competitors.list>> | null>(null);
  const [failed, setFailed] = useState('');
  const [editing, setEditing] = useState<CompetitorForm | null>(null);
  const [addingAdTo, setAddingAdTo] = useState<CompetitorView | null>(null);
  const [removing, setRemoving] = useState<{ kind: 'competitor' | 'ad'; id: string; label: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState<'library' | 'competitors'>('library');
  const [q, setQ] = useState('');
  const [only, setOnly] = useState('');
  const [platform, setPlatform] = useState('');
  const [status, setStatus] = useState('');
  const [format, setFormat] = useState('');
  const [liveSearch, setLiveSearch] = useState('');

  const load = useCallback(async () => {
    try {
      setData(await api.competitors.list());
      setFailed('');
    } catch (e) {
      setFailed(errText('competitors.list', e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const record = async (c: CompetitorView, platform: Platform, status: 'running' | 'not_running') => {
    setBusy(c.id);
    try {
      await api.competitors.recordCheck(c.id, platform, status);
      await load();
    } catch (e) {
      toast('Not recorded', errText('competitors.check', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy('remove');
    try {
      await (removing.kind === 'competitor' ? api.competitors.remove(removing.id) : api.competitors.removeAd(removing.id));
      setRemoving(null);
      await load();
    } catch (e) {
      toast('Not removed', errText('competitors.remove', e), 'alert');
    } finally {
      setBusy('');
    }
  };

  const setActive = async (id: string, active: boolean) => {
    setBusy(id);
    try {
      await api.competitors.setAdActive(id, active);
      await load();
    } catch (e) {
      toast('Not changed', errText('competitors.adActive', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const library = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (data?.competitors || [])
      .filter((c) => !only || c.id === only)
      .flatMap((c) => c.ads.map((ad) => ({ ad, name: c.name })))
      .filter(({ ad, name }) => (!platform || ad.platform === platform) && (!status || String(ad.active) === status) && (!format || ad.format === format)
        && (!term || [name, ad.offer, ad.project, ad.price, ad.note, ad.libraryId].join(' ').toLowerCase().includes(term)))
      .sort((a, b) => Number(b.ad.active) - Number(a.ad.active) || b.ad.seenOn.localeCompare(a.ad.seenOn));
  }, [data, q, only, platform, status, format]);

  if (!data) return failed ? <InlineNotice tone="warning">{failed}</InlineNotice> : <LoadingState label="Loading competitors…" />;
  const due = data.competitors.filter((c) => c.due).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="min-w-0 flex-1 text-xs text-[#5E778C]">
          {data.competitors.length ? `${data.competitors.length} competitor${data.competitors.length === 1 ? '' : 's'}${due ? ` · ${due} to check (not checked in ${data.checkEveryDays} days)` : ' · all checked'}` : 'Keep an eye on the ads your competitors run.'}
        </p>
        {canChange && <Button icon={<Plus size={14} />} onClick={() => setEditing(emptyCompetitor)}>Add competitor</Button>}
      </div>
      <InlineNotice tone="info">Live ads can only be seen on Meta's and Google's own libraries, so the buttons open them. Cards here are ads your team saved, and their status is what your team recorded, not live data. Meta and Google do not publish competitors' spend or leads.</InlineNotice>

      <div role="tablist" aria-label="View" className="flex border-b border-[#DADDE1]">
        {([['library', 'Ad library'], ['competitors', 'Competitors']] as Array<['library' | 'competitors', string]>).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx('-mb-px border-b-2 px-4 py-2 text-[13px] font-semibold', tab === id ? 'border-[#0866FF] text-[#0866FF]' : 'border-transparent text-[#44505C] hover:bg-[#F5F6F7]')}>{label}</button>)}
      </div>

      {tab === 'library' && (
        <div className="space-y-3">
          <section className="rounded-lg border border-[#DADDE1] bg-white p-3">
            <h2 className="text-[13px] font-bold text-[#1C2B33]">Search live ads</h2>
            <form className="mt-2 flex flex-wrap items-center gap-2" onSubmit={(e) => e.preventDefault()}>
              <input className={cx(inputCls, 'min-w-[200px] flex-1')} value={liveSearch} onChange={(e) => setLiveSearch(e.target.value)} placeholder="Advertiser or keyword, or a website for Google" aria-label="Search live ads" />
              <a href={`https://www.facebook.com/ads/library/?${new URLSearchParams({ active_status: 'active', ad_type: 'all', country: 'IN', media_type: 'all', search_type: 'keyword_unordered', q: liveSearch.trim() })}`} target="_blank" rel="noopener noreferrer" className={linkBtn}>Meta Ad Library <ExternalLink size={12} /></a>
              <a href={`https://adstransparency.google.com/?${new URLSearchParams({ region: 'IN', ...(/^[\w-]+(\.[\w-]+)+$/.test(liveSearch.trim()) ? { domain: liveSearch.trim() } : {}) })}`} target="_blank" rel="noopener noreferrer" className={linkBtn} title="Google shows ads by website. For a name, type it in Google's search box.">Google Ads Transparency <ExternalLink size={12} /></a>
            </form>
          </section>

          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[180px] flex-1">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#65676B]" />
              <input className={cx(inputCls, 'pl-8')} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search saved ads" aria-label="Search saved ads" />
            </label>
            <select className={cx(inputCls, 'w-auto')} value={only} onChange={(e) => setOnly(e.target.value)} aria-label="Competitor"><option value="">All competitors</option>{data.competitors.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            <select className={cx(inputCls, 'w-auto')} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status"><option value="">Active and inactive</option><option value="true">Active</option><option value="false">Inactive</option></select>
            <select className={cx(inputCls, 'w-auto')} value={platform} onChange={(e) => setPlatform(e.target.value)} aria-label="Platform"><option value="">All platforms</option><option value="meta">Meta</option><option value="google">Google</option></select>
            <select className={cx(inputCls, 'w-auto')} value={format} onChange={(e) => setFormat(e.target.value)} aria-label="Format"><option value="">All formats</option>{FORMAT_OPTIONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
          </div>
          <p className="text-xs font-semibold text-[#1C2B33]">{library.length} saved ad{library.length === 1 ? '' : 's'}</p>
          {library.length === 0 ? (
            <EmptyState icon={<Binoculars size={22} />} title="No saved ads to show" description={canChange ? 'Add a competitor on the Competitors tab, then use Save ad there.' : 'An Admin or Manager can save ads here.'} />
          ) : (
            <div className="grid items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {library.map(({ ad, name }) => <LibraryCard key={ad.id} ad={ad} name={name} canChange={canChange} busy={busy === ad.id} onActive={(v) => void setActive(ad.id, v)} onDelete={() => setRemoving({ kind: 'ad', id: ad.id, label: ad.offer || 'this saved ad' })} />)}
            </div>
          )}
        </div>
      )}

      {tab === 'competitors' && (<>

      {data.competitors.length === 0 ? (
        <EmptyState icon={<Binoculars size={22} />} title="No competitors yet" description={canChange ? 'Add a competitor to open their ads in one click and record what they are running.' : 'An Admin or Manager can add competitors.'} />
      ) : data.competitors.map((c) => (
        <Card key={c.id}
          title={<span className="inline-flex flex-wrap items-center gap-2">{c.name}{c.due && <Badge tone="amber">To check</Badge>}</span>}
          subtitle={[c.area, c.website, c.assignedToName && `Checked by ${c.assignedToName}`].filter(Boolean).join(' · ') || undefined}
          actions={canChange ? (
            <span className="flex gap-1.5">
              <Button variant="secondary" size="xs" icon={<Plus size={12} />} onClick={() => setAddingAdTo(c)}>Save ad</Button>
              <Button variant="secondary" size="xs" icon={<Pencil size={12} />} aria-label={`Edit ${c.name}`} onClick={() => setEditing({ id: c.id, name: c.name, pageName: c.pageName, website: c.website, area: c.area, assignedToId: c.assignedToId })}>Edit</Button>
              <Button variant="secondary" size="xs" icon={<Trash2 size={12} />} aria-label={`Remove ${c.name}`} onClick={() => setRemoving({ kind: 'competitor', id: c.id, label: c.name })} />
            </span>
          ) : undefined}>
          <div className="divide-y divide-[#EEF4F9]">
            <PlatformRow platform="meta" href={c.metaUrl} check={c.meta} canChange={canChange} busy={busy === c.id} onRecord={(s) => void record(c, 'meta', s)} />
            <PlatformRow platform="google" href={c.googleUrl} check={c.google} canChange={canChange} busy={busy === c.id} hint={c.website ? undefined : 'No website saved: type the name in Google\'s search box.'} onRecord={(s) => void record(c, 'google', s)} />
          </div>
          {c.ads.length > 0 && <p className="mt-2 text-xs text-[#5E778C]">{c.ads.length} saved ad{c.ads.length === 1 ? '' : 's'}: see them on the Ad library tab.</p>}
        </Card>
      ))}
      </>)}

      {editing && <CompetitorModal form={editing} checkers={data.checkers} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {addingAdTo && <AdModal competitor={addingAdTo} onClose={() => setAddingAdTo(null)} onSaved={() => { setAddingAdTo(null); void load(); }} />}
      <ConfirmDialog open={!!removing} danger title={removing?.kind === 'competitor' ? 'Remove this competitor?' : 'Remove this saved ad?'}
        message={removing?.kind === 'competitor' ? `${removing.label} and everything saved for it (ads, screenshots, checks) will be deleted.` : `“${removing?.label}” will be deleted.`}
        confirmLabel="Remove" loading={busy === 'remove'} onConfirm={() => void remove()} onCancel={() => setRemoving(null)} />
    </div>
  );
};
