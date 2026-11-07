/** Making a campaign, in five steps: name and template, who gets it, values, a test, then send or schedule. */
import React, { useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Upload } from 'lucide-react';
import { api, type WaCampaignView, type WaDirectTemplate } from '../../core/api';
import { F } from '../../core/config';
import { reportError, toAppError } from '../../core/errors';
import { useCompany } from '../../core/tenant';
import { readXlsxRows } from '../../core/xlsx';
import { parseCsvText } from '../../services/csvService';
import { SegmentationService } from '../../services/segmentationService';
import type { ClientSegment, Lead } from '../../types/crm';
import { Button, Field, InlineNotice, Modal, Select, cx, inputCls } from '../../components/ui';
import { VALUE_FIELDS, fillPreviewValue, filterLeads, leadToPerson, parseAudienceRows, peopleMissingValues, type ListRow, type PreviewPerson } from './campaignAudience';
import { TemplatePreview } from './TemplatePreview';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const STEPS = ['Template', 'Who gets it', 'Values', 'Test', 'Send'];
const readBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
  r.onerror = () => reject(new Error('Could not read the file'));
  r.readAsDataURL(file);
});

const Chips: React.FC<{ label: string; options: string[]; chosen: string[]; onChange: (v: string[]) => void }> = ({ label, options, chosen, onChange }) => (
  <Field label={label}>
    <div className="flex max-h-28 flex-wrap gap-1.5 overflow-y-auto">
      {options.map((o) => {
        const on = chosen.includes(o);
        return <button key={o} type="button" aria-pressed={on} onClick={() => onChange(on ? chosen.filter((x) => x !== o) : [...chosen, o])} className={cx('rounded-full border px-2.5 py-1 text-[11.5px] font-medium', on ? 'border-[#0B6BB0] bg-[#0B6BB0] text-white' : 'border-[#D3E3F0] bg-white text-[#3E5A70] hover:bg-[#F2F7FB]')}>{o}</button>;
      })}
      {!options.length && <span className="text-[11px] text-[#5E778C]">None yet</span>}
    </div>
  </Field>
);

