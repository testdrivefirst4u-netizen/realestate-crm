/**
 * Competitor ads (/competitors, plan feature competitorAds; server: modules/competitors.ts): an Ad Library of the ads the team
 * saved (search, filters, cards, full view), a search that opens live ads on Meta's and Google's own libraries, and the
 * competitors with what was seen there and when. Live ads cannot be read into the CRM for India (see the server module).
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Binoculars, ExternalLink, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api, type CompetitorCheck, type CompetitorView } from '../../core/api';
import { formatDate, formatRelative } from '../../core/dates';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, ConfirmDialog, EmptyState, Field, InlineNotice, LoadingState, Modal, Select, cx, inputCls, todayInputValue } from '../../components/ui';
import { AdCard, AdDetail } from './AdCard';
import { SaveAdModal } from './SaveAdModal';
import { NO_FILTERS, filtersOn, libraryItems, type LibraryFilters, type LibraryItem } from './adLibrary';

type Platform = 'meta' | 'google';
const PLATFORM_LABEL: Record<Platform, string> = { meta: 'Meta', google: 'Google' };
const FORMAT_OPTIONS = [{ value: 'image', label: 'Image' }, { value: 'video', label: 'Video' }, { value: 'carousel', label: 'Carousel' }, { value: 'text', label: 'Text' }, { value: 'other', label: 'Other' }];
const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const linkBtn = 'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-[#D3E3F0] bg-white text-xs font-semibold text-[#0B5E9C] hover:bg-[#F2F7FB]';
const pill = (on: boolean) => cx('whitespace-nowrap rounded-full border px-3 py-1.5 text-xs font-semibold', on ? 'border-[#0B6BB0] bg-[#0B6BB0] text-white' : 'border-[#D3E3F0] bg-white text-[#3E5A70] hover:bg-[#F2F7FB]');

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

/** One platform: the link to its ads, what was recorded last, and the buttons to record now. */
const PlatformRow: React.FC<{ platform: Platform; href: string; check: CompetitorCheck | null; canChange: boolean; busy: boolean; hint?: string; onRecord: (status: 'running' | 'not_running') => void }> = ({ platform, href, check, canChange, busy, hint, onRecord }) => (
  <div className="flex flex-wrap items-center gap-2 py-2.5">
    <a href={href} target="_blank" rel="noopener noreferrer" className={linkBtn} title={hint}>See {PLATFORM_LABEL[platform]} ads <ExternalLink size={12} aria-hidden="true" /></a>
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

const Stat: React.FC<{ label: string; value: number; warn?: boolean }> = ({ label, value, warn }) => (
  <div className="rounded-xl border border-[#D3E3F0] bg-white px-4 py-3">
    <p className={cx('text-xl font-bold tabular-nums', warn && value > 0 ? 'text-[#B54708]' : 'text-[#0B2A44]')}>{value}</p>
    <p className="text-[11px] text-[#5E778C]">{label}</p>
  </div>
);

export const CompetitorsView: React.FC<{ canChange: boolean }> = ({ canChange }) => {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.competitors.list>> | null>(null);
  const [failed, setFailed] = useState('');
  const [editing, setEditing] = useState<CompetitorForm | null>(null);
  const [saving, setSaving] = useState<{ competitorId: string } | null>(null);
  const [openAd, setOpenAd] = useState('');
  const [removing, setRemoving] = useState<{ kind: 'competitor' | 'ad'; id: string; label: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [tab, setTab] = useState<'library' | 'competitors'>('library');
  const [filters, setFilters] = useState<LibraryFilters>(NO_FILTERS);
  const [liveSearch, setLiveSearch] = useState('');
  const today = todayInputValue();
  const setFilter = <K extends keyof LibraryFilters>(k: K, v: LibraryFilters[K]) => setFilters((x) => ({ ...x, [k]: v }));

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
      if (removing.kind === 'ad') setOpenAd('');
      if (removing.kind === 'competitor' && filters.competitorId === removing.id) setFilter('competitorId', '');
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

  const everyAd = useMemo<LibraryItem[]>(() => (data?.competitors || []).flatMap((c) => c.ads.map((ad) => ({ ad, competitorId: c.id, name: c.name }))), [data]);
  const shown = useMemo(() => libraryItems(everyAd, filters, today), [everyAd, filters, today]);

  if (!data) return failed ? <InlineNotice tone="warning">{failed}</InlineNotice> : <LoadingState label="Loading the ad library…" />;
  const due = data.competitors.filter((c) => c.due).length;
  const opened = everyAd.find((x) => x.ad.id === openAd);
  const hasCompetitors = data.competitors.length > 0;
  const startSaving = (competitorId = filters.competitorId) => setSaving({ competitorId });
  const term = liveSearch.trim();
  const metaLive = `https://www.facebook.com/ads/library/?${new URLSearchParams({ active_status: 'active', ad_type: 'all', country: 'IN', media_type: 'all', search_type: 'keyword_unordered', q: term })}`;
  const googleLive = `https://adstransparency.google.com/?${new URLSearchParams({ region: 'IN', ...(/^[\w-]+(\.[\w-]+)+$/.test(term) ? { domain: term } : {}) })}`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-bold tracking-tight text-[#0B2A44] sm:text-2xl">Competitor Ad Library</h2>
          <p className="mt-0.5 text-xs text-[#5E778C]">The ads your competitors run, saved by your team in one place.</p>
        </div>
        {canChange && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={<Plus size={14} />} onClick={() => setEditing(emptyCompetitor)}>Add competitor</Button>
            {hasCompetitors && <Button variant="primary" icon={<Plus size={14} />} onClick={() => startSaving()}>Save an ad</Button>}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Saved ads" value={everyAd.length} />
        <Stat label="Active, as last recorded" value={everyAd.filter((x) => x.ad.active).length} />
        <Stat label="Competitors" value={data.competitors.length} />
        <Stat label={`Not checked in ${data.checkEveryDays} days`} value={due} warn />
      </div>

      <section className="rounded-xl border border-[#D3E3F0] bg-white p-3 sm:p-4">
        <h3 className="text-[13px] font-bold text-[#0B2A44]">Find live ads</h3>
        <p className="mt-0.5 text-[11px] text-[#5E778C]">Opens Meta's or Google's own library for India. Screenshot what matters and save it here. Neither shows a competitor's spend or leads.</p>
        <form className="mt-2.5 flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); window.open(metaLive, '_blank', 'noopener,noreferrer'); }}>
          <input className={cx(inputCls, 'min-w-0 flex-1')} value={liveSearch} onChange={(e) => setLiveSearch(e.target.value)} placeholder="Advertiser or keyword, or a website for Google" aria-label="Search live ads" />
          <span className="grid grid-cols-2 gap-2 sm:flex">
            <a href={metaLive} target="_blank" rel="noopener noreferrer" className={linkBtn}>Meta <ExternalLink size={12} aria-hidden="true" /></a>
            <a href={googleLive} target="_blank" rel="noopener noreferrer" className={linkBtn} title="Google shows ads by website. For a name, type it in Google's search box.">Google <ExternalLink size={12} aria-hidden="true" /></a>
          </span>
        </form>
      </section>

      <div role="tablist" aria-label="View" className="flex border-b border-[#D3E3F0]">
        {([['library', `Saved ads (${everyAd.length})`], ['competitors', `Competitors (${data.competitors.length})`]] as Array<['library' | 'competitors', string]>).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cx('-mb-px border-b-2 px-4 py-2 text-[13px] font-semibold', tab === id ? 'border-[#0B6BB0] text-[#0B6BB0]' : 'border-transparent text-[#3E5A70] hover:bg-[#F2F7FB]')}>{label}</button>)}
      </div>

      {tab === 'library' && (
        <div className="space-y-3">
          {hasCompetitors && (
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1 [scrollbar-width:none]" role="group" aria-label="Competitor">
              <button type="button" aria-pressed={!filters.competitorId} className={pill(!filters.competitorId)} onClick={() => setFilter('competitorId', '')}>All</button>
              {data.competitors.map((c) => <button key={c.id} type="button" aria-pressed={filters.competitorId === c.id} className={pill(filters.competitorId === c.id)} onClick={() => setFilter('competitorId', c.id)}>{c.name} · {c.ads.length}</button>)}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-full flex-1 sm:min-w-[200px]">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#5E778C]" aria-hidden="true" />
              <input className={cx(inputCls, 'pl-8')} value={filters.q} onChange={(e) => setFilter('q', e.target.value)} placeholder="Search offer, project, price, note" aria-label="Search saved ads" />
            </label>
            <select className={cx(inputCls, '!w-[calc(50%-4px)] sm:!w-auto')} value={filters.status} onChange={(e) => setFilter('status', e.target.value as LibraryFilters['status'])} aria-label="Status"><option value="">Active and inactive</option><option value="active">Active</option><option value="inactive">Inactive</option></select>
            <select className={cx(inputCls, '!w-[calc(50%-4px)] sm:!w-auto')} value={filters.platform} onChange={(e) => setFilter('platform', e.target.value)} aria-label="Platform"><option value="">Meta and Google</option><option value="meta">Meta</option><option value="google">Google</option></select>
            <select className={cx(inputCls, '!w-[calc(50%-4px)] sm:!w-auto')} value={filters.format} onChange={(e) => setFilter('format', e.target.value)} aria-label="Format"><option value="">All formats</option>{FORMAT_OPTIONS.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}</select>
            <select className={cx(inputCls, '!w-[calc(50%-4px)] sm:!w-auto')} value={filters.sort} onChange={(e) => setFilter('sort', e.target.value as LibraryFilters['sort'])} aria-label="Sort"><option value="recent">Active first, newest</option><option value="longest">Running longest</option></select>
          </div>

          {!hasCompetitors ? (
            <EmptyState icon={<Binoculars size={22} />} title="Start your ad library" description={canChange ? 'Add a competitor, open their ads on Meta or Google, then save the ones worth remembering with a screenshot.' : 'An Admin or Manager can add competitors and save ads here.'} action={canChange ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing(emptyCompetitor)}>Add competitor</Button> : undefined} />
          ) : shown.length === 0 ? (
            filtersOn(filters)
              ? <EmptyState icon={<Search size={22} />} title="No ads match these filters" description="Try fewer filters or another word." action={<Button variant="secondary" onClick={() => setFilters(NO_FILTERS)}>Clear filters</Button>} />
              : <EmptyState icon={<Binoculars size={22} />} title="No ads saved yet" description={canChange ? 'Open a competitor\'s ads above, take a screenshot, and save it here.' : 'An Admin or Manager can save ads here.'} action={canChange ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => startSaving()}>Save an ad</Button> : undefined} />
          ) : (
            <>
              <p className="text-xs font-semibold text-[#3E5A70]">{shown.length} {shown.length === 1 ? 'ad' : 'ads'}</p>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {shown.map(({ ad, name }) => <AdCard key={ad.id} ad={ad} name={name} today={today} onOpen={() => setOpenAd(ad.id)} />)}
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'competitors' && (
        !hasCompetitors ? (
          <EmptyState icon={<Binoculars size={22} />} title="No competitors yet" description={canChange ? 'Add a competitor to open their ads in one click and record what they are running.' : 'An Admin or Manager can add competitors.'} action={canChange ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing(emptyCompetitor)}>Add competitor</Button> : undefined} />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {data.competitors.map((c) => (
              <section key={c.id} className="rounded-xl border border-[#D3E3F0] bg-white p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-[#E3EEF7] text-sm font-bold text-[#0B5E9C]" aria-hidden="true">{(c.name[0] || '?').toUpperCase()}</span>
                  <div className="min-w-0 flex-1">
                    <h3 className="flex flex-wrap items-center gap-2 text-sm font-bold text-[#0B2A44]"><span className="break-words">{c.name}</span>{c.due && <Badge tone="amber">To check</Badge>}</h3>
                    <p className="break-words text-[11px] text-[#5E778C]">{[c.area, c.website, c.assignedToName && `Checked by ${c.assignedToName}`].filter(Boolean).join(' · ') || 'No details yet'}</p>
                  </div>
                  {canChange && (
                    <span className="flex flex-none gap-1.5">
                      <Button variant="secondary" size="xs" icon={<Pencil size={12} />} aria-label={`Edit ${c.name}`} onClick={() => setEditing({ id: c.id, name: c.name, pageName: c.pageName, website: c.website, area: c.area, assignedToId: c.assignedToId })} />
                      <Button variant="secondary" size="xs" icon={<Trash2 size={12} />} aria-label={`Remove ${c.name}`} onClick={() => setRemoving({ kind: 'competitor', id: c.id, label: c.name })} />
                    </span>
                  )}
                </div>
                <div className="mt-2 divide-y divide-[#EEF4F9]">
                  <PlatformRow platform="meta" href={c.metaUrl} check={c.meta} canChange={canChange} busy={busy === c.id} onRecord={(s) => void record(c, 'meta', s)} />
                  <PlatformRow platform="google" href={c.googleUrl} check={c.google} canChange={canChange} busy={busy === c.id} hint={c.website ? undefined : 'No website saved: type the name in Google\'s search box.'} onRecord={(s) => void record(c, 'google', s)} />
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 border-t border-[#EEF4F9] pt-2.5">
                  {c.ads.length > 0
                    ? <button type="button" className="text-xs font-semibold text-[#0B5E9C] hover:underline" onClick={() => { setFilters({ ...NO_FILTERS, competitorId: c.id }); setTab('library'); }}>See {c.ads.length} saved ad{c.ads.length === 1 ? '' : 's'}</button>
                    : <span className="text-xs text-[#5E778C]">No ads saved yet</span>}
                  {canChange && <Button variant="secondary" size="xs" icon={<Plus size={12} />} onClick={() => startSaving(c.id)}>Save an ad</Button>}
                </div>
              </section>
            ))}
          </div>
        )
      )}

      {editing && <CompetitorModal form={editing} checkers={data.checkers} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {saving && <SaveAdModal competitors={data.competitors} competitorId={saving.competitorId} onClose={() => setSaving(null)} onSaved={() => { setSaving(null); setTab('library'); void load(); }} />}
      {opened && <AdDetail ad={opened.ad} name={opened.name} today={today} canChange={canChange} busy={busy === opened.ad.id} onClose={() => setOpenAd('')} onActive={(v) => void setActive(opened.ad.id, v)} onRemove={() => setRemoving({ kind: 'ad', id: opened.ad.id, label: opened.ad.offer || 'this saved ad' })} />}
      <ConfirmDialog open={!!removing} danger title={removing?.kind === 'competitor' ? 'Remove this competitor?' : 'Remove this saved ad?'}
        message={removing?.kind === 'competitor' ? `${removing.label} and everything saved for it (ads, screenshots, checks) will be deleted.` : `“${removing?.label}” will be deleted.`}
        confirmLabel="Remove" loading={busy === 'remove'} onConfirm={() => void remove()} onCancel={() => setRemoving(null)} />
    </div>
  );
};
