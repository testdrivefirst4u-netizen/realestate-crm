/**
 * Business Profile (/businessprofile; server: modules/businessProfile.ts): the profile as customers see it, a preview card,
 * the state of each detail with Edit (gbpEdit.tsx), photos (gbpPhotos.tsx), and the figures. The preview is our drawing, so the screen says so and
 * links to the real listing.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ExternalLink, Pencil, RefreshCw } from 'lucide-react';
import { api, type AnalyticsMetric, type BusinessPerformance, type BusinessPhoto, type BusinessProfileData } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { Button, InlineNotice, cx, inputCls } from '../../components/ui';
import { LineChart } from '../analytics/analyticsCharts';
import { EditDialog, SECTION_OF, type EditSection } from './gbpEdit';
import { coverOf, PhotosTab } from './gbpPhotos';
import { Preview } from './gbpPreview';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const n = (v: number) => Math.round(v).toLocaleString('en-IN');
const PRESETS = [{ id: 'last7', label: 'Last 7 days' }, { id: 'last28', label: 'Last 28 days' }, { id: 'last90', label: 'Last 3 months' }, { id: 'last180', label: 'Last 6 months' }, { id: 'last365', label: 'Last 12 months' }];
const CARDS: AnalyticsMetric[] = [
  { id: 'views', label: 'Profile views', format: 'number' }, { id: 'calls', label: 'Calls', format: 'number' }, { id: 'website', label: 'Website clicks', format: 'number' },
  { id: 'directions', label: 'Directions', format: 'number' }, { id: 'messages', label: 'Messaging clicks', format: 'number' }, { id: 'bookings', label: 'Bookings', format: 'number' },
];
const SPLIT = [{ id: 'searchMobile', label: 'Google Search, mobile' }, { id: 'searchDesktop', label: 'Google Search, desktop' }, { id: 'mapsMobile', label: 'Google Maps, mobile' }, { id: 'mapsDesktop', label: 'Google Maps, desktop' }];
const STATE = {
  live: { label: 'Live', cls: 'bg-[#E6F4EA] text-[#137333]' },
  pending: { label: 'Waiting for Google', cls: 'bg-[#FEF7E0] text-[#8A5A00]' },
  changed: { label: 'Changed by Google', cls: 'bg-[#E8F0FE] text-[#1967D2]' },
};

const ProfileTab: React.FC<{ data: BusinessProfileData; canEdit: boolean; photo: string; onEdit: (s: EditSection) => void }> = ({ data, canEdit, photo, onEdit }) => {
  const changed = data.fields.filter((f) => f.state === 'changed');
  const shown = data.live || data.profile;
  if (!shown) return null;
  return (
    <div className="space-y-3">
      {!data.managed && <InlineNotice tone="warning">Google says this account does not manage the public listing yet, usually because the profile isn't verified. Verify it in Google Business Profile first.</InlineNotice>}
      {data.duplicate && <InlineNotice tone="warning">Google has marked this location as a duplicate of another listing.</InlineNotice>}
      {data.liveError && <InlineNotice tone="warning">The public version could not be read, so your own details are shown. Google said: {data.liveError}</InlineNotice>}
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Preview p={shown} rating={data.rating} mapsUri={data.mapsUri} photo={photo} />
        <div className="min-w-0 space-y-3">
          {changed.length > 0 && (
            <section className="rounded-lg border border-[#DADCE0] bg-white">
              <h2 className="px-4 pb-1 pt-3 text-[15px] font-medium text-[#202124]">Google changed {changed.length === 1 ? 'one detail' : `${changed.length} details`}</h2>
              <p className="px-4 pb-2 text-xs text-[#5F6368]">Customers see Google's version until it's replaced in Google Business Profile.</p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[480px] border-collapse">
                  <thead><tr className="border-y border-[#E8EAED] text-left text-[11.5px] text-[#5F6368]"><th scope="col" className="px-4 py-2 font-medium">Detail</th><th scope="col" className="px-3 py-2 font-medium">Your version</th><th scope="col" className="px-3 py-2 font-medium">What customers see</th></tr></thead>
                  <tbody className="divide-y divide-[#F1F3F4]">{changed.map((f) => <tr key={f.id} className="align-top text-[13px] text-[#202124]"><td className="px-4 py-2.5 font-medium">{f.label}</td><td className="whitespace-pre-line break-words px-3 py-2.5">{f.value || '—'}</td><td className="whitespace-pre-line break-words px-3 py-2.5">{f.live || '—'}</td></tr>)}</tbody>
                </table>
              </div>
            </section>
          )}
          <section className="rounded-lg border border-[#DADCE0] bg-white">
            <h2 className="px-4 pb-2 pt-3 text-[15px] font-medium text-[#202124]">Your details</h2>
            <dl className="divide-y divide-[#F1F3F4] border-t border-[#E8EAED]">
              {data.fields.map((f) => (
                <div key={f.id} className="grid gap-1 px-4 py-2.5 sm:grid-cols-[130px_minmax(0,1fr)_auto_auto] sm:items-start sm:gap-3">
                  <dt className="text-xs text-[#5F6368]">{f.label}</dt>
                  <dd className="min-w-0 whitespace-pre-line break-words text-[13px] text-[#202124]">{f.value || <span className="text-[#5F6368]">Not added</span>}</dd>
                  <dd><span className={cx('inline-block rounded-full px-2 py-0.5 text-[11px] font-medium', STATE[f.state].cls)}>{STATE[f.state].label}</span></dd>
                  {canEdit && <dd className="sm:w-14">{SECTION_OF[f.id] && <button type="button" aria-label={`Edit ${f.label}`} onClick={() => onEdit(SECTION_OF[f.id]!)} className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-[#1967D2] hover:bg-[#E8F0FE]"><Pencil size={12} />Edit</button>}</dd>}
                </div>
              ))}
            </dl>
            <p className="border-t border-[#E8EAED] px-4 py-2.5 text-[11px] text-[#5F6368]">{canEdit ? 'Service area is changed in Google Business Profile. ' : 'Only an Admin can change these details. '}Google reviews edits first, usually within minutes but sometimes up to 30 days.</p>
          </section>
        </div>
      </div>
    </div>
  );
};

const Change: React.FC<{ now: number; before?: number }> = ({ now, before }) => {
  if (!before) return null;
  const c = ((now - before) / before) * 100;
  if (Math.abs(c) < 0.05) return <span className="text-[11px] text-[#5F6368]">no change</span>;
  return <span className={cx('inline-flex items-center gap-0.5 text-[11px] font-medium', c > 0 ? 'text-[#137333]' : 'text-[#A50E0E]')}>{c > 0 ? <ArrowUp size={11} /> : <ArrowDown size={11} />}{Math.abs(c).toFixed(1)}%</span>;
};

const PerformanceTab: React.FC<{ location: string }> = ({ location }) => {
  const [preset, setPreset] = useState('last28');
  const [compare, setCompare] = useState(true);
  const [metric, setMetric] = useState('views');
  const [data, setData] = useState<BusinessPerformance | null>(null);
  const [failed, setFailed] = useState('');
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const load = useCallback(async (refresh = false) => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const r = await api.businessProfile.performance({ preset, location, refresh });
      if (mine !== latest.current) return;
      setData(r);
      setFailed('');
    } catch (e) {
      if (mine === latest.current) setFailed(errText('gbp.performance', e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [preset, location]);
  useEffect(() => void load(), [load]);
  const chosen = CARDS.find((c) => c.id === metric) || CARDS[0];
  const splitTop = useMemo(() => Math.max(1, ...SPLIT.map((s) => data?.totals[s.id] || 0)), [data]);
  const day = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  const monthText = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select className={cx(inputCls, 'w-auto')} value={preset} onChange={(e) => setPreset(e.target.value)} aria-label="Date range">{PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
        <label className="inline-flex items-center gap-1.5 text-xs text-[#202124]"><input type="checkbox" className="h-4 w-4 accent-[#1A73E8]" checked={compare} onChange={(e) => setCompare(e.target.checked)} /> Compare with the days before</label>
        <Button variant="secondary" size="sm" className="ml-auto" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} onClick={() => void load(true)}>Refresh</Button>
      </div>
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {data?.error && <InlineNotice tone="warning">{data.error}</InlineNotice>}
      {!data && !failed && <p className="p-6 text-center text-[13px] text-[#5F6368]">Loading…</p>}
      {data && !data.error && (
        <>
          <section className="rounded-lg border border-[#DADCE0] bg-white">
            <div role="tablist" aria-label="Metric on the chart" className="grid grid-cols-2 border-b border-[#E8EAED] sm:grid-cols-3 lg:grid-cols-6">
              {CARDS.map((c) => (
                <button key={c.id} type="button" role="tab" aria-selected={metric === c.id} onClick={() => setMetric(c.id)} className={cx('-mb-px min-w-0 border-b-2 p-3 text-left', metric === c.id ? 'border-[#1A73E8] bg-[#F8FBFF]' : 'border-transparent hover:bg-[#F8F9FA]')}>
                  <span className="block truncate text-[11px] text-[#5F6368]">{c.label}</span>
                  <span className="mt-0.5 flex flex-wrap items-baseline gap-1.5"><b className="text-[20px] font-medium text-[#202124]">{n(data.totals[c.id] || 0)}</b>{compare && <Change now={data.totals[c.id] || 0} before={data.prevTotals?.[c.id]} />}</span>
                </button>
              ))}
            </div>
            <div className="p-3"><LineChart days={data.daily} metric={chosen} currency="" compare={compare && !!data.prevTotals} /></div>
          </section>
          <div className="grid items-start gap-3 lg:grid-cols-2">
            <section className="rounded-lg border border-[#DADCE0] bg-white p-4">
              <h2 className="text-[15px] font-medium text-[#202124]">Where the profile was seen</h2>
              <ul className="mt-2 space-y-2.5">
                {SPLIT.map((s) => (
                  <li key={s.id} className="text-[13px] text-[#202124]">
                    <div className="flex justify-between gap-3"><span>{s.label}</span><span className="tabular-nums">{n(data.totals[s.id] || 0)}</span></div>
                    <div className="mt-1 h-1.5 rounded-full bg-[#F1F3F4]"><div className="h-1.5 rounded-full bg-[#1A73E8]" style={{ width: `${((data.totals[s.id] || 0) / splitTop) * 100}%` }} /></div>
                  </li>
                ))}
              </ul>
            </section>
            <section className="rounded-lg border border-[#DADCE0] bg-white">
              <h2 className="px-4 pt-3 text-[15px] font-medium text-[#202124]">Searches that found the profile</h2>
              <p className="px-4 pb-2 text-[11px] text-[#5F6368]">{monthText(data.keywordsFrom)} to {monthText(data.keywordsTo)}. Small counts are given by Google only as "below".</p>
              {data.keywordsError ? <div className="px-4 pb-3"><InlineNotice tone="warning">{data.keywordsError}</InlineNotice></div> : !data.keywords.length ? <p className="border-t border-[#E8EAED] p-6 text-center text-[13px] text-[#5F6368]">No searches for these months</p> : (
                <ul className="max-h-80 divide-y divide-[#F1F3F4] overflow-y-auto border-t border-[#E8EAED]">{data.keywords.map((k) => <li key={k.keyword} className="flex justify-between gap-3 px-4 py-2 text-[13px] text-[#202124]"><span className="min-w-0 break-words">{k.keyword}</span><span className="flex-none tabular-nums">{k.below ? `below ${n(k.value)}` : n(k.value)}</span></li>)}</ul>
              )}
            </section>
          </div>
          <p className="text-[10.5px] text-[#80868B]">From Google, {day(data.from)} to {day(data.to)}. Figures come a few days late. Views are added up per day, so one person seen on two days counts twice, and this can differ from Google's own page.</p>
        </>
      )}
    </div>
  );
};

export const BusinessProfileView: React.FC<{ canManage: boolean }> = ({ canManage }) => {
  const [location, setLocation] = useState('');
  const [tab, setTab] = useState<'profile' | 'photos' | 'performance'>('profile');
  const [photo, setPhoto] = useState('');
  const [editing, setEditing] = useState<EditSection | null>(null);
  const [opening, setOpening] = useState(false);
  const [data, setData] = useState<BusinessProfileData | null>(null);
  const [failed, setFailed] = useState('');
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);
  const load = useCallback(async (refresh = false) => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const r = await api.businessProfile.get({ location: location || undefined, refresh });
      if (mine !== latest.current) return;
      setData(r);
      setFailed('');
    } catch (e) {
      if (mine === latest.current) setFailed(errText('gbp.get', e));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  }, [location]);
  useEffect(() => void load(), [load]);
  // the picture for the preview; the screen works without it
  const location_ = data?.location || '';
  useEffect(() => {
    if (!location_) return;
    let live = true;
    api.businessProfile.photos(location_).then((r) => { if (live) setPhoto(coverOf(r.photos)); }).catch(() => undefined);
    return () => { live = false; };
  }, [location_]);
  const photosChanged = useCallback((rows: BusinessPhoto[]) => setPhoto(coverOf(rows)), []);
  // the form starts from Google's details as they are now, not from what was kept for 15 minutes
  const openEditor = async (s: EditSection) => {
    setOpening(true);
    try {
      const r = await api.businessProfile.get({ location: data?.location, refresh: true });
      setData(r);
      setFailed('');
      if (!r.error && r.edit) setEditing(s);
    } catch (e) {
      setFailed(errText('gbp.get', e));
    } finally {
      setOpening(false);
    }
  };
  const current = location || data?.location || '';
  return (
    <div className="min-h-full space-y-3 bg-[#F8F9FA] p-3 sm:p-5">
      <header className="flex flex-wrap items-center gap-2">
        {data && data.locations.length > 1 ? (
          <select className={cx(inputCls, 'w-auto max-w-full')} value={current} onChange={(e) => setLocation(e.target.value)} aria-label="Location">{data.locations.map((l) => <option key={l.name} value={l.name}>{l.title}</option>)}</select>
        ) : <span className="min-w-0 truncate text-[13px] text-[#5F6368]">{data?.locations[0]?.title}</span>}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          {data?.reviewUri && <a href={data.reviewUri} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-[#DADCE0] bg-white px-3 py-1.5 text-xs font-medium text-[#1967D2] hover:bg-[#F8F9FA]">Review link <ExternalLink size={12} /></a>}
          {data?.mapsUri && <a href={data.mapsUri} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-[#DADCE0] bg-white px-3 py-1.5 text-xs font-medium text-[#1967D2] hover:bg-[#F8F9FA]">View on Google Maps <ExternalLink size={12} /></a>}
          {tab === 'profile' && <Button variant="secondary" size="sm" icon={<RefreshCw size={13} className={loading ? 'animate-spin' : ''} />} onClick={() => void load(true)}>Refresh</Button>}
        </span>
      </header>
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {data?.error && <InlineNotice tone="warning">{data.error} {canManage && <a href="/settings?section=google" className="font-medium underline">Open Settings</a>}</InlineNotice>}
      {!data && !failed && <p className="p-6 text-center text-[13px] text-[#5F6368]">Loading…</p>}
      {data && !data.error && data.profile && (
        <>
          <div role="tablist" aria-label="Business Profile" className="flex border-b border-[#DADCE0]">
            {(['profile', 'photos', 'performance'] as const).map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx('-mb-px border-b-2 px-4 py-2.5 text-[13px] font-medium capitalize', tab === t ? 'border-[#1A73E8] text-[#1967D2]' : 'border-transparent text-[#5F6368] hover:bg-white')}>{t}</button>)}
          </div>
          {opening && <p className="text-xs text-[#5F6368]">Reading the latest details from Google…</p>}
          {tab === 'profile' && <ProfileTab data={data} canEdit={canManage} photo={photo} onEdit={(s) => void openEditor(s)} />}
          {tab === 'photos' && <PhotosTab location={data.location} canEdit={canManage} onChanged={photosChanged} />}
          {tab === 'performance' && <PerformanceTab location={data.location} />}
          {editing && data.edit && <EditDialog section={editing} data={data} photo={photo} onClose={() => setEditing(null)} onSaved={(fresh) => { setData(fresh); setEditing(null); }} />}
        </>
      )}
    </div>
  );
};
