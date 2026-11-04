/**
 * Competitor ads (/competitors, plan feature competitorAds; server: modules/competitors.ts): the company's competitors,
 * links to their ads on Meta and Google, what the team saw there and when, and the ads it saved.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Binoculars, ExternalLink, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, type CompetitorAd, type CompetitorCheck, type CompetitorView } from '../../core/api';
import { formatDate, formatRelative } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, InlineNotice, LoadingState, Modal, Select, inputCls, todayInputValue } from '../../components/ui';

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

const AdModal: React.FC<{ competitor: CompetitorView; onClose: () => void; onSaved: () => void }> = ({ competitor, onClose, onSaved }) => {
  const [f, setF] = useState({ platform: 'meta', link: '', offer: '', project: '', price: '', format: 'image', note: '', seenOn: todayInputValue() });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((v) => ({ ...v, [k]: e.target.value }));
  const save = async () => {
    setBusy(true);
    try {
      const image = file ? { name: file.name, mime: file.type, base64: await readBase64(file) } : undefined;
      await api.competitors.saveAd({ ...f, competitorId: competitor.id, image });
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
          <Field label="Date"><input type="date" className={inputCls} value={f.seenOn} onChange={set('seenOn')} /></Field>
        </div>
        <Field label="Link to the ad"><input className={inputCls} value={f.link} onChange={set('link')} placeholder="https://" /></Field>
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

const AdCard: React.FC<{ ad: CompetitorAd; canChange: boolean; onDelete: () => void }> = ({ ad, canChange, onDelete }) => {
  const [hideImage, setHideImage] = useState(false);
  return (
    <div className="rounded-lg border border-[#E6EFF6] p-2.5 text-xs text-[#0B2A44] space-y-1.5">
      {ad.imageUrl && !hideImage && (
        <a href={ad.imageUrl} target="_blank" rel="noopener noreferrer">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={ad.imageUrl} alt={ad.offer || 'Saved ad'} className="w-full max-h-40 object-contain rounded bg-[#F7FAFD]" onError={() => setHideImage(true)} />
        </a>
      )}
      {ad.offer && <p className="font-semibold">{ad.offer}</p>}
      <p className="text-[11px] text-[#5E778C]">{[PLATFORM_LABEL[ad.platform], ad.format, ad.project, ad.price].filter(Boolean).join(' · ')}</p>
      {ad.note && <p className="text-[11px] text-[#425A6E] whitespace-pre-wrap">{ad.note}</p>}
      <div className="flex items-center gap-2 text-[11px] text-[#7E93A6]">
        <span className="min-w-0 flex-1 truncate">{formatDate(ad.seenOn)} · {ad.createdBy}</span>
        {ad.link && <a href={ad.link} target="_blank" rel="noopener noreferrer" className="font-semibold text-[#0B5E9C] hover:underline">Open</a>}
        {canChange && <button type="button" onClick={onDelete} className="text-[#9A3412] hover:underline">Remove</button>}
      </div>
    </div>
  );
};

export const CompetitorsView: React.FC<{ canChange: boolean }> = ({ canChange }) => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.competitors.list>> | null>(null);
  const [failed, setFailed] = useState('');
  const [editing, setEditing] = useState<CompetitorForm | null>(null);
  const [addingAdTo, setAddingAdTo] = useState<CompetitorView | null>(null);
  const [removing, setRemoving] = useState<{ kind: 'competitor' | 'ad'; id: string; label: string } | null>(null);
  const [busy, setBusy] = useState('');

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
      <InlineNotice tone="info">The buttons open Meta's and Google's public ad libraries. Running or not is what your team recorded on the date shown, not live data. Meta and Google do not publish competitors' spend or leads.</InlineNotice>

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
          {c.ads.length > 0 && (
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {c.ads.map((a) => <AdCard key={a.id} ad={a} canChange={canChange} onDelete={() => setRemoving({ kind: 'ad', id: a.id, label: a.offer || 'this saved ad' })} />)}
            </div>
          )}
        </Card>
      ))}

      {editing && <CompetitorModal form={editing} checkers={data.checkers} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {addingAdTo && <AdModal competitor={addingAdTo} onClose={() => setAddingAdTo(null)} onSaved={() => { setAddingAdTo(null); void load(); }} />}
      <ConfirmDialog open={!!removing} danger title={removing?.kind === 'competitor' ? 'Remove this competitor?' : 'Remove this saved ad?'}
        message={removing?.kind === 'competitor' ? `${removing.label} and everything saved for it (ads, screenshots, checks) will be deleted.` : `“${removing?.label}” will be deleted.`}
        confirmLabel="Remove" loading={busy === 'remove'} onConfirm={() => void remove()} onCancel={() => setRemoving(null)} />
    </div>
  );
};