export const CampaignWizard: React.FC<{
  leads: Lead[]; segments: ClientSegment[]; stages: string[]; sources: string[]; rms: string[]; templates: WaDirectTemplate[]; creditsOn: boolean; prices: Record<string, number>; existing?: WaCampaignView; onClose: () => void; onDone: () => void;
}> = ({ leads, segments, stages, sources, rms, templates, creditsOn, prices, existing, onClose, onDone }) => {
  const usable = useMemo(() => templates.filter((t) => t.status === 'APPROVED' && (t.sendable || t.headerMedia)), [templates]);
  const [step, setStep] = useState(0);
  const [name, setName] = useState(existing?.name || '');
  const [pick, setPick] = useState(existing ? `${existing.template}:${existing.language}` : '');
  // a draft comes back with what was typed
  const [values, setValues] = useState<Record<string, string>>(() => {
    const t = existing && usable.find((x) => x.name === existing.template && x.language === existing.language);
    return t ? Object.fromEntries(t.paramNames.map((n, i) => [n, existing!.params[i] || ''])) : {};
  });
  const [headerFileId, setHeaderFileId] = useState(existing?.headerFileId || '');
  const [headerName, setHeaderName] = useState('');
  const [mediaUrl, setMediaUrl] = useState(existing?.headerFileId ? `/api/files/${existing.headerFileId}` : '');
  const [sampleAt, setSampleAt] = useState(0);
  const company = useCompany();
  const companyName = String(company?.name || 'Your business');
  const [perDay, setPerDay] = useState(existing?.perDay || 250);
  const [source, setSource] = useState<'leads' | 'segment' | 'file'>('leads');
  const [segmentId, setSegmentId] = useState('');
  const [filters, setFilters] = useState({ stages: [] as string[], sources: [] as string[], rms: [] as string[] });
  const [list, setList] = useState<ListRow[]>([]);
  const [fileName, setFileName] = useState('');
  const [id, setId] = useState(existing?.id || '');
  const [audience, setAudience] = useState<{ added: number; skipped: Record<string, number> } | null>(null);
  const [testPhone, setTestPhone] = useState('');
  const [tested, setTested] = useState(false);
  const [when, setWhen] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const mediaRef = useRef<HTMLInputElement>(null);

  const template = usable.find((t) => `${t.name}:${t.language}` === pick);
  const chosenLeads = useMemo(() => {
    if (source === 'segment') {
      const seg = segments.find((s) => s.id === segmentId);
      return seg ? SegmentationService.getSegmentLeads(seg, leads) : [];
    }
    return source === 'leads' ? filterLeads(leads, filters) : [];
  }, [source, segmentId, segments, leads, filters]);
  const audienceCount = source === 'file' ? list.length : chosenLeads.length;
  const needsAFilter = source === 'leads' && !filters.stages.length && !filters.sources.length && !filters.rms.length;
  const price = template ? prices[template.category.toLowerCase()] ?? prices.marketing : 0;
  const people = useMemo<PreviewPerson[]>(() => (source === 'file' ? list.map((r) => ({ label: r.name || 'No name', name: r.name, rm: '', unit: '' })) : chosenLeads.map(leadToPerson)), [source, list, chosenLeads]);
  const person: PreviewPerson = people[Math.min(sampleAt, Math.max(people.length - 1, 0))] || { label: 'Sample customer', name: 'Sample Customer', rm: 'Your RM', unit: 'Sample unit' };
  const specs = template ? template.paramNames.map((n) => values[n] || '') : [];
  const previewValues = specs.map((s) => (s.trim() ? fillPreviewValue(s, person, companyName) : ''));
  const missing = useMemo(() => peopleMissingValues(specs, people, companyName), [specs.join('\u0000'), people, companyName]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (scope: string, fn: () => Promise<void>) => {
    setBusy(true);
    setProblem('');
    try {
      await fn();
    } catch (e) {
      setProblem(errText(scope, e));
    } finally {
      setBusy(false);
    }
  };
  const readFile = async (file: File) => {
    setProblem('');
    try {
      const rows = /\.xlsx$/i.test(file.name) ? readXlsxRows(new Uint8Array(await file.arrayBuffer())) : parseCsvText(await file.text());
      const r = parseAudienceRows(rows);
      setList(r.list);
      setFileName(file.name);
      if (r.problem) setProblem(r.problem);
    } catch {
      setProblem('Could not read this file. Use Excel (.xlsx) or CSV.');
    }
  };
  const addMedia = (file: File) => run('campaign.media', async () => {
    const up = await api.chat360.uploadFile({ name: file.name, mime: file.type, base64: await readBase64(file) });
    if (up.kind !== template?.headerMedia) throw new Error(`This template needs a ${template?.headerMedia}.`);
    setHeaderFileId(up.fileId);
    setHeaderName(file.name);
    setMediaUrl(URL.createObjectURL(file));
  });
  const saveDraft = async () => {
    const r = await api.campaigns.save({ id: id || undefined, name, template: template!.name, language: template!.language, params: template!.paramNames.map((n) => values[n] || ''), headerFileId, perDay });
    setId(r.id);
    return r.id;
  };

  const next = () => {
    if (step === 0) {
      if (!name.trim()) return setProblem('Give the campaign a name.');
      if (!template) return setProblem('Choose a template.');
      setProblem('');
      setStep(1);
    } else if (step === 1) {
      if (!audienceCount) return setProblem('Choose who should get this.');
      setProblem('');
      setStep(2);
    } else if (step === 2) {
      void run('campaign.save', async () => {
        const cid = await saveDraft();
        const label = source === 'file' ? `File: ${fileName}` : source === 'segment' ? `Segment: ${segments.find((s) => s.id === segmentId)?.name || ''}` : [filters.stages.join(', '), filters.sources.join(', '), filters.rms.join(', ')].filter(Boolean).join(' · ');
        setAudience(await api.campaigns.setAudience({ id: cid, label, ...(source === 'file' ? { list } : { leadIds: chosenLeads.map((l) => String(l[F.ID])) }) }));
        setTested(false);
        setStep(3);
      });
    } else if (step === 3) {
      setStep(4);
    }
  };
  const test = () => run('campaign.test', async () => {
    await api.campaigns.test(id, testPhone);
    setTested(true);
  });
  const start = () => run('campaign.start', async () => {
    await api.campaigns.start({ id, consent, ...(when === 'later' ? { at: new Date(at).toISOString() } : {}) });
    onDone();
  });

  const skipped = Object.entries(audience?.skipped || {});
  return (
    <Modal open onClose={onClose} width="lg" title={existing ? `Edit ${existing.name}` : 'New WhatsApp campaign'}
      footer={<>
        {step > 0 && <Button variant="secondary" icon={<ChevronLeft size={13} />} disabled={busy} onClick={() => { setProblem(''); setStep(step - 1); }}>Back</Button>}
        {step < 4
          ? <Button variant="primary" loading={busy} disabled={step === 3 && !tested} onClick={next}>Next <ChevronRight size={13} className="ml-1 inline" /></Button>
          : <Button variant="primary" loading={busy} disabled={!consent || (when === 'later' && !at)} onClick={() => void start()}>{when === 'later' ? 'Schedule campaign' : `Send to ${(audience?.added || 0).toLocaleString('en-IN')} people`}</Button>}
      </>}>
      <ol className="mb-4 flex flex-wrap gap-x-3 gap-y-1 text-[11.5px]" aria-label="Steps">
        {STEPS.map((s, i) => <li key={s} aria-current={i === step ? 'step' : undefined} className={cx('inline-flex items-center gap-1.5 font-semibold', i === step ? 'text-[#0B6BB0]' : i < step ? 'text-[#067647]' : 'text-[#7E93A6]')}><span className={cx('flex h-5 w-5 items-center justify-center rounded-full text-[10px]', i === step ? 'bg-[#0B6BB0] text-white' : i < step ? 'bg-[#E7F6EE]' : 'bg-[#EEF2F6]')}>{i < step ? <Check size={11} aria-hidden="true" /> : i + 1}</span>{s}</li>)}
      </ol>

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_270px]">
      <div className="min-w-0">
      {step === 0 && (
        <div className="space-y-3">
          <Field label="Campaign name"><input className={inputCls} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Diwali offer, Skyline Towers" autoFocus /></Field>
          <Field label="Template" hint="Only templates Meta has approved. Add more on the Templates tab."><Select value={pick} onChange={(e) => { setPick(e.target.value); setValues({}); setHeaderFileId(''); }} placeholder="Choose" options={usable.map((t) => ({ value: `${t.name}:${t.language}`, label: `${t.name} (${t.language}, ${t.category.toLowerCase()})` }))} /></Field>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Choose people from">
            {([['leads', 'Filter leads'], ['segment', 'Client Segment'], ['file', 'Upload a list']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={source === k} onClick={() => setSource(k)} className={cx('rounded-lg border px-3 py-1.5 text-xs font-semibold', source === k ? 'border-[#0B6BB0] bg-[#EAF4FB] text-[#0B5E9C]' : 'border-[#D3E3F0] bg-white text-[#3E5A70]')}>{l}</button>)}
          </div>
          {source === 'leads' && (
            <div className="space-y-2">
              <Chips label="Lead stage" options={stages} chosen={filters.stages} onChange={(v) => setFilters({ ...filters, stages: v })} />
              <Chips label="Source" options={sources} chosen={filters.sources} onChange={(v) => setFilters({ ...filters, sources: v })} />
              <Chips label="RM" options={rms} chosen={filters.rms} onChange={(v) => setFilters({ ...filters, rms: v })} />
              {needsAFilter && <p className="text-[11px] text-[#8A5A00]">No filter chosen, so this is every lead you can see.</p>}
            </div>
          )}
          {source === 'segment' && <Field label="Segment"><Select value={segmentId} onChange={(e) => setSegmentId(e.target.value)} placeholder="Choose" options={segments.map((s) => ({ value: s.id, label: s.name }))} /></Field>}
          {source === 'file' && (
            <div>
              <input ref={fileRef} type="file" accept=".xlsx,.csv" className="sr-only" tabIndex={-1} aria-label="Choose a list" onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f); e.target.value = ''; }} />
              <Button variant="secondary" icon={<Upload size={13} />} onClick={() => fileRef.current?.click()}>Choose Excel or CSV</Button>
              <p className="mt-1 text-[11px] text-[#5E778C]">{fileName ? `${fileName}: ${list.length.toLocaleString('en-IN')} numbers` : 'A column headed Phone, and optionally Name. It must be people who agreed to hear from you.'}</p>
            </div>
          )}
          <p className="rounded-lg bg-[#F2F7FB] px-3 py-2 text-sm font-semibold text-[#0B2A44]">{audienceCount.toLocaleString('en-IN')} {audienceCount === 1 ? 'person' : 'people'}<span className="ml-2 text-[11px] font-normal text-[#5E778C]">People who asked not to be messaged are left out next.</span></p>
        </div>
      )}

      {step === 2 && template && (
        <div className="space-y-3">
          {template.headerMedia && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase text-[#5E778C]">The {template.headerMedia} at the top</p>
              <input ref={mediaRef} type="file" className="sr-only" tabIndex={-1} accept={template.headerMedia === 'image' ? 'image/jpeg,image/png' : template.headerMedia === 'video' ? 'video/mp4' : 'application/pdf'} aria-label={`Choose the ${template.headerMedia}`} onChange={(e) => { const f = e.target.files?.[0]; if (f) void addMedia(f); e.target.value = ''; }} />
              <Button variant="secondary" icon={<Upload size={13} />} loading={busy} onClick={() => mediaRef.current?.click()}>{headerFileId ? 'Replace' : 'Choose'}</Button>
              {headerFileId && <span className="ml-2 text-xs text-[#067647]">{headerName || 'Added'}</span>}
              <p className="mt-1 text-[11px] text-[#5E778C]">Up to 3 MB. Everyone gets the same one.</p>
            </div>
          )}
          {!template.paramNames.length && !template.headerMedia && <p className="text-xs text-[#5E778C]">This template has nothing to fill in.</p>}
          {template.paramNames.map((n) => (
            <Field key={n} label={`Value for {{${n}}}`} hint="Type the same words for everyone, or choose a detail below for each person. A missing name reads “there”.">
              <input className={inputCls} value={values[n] || ''} maxLength={500} onChange={(e) => setValues((v) => ({ ...v, [n]: e.target.value }))} />
              <div className="mt-1 flex flex-wrap gap-1">{VALUE_FIELDS.map((f) => <button key={f.token} type="button" className="rounded border border-[#D3E3F0] px-1.5 py-0.5 text-[11px] text-[#0B5E9C] hover:bg-[#F2F7FB]" onClick={() => setValues((v) => ({ ...v, [n]: (v[n] || '') + f.token }))}>{f.label}</button>)}</div>
            </Field>
          ))}
          <Field label="Most to send in a day" hint="Across all your campaigns. Meta limits how many new customers a number can message, and starts low. Over that, messages fail."><input className={cx(inputCls, '!w-32')} type="number" min={1} value={perDay} onChange={(e) => setPerDay(Number(e.target.value))} /></Field>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-3">
          {audience && (
            <div className="rounded-lg bg-[#F2F7FB] px-3 py-2 text-xs text-[#3E5A70]">
              <p className="text-sm font-semibold text-[#0B2A44]">{audience.added.toLocaleString('en-IN')} will get this</p>
              {skipped.length > 0 && <p className="mt-0.5">Left out: {skipped.map(([k, n]) => `${k} (${n})`).join(', ')}</p>}
            </div>
          )}
          <Field label="Your own WhatsApp number" hint="This sends one real message, using sample values. It costs one message."><input className={inputCls} inputMode="tel" value={testPhone} onChange={(e) => { setTestPhone(e.target.value); }} placeholder="91 98765 43210" /></Field>
          <Button variant="secondary" loading={busy} disabled={!testPhone.trim()} onClick={() => void test()}>Send test</Button>
          {tested && <InlineNotice tone="info">Test sent. Check it on your phone before going on.</InlineNotice>}
        </div>
      )}

      {step === 4 && audience && (
        <div className="space-y-3">
          <dl className="grid grid-cols-2 gap-3 text-xs">
            <div><dt className="text-[#5E778C]">Template</dt><dd className="break-all font-semibold text-[#0B2A44]">{template?.name}</dd></div>
            <div><dt className="text-[#5E778C]">People</dt><dd className="font-semibold text-[#0B2A44]">{audience.added.toLocaleString('en-IN')}</dd></div>
            {creditsOn && <div><dt className="text-[#5E778C]">About</dt><dd className="font-semibold text-[#0B2A44]">₹{(audience.added * price).toLocaleString('en-IN', { maximumFractionDigits: 2 })} of credits, before GST</dd></div>}
            {perDay < audience.added && <div><dt className="text-[#5E778C]">Takes</dt><dd className="font-semibold text-[#0B2A44]">About {Math.ceil(audience.added / perDay)} days, at {perDay.toLocaleString('en-IN')} a day</dd></div>}
          </dl>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="When">
            {([['now', 'Send now'], ['later', 'Schedule']] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={when === k} onClick={() => setWhen(k)} className={cx('rounded-lg border px-3 py-1.5 text-xs font-semibold', when === k ? 'border-[#0B6BB0] bg-[#EAF4FB] text-[#0B5E9C]' : 'border-[#D3E3F0] bg-white text-[#3E5A70]')}>{l}</button>)}
          </div>
          {when === 'later' && <Field label="When" hint="It starts when the background job next runs after this time, which can be late."><input className={cx(inputCls, '!w-auto')} type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} /></Field>}
          <label className="flex items-start gap-2 rounded-lg border border-[#F2D58A] bg-[#FFF8E6] p-3 text-xs text-[#6B4700]">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>These people agreed to hear from us on WhatsApp. Meta requires this, and messaging people who did not can get this number restricted. This confirmation is saved with your name.</span>
          </label>
        </div>
      )}
      {problem && <InlineNotice tone="warning" className="mt-3">{problem}</InlineNotice>}
      </div>

      <aside className="md:sticky md:top-0 md:self-start">
        <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#5E778C]">Preview</p>
        <TemplatePreview template={template} values={previewValues} business={companyName} mediaUrl={mediaUrl} mediaName={headerName} />
        {template && (
          <div className="mt-2 text-[11px] text-[#5E778C]">
            {people.length > 1 ? (
              <div className="flex items-center gap-1">
                <Button variant="secondary" size="xs" icon={<ChevronLeft size={12} />} aria-label="Previous person" disabled={sampleAt <= 0} onClick={() => setSampleAt(Math.max(0, sampleAt - 1))} />
                <span className="min-w-0 flex-1 truncate text-center" aria-live="polite"><b className="font-semibold text-[#0B2A44]">{person.label}</b> · {(Math.min(sampleAt, people.length - 1) + 1).toLocaleString('en-IN')} of {people.length.toLocaleString('en-IN')}</span>
                <Button variant="secondary" size="xs" icon={<ChevronRight size={12} />} aria-label="Next person" disabled={sampleAt >= people.length - 1} onClick={() => setSampleAt(Math.min(people.length - 1, sampleAt + 1))} />
              </div>
            ) : <p className="text-center">{people.length === 1 ? <>For <b className="font-semibold text-[#0B2A44]">{person.label}</b></> : 'With sample details, until you choose people'}</p>}
            {missing > 0 && <p className="mt-1.5 flex items-start gap-1 text-[#93370D]"><AlertTriangle size={12} className="mt-px flex-none" aria-hidden="true" />{missing.toLocaleString('en-IN')} {missing === 1 ? 'person is' : 'people are'} missing a value here, and would not get this.</p>}
            <p className="mt-1.5">It may look slightly different on each phone. Your test message shows the real thing.</p>
          </div>
        )}
      </aside>
      </div>
    </Modal>
  );
};
