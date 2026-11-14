/**
 * Drip campaigns (/dripcampaigns; server: modules/dripCampaigns.ts). A company builds its own series of steps, each WhatsApp,
 * e-mail or an RM task, for new leads. A campaign starts as a draft and needs a test send before it can run.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Activity, ArrowDown, Mail, MessageCircle, Pause, Pencil, Play, Plus, Send, Settings2, Trash2, UserCheck } from 'lucide-react';
import { api, type DripActivityRow, type DripCampaignView, type DripOverview, type DripStepInput } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, EmptyState, Field, InlineNotice, Modal, cx, inputCls } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const CHANNELS = { whatsapp: { label: 'WhatsApp', icon: MessageCircle }, email: { label: 'E-mail', icon: Mail }, task: { label: 'RM task', icon: UserCheck } } as const;
type Channel = keyof typeof CHANNELS;
const STATUS = { draft: { label: 'Draft', tone: 'muted' }, active: { label: 'Running', tone: 'sage' }, paused: { label: 'Paused', tone: 'amber' }, archived: { label: 'Archived', tone: 'muted' } } as const;
const VAR_HINT = 'You can use {name}, {first_name}, {rm}, {source} and {company}.';

const waitText = (m: number) => (!m ? 'Straight away' : m % 1440 === 0 ? `After ${m / 1440} day${m === 1440 ? '' : 's'}` : m % 60 === 0 ? `After ${m / 60} hour${m === 60 ? '' : 's'}` : `After ${m} minutes`);
const hourText = (h: number) => `${h % 12 || 12} ${h < 12 || h === 24 ? 'am' : 'pm'}`;
const newStep = (channel: Channel = 'whatsapp'): DripStepInput => ({ id: '', channel, waitMinutes: 0, template: '', params: [], subject: '', body: '', taskName: '' });
const blank = () => ({ id: '', name: '', sources: '', stages: '', hoursFrom: 9, hoursTo: 20, dailyLimit: 200, stopOnVisit: true, steps: [newStep()] });
type Draft = ReturnType<typeof blank>;

const Builder: React.FC<{ draft: Draft; data: DripOverview; onClose: () => void; onSaved: () => void }> = ({ draft: first, data, onClose, onSaved }) => {
  const [d, setD] = useState<Draft>(first);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const step = (i: number, patch: Partial<DripStepInput>) => setD((x) => ({ ...x, steps: x.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) }));
  const unit = (m: number) => (m && m % 1440 === 0 ? 1440 : m && m % 60 === 0 ? 60 : m ? 1 : 1440);
  const save = async () => {
    setBusy(true);
    setProblem('');
    try {
      await api.drip.save({ id: d.id || undefined, name: d.name, sources: d.sources.split(',').map((s) => s.trim()).filter(Boolean), stages: d.stages.split(',').map((s) => s.trim()).filter(Boolean), hoursFrom: d.hoursFrom, hoursTo: d.hoursTo, dailyLimit: d.dailyLimit, stopOnVisit: d.stopOnVisit, steps: d.steps });
      toast('Campaign saved', 'Send a test before starting it.', 'success');
      onSaved();
    } catch (e) {
      setProblem(errText('drip.save', e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={d.id ? 'Edit drip campaign' : 'New drip campaign'} width="lg" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Save as draft</Button></>}>
      <div className="space-y-4">
        {problem && <InlineNotice tone="warning">{problem}</InlineNotice>}
        <Field label="Campaign name"><input className={inputCls} value={d.name} maxLength={120} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="New Facebook leads" /></Field>
        <Field label="Which new leads join" hint="Enquiry sources, separated by commas, such as Facebook, Website. Leave empty for all new leads. Imported leads never join."><input className={inputCls} value={d.sources} onChange={(e) => setD({ ...d, sources: e.target.value })} placeholder="All new leads" /></Field>
        <Field label="Or start when a lead reaches a stage" hint="Tick the stages that should start this campaign. A lead joins the moment it reaches one of them — even an older lead that moves up later. Leave all unticked to start new leads only (above).">
          {(() => {
            const chosen = new Set(d.stages.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
            const toggle = (st: string) => {
              const picked = (data.stageOptions || []).filter((o) => (o.toLowerCase() === st.toLowerCase() ? !chosen.has(st.toLowerCase()) : chosen.has(o.toLowerCase())));
              setD({ ...d, stages: picked.join(', ') });
            };
            return (data.stageOptions || []).length
              ? <div className="flex flex-wrap gap-1.5">{data.stageOptions.map((st) => <label key={st} className={cx('inline-flex items-center gap-1.5 cursor-pointer rounded-full border px-2.5 py-1 text-[11px]', chosen.has(st.toLowerCase()) ? 'border-[#0B6BB0] bg-[#E8F2FB] text-[#0B2A44] font-medium' : 'border-[#D3E3F0] bg-white text-[#44505c]')}><input type="checkbox" className="h-3.5 w-3.5" checked={chosen.has(st.toLowerCase())} onChange={() => toggle(st)} />{st}</label>)}</div>
              : <input className={inputCls} value={d.stages} onChange={(e) => setD({ ...d, stages: e.target.value })} placeholder="e.g. Warm, Qualified" />;
          })()}
        </Field>
        <div className="space-y-2">
          {d.steps.map((s, i) => (
            <React.Fragment key={i}>
              {i > 0 && <ArrowDown size={15} className="mx-auto text-[#5E778C]" aria-hidden="true" />}
              <section className="space-y-2 rounded-lg border border-[#D3E3F0] bg-[#F7FBFE] p-3" aria-label={`Step ${i + 1}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-xs text-[#0B2A44]">Step {i + 1}</b>
                  <select className={cx(inputCls, 'w-auto py-1.5')} aria-label={`Step ${i + 1} channel`} value={s.channel} onChange={(e) => step(i, { channel: e.target.value as Channel })}>
                    {(Object.keys(CHANNELS) as Channel[]).map((c) => <option key={c} value={c}>{CHANNELS[c].label}</option>)}
                  </select>
                  <label className="inline-flex items-center gap-1.5 text-xs text-[#2B4A63]">Wait
                    <input type="number" min={0} className={cx(inputCls, 'w-20 py-1.5')} aria-label={`Step ${i + 1} wait`} value={s.waitMinutes / unit(s.waitMinutes) || 0} onChange={(e) => step(i, { waitMinutes: Math.max(0, Number(e.target.value) || 0) * unit(s.waitMinutes) })} />
                    <select className={cx(inputCls, 'w-auto py-1.5')} aria-label={`Step ${i + 1} wait unit`} value={unit(s.waitMinutes)} onChange={(e) => step(i, { waitMinutes: (s.waitMinutes / unit(s.waitMinutes) || 0) * Number(e.target.value) })}><option value={60}>hours</option><option value={1440}>days</option></select>
                  </label>
                  {d.steps.length > 1 && <button type="button" aria-label={`Remove step ${i + 1}`} className="ml-auto rounded p-1 text-[#A50E0E] hover:bg-white" onClick={() => setD({ ...d, steps: d.steps.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>}
                </div>
                {s.channel === 'whatsapp' && (
                  <>
                    {!data.whatsapp.ready && <InlineNotice tone="warning">{data.whatsapp.reason}</InlineNotice>}
                    <Field label="Approved template" hint="Choose one of your approved WhatsApp templates. WhatsApp only allows approved templates for leads who haven't messaged you in the last 24 hours.">
                      {(data.templates || []).length > 0 && (
                        <select className={cx(inputCls, 'mb-1.5')} aria-label="Pick an approved template" value={data.templates.includes(s.template) ? s.template : ''} onChange={(e) => { if (e.target.value) step(i, { template: e.target.value }); }}>
                          <option value="">Pick an approved template…</option>
                          {data.templates.map((t) => <option key={t} value={t}>{t}</option>)}
                        </select>
                      )}
                      <input className={inputCls} value={s.template} onChange={(e) => step(i, { template: e.target.value })} placeholder={(data.templates || []).length ? 'Or type the template name' : 'welcome_message'} />
                    </Field>
                    <Field label="Template values, one per line" hint={`In the template's order, or as first_name={first_name}. ${VAR_HINT}`}><textarea rows={2} className={inputCls} value={s.params.join('\n')} onChange={(e) => step(i, { params: e.target.value.split('\n') })} placeholder="{first_name}" /></Field>
                  </>
                )}
                {s.channel === 'email' && (
                  <>
                    {!data.email.ready && <InlineNotice tone="warning">{data.email.reason}</InlineNotice>}
                    <Field label="Subject"><input className={inputCls} value={s.subject} maxLength={200} onChange={(e) => step(i, { subject: e.target.value })} /></Field>
                    <Field label="E-mail text" hint={`${VAR_HINT} An unsubscribe link is added for you.`}><textarea rows={5} className={inputCls} value={s.body} onChange={(e) => step(i, { body: e.target.value })} /></Field>
                  </>
                )}
                {s.channel === 'task' && <Field label="What should the RM do?" hint={VAR_HINT}><input className={inputCls} value={s.taskName} onChange={(e) => step(i, { taskName: e.target.value })} placeholder="Call {name} about a site visit" /></Field>}
              </section>
            </React.Fragment>
          ))}
          {d.steps.length < 10 && <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => setD({ ...d, steps: [...d.steps, { ...newStep(), waitMinutes: 1440 }] })}>Add a step</Button>}
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Send from"><select className={inputCls} value={d.hoursFrom} onChange={(e) => setD({ ...d, hoursFrom: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourText(h)}</option>)}</select></Field>
          <Field label="Until (India time)"><select className={inputCls} value={d.hoursTo} onChange={(e) => setD({ ...d, hoursTo: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => h + 1).map((h) => <option key={h} value={h}>{hourText(h)}</option>)}</select></Field>
          <Field label="Most messages a day"><input type="number" min={1} max={2000} className={inputCls} value={d.dailyLimit} onChange={(e) => setD({ ...d, dailyLimit: Number(e.target.value) || 1 })} /></Field>
        </div>
        <label className="flex items-start gap-2 text-xs text-[#0B2A44]"><input type="checkbox" className="mt-0.5 h-4 w-4" checked={d.stopOnVisit} onChange={(e) => setD({ ...d, stopOnVisit: e.target.checked })} />Stop when a site visit is scheduled or done</label>
        <p className="text-[11px] text-[#5E778C]">Always stops when the lead replies on WhatsApp, says STOP, or becomes Booked, Lost or Disqualified. Unsubscribing stops only the e-mails.</p>
      </div>
    </Modal>
  );
};

const TestWindow: React.FC<{ c: DripCampaignView; onClose: () => void; onDone: () => void }> = ({ c, onClose, onDone }) => {
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [results, setResults] = useState<Array<{ step: number; channel: string; ok: boolean; message: string }> | null>(null);
  const has = (ch: string) => c.steps.some((s) => s.channel === ch);
  const run = async () => {
    setBusy(true);
    setProblem('');
    try {
      const r = await api.drip.test({ id: c.id, phone, email });
      setResults(r.results);
      if (r.passed) onDone();
    } catch (e) {
      setProblem(errText('drip.test', e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={`Test: ${c.name}`} width="sm" footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button variant="primary" loading={busy} icon={<Send size={13} />} onClick={() => void run()}>Send test</Button></>}>
      <div className="space-y-3">
        <p className="text-xs text-[#2B4A63]">Every message goes out now, one after another, with sample details. Use your own number and e-mail, because these are real messages.</p>
        {problem && <InlineNotice tone="warning">{problem}</InlineNotice>}
        {has('whatsapp') && <Field label="Your WhatsApp number"><input className={inputCls} value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" /></Field>}
        {has('email') && <Field label="Your e-mail"><input type="email" className={inputCls} value={email} onChange={(e) => setEmail(e.target.value)} /></Field>}
        {results?.map((r) => <p key={r.step} className={cx('text-xs', r.ok ? 'text-[#137333]' : 'text-[#A50E0E]')}>Step {r.step}: {r.message}</p>)}
      </div>
    </Modal>
  );
};

/** WhatsApp (Chat360) connection status for drip — the counterpart of the mail account card, so the WhatsApp channel's readiness is visible on the screen (not only as a warning inside a step). */
const WhatsAppCard: React.FC<{ status: DripOverview['whatsapp'] }> = ({ status }) => (
  <Card title={<span className="inline-flex items-center gap-2"><MessageCircle size={15} /> WhatsApp (Chat360)</span>}
    subtitle="How drip WhatsApp steps are sent.">
    {status.ready
      ? <InlineNotice tone="success">Connected. WhatsApp steps send your approved templates automatically. WhatsApp only allows approved templates for leads who haven’t messaged in the last 24 hours — set them up in Chat360.</InlineNotice>
      : <InlineNotice tone="warning">{status.reason} Connect WhatsApp in Settings → Integrations → Chat360, then reopen this page.</InlineNotice>}
  </Card>
);

const MailCard: React.FC<{ mail: NonNullable<DripOverview['mail']>; ready: boolean; onSaved: () => void }> = ({ mail, ready, onSaved }) => {
  const [f, setF] = useState({ ...mail, pass: '' });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      await api.drip.saveEmail({ host: f.host, port: f.port, user: f.user, pass: f.pass, fromName: f.fromName, fromEmail: f.fromEmail });
      toast('Mail account saved', 'A campaign test will show whether it can send.', 'success');
      setF((x) => ({ ...x, pass: '' }));
      onSaved();
    } catch (e) {
      toast('Not saved', errText('drip.saveEmail', e), 'alert');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={<span className="inline-flex items-center gap-2"><Settings2 size={15} /> Company mail account</span>} subtitle={ready ? 'Drip e-mails go out through this account.' : 'Needed for e-mail steps. Use your own domain, because free mail addresses often land in spam.'}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Mail server"><input className={inputCls} value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp.example.com" /></Field>
        <Field label="Port"><select className={inputCls} value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })}>{[587, 465, 2525].map((p) => <option key={p} value={p}>{p}</option>)}</select></Field>
        <Field label="User name"><input className={inputCls} autoComplete="off" value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} /></Field>
        <Field label="Password" hint={mail.passSet ? 'Saved. Enter a new one only to replace it.' : undefined}><input type="password" autoComplete="new-password" className={inputCls} value={f.pass} onChange={(e) => setF({ ...f, pass: e.target.value })} /></Field>
        <Field label="Sender name"><input className={inputCls} value={f.fromName} onChange={(e) => setF({ ...f, fromName: e.target.value })} /></Field>
        <Field label="Send from address"><input type="email" className={inputCls} value={f.fromEmail} onChange={(e) => setF({ ...f, fromEmail: e.target.value })} /></Field>
      </div>
      <div className="mt-3 flex justify-end"><Button variant="primary" size="sm" loading={busy} onClick={() => void save()}>Save mail account</Button></div>
    </Card>
  );
};

export const DripCampaignsView: React.FC = () => {
  const [data, setData] = useState<DripOverview | null>(null);
  const [failed, setFailed] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [testing, setTesting] = useState<DripCampaignView | null>(null);
  const [activity, setActivity] = useState<{ c: DripCampaignView; rows: DripActivityRow[] | null } | null>(null);
  const [busy, setBusy] = useState('');
  const load = useCallback(async () => {
    try {
      setData(await api.drip.get());
      setFailed('');
    } catch (e) {
      setFailed(errText('drip.get', e));
    }
  }, []);
  useEffect(() => void load(), [load]);

  const setStatus = async (c: DripCampaignView, status: 'active' | 'paused' | 'archived') => {
    const asks = { active: `Start "${c.name}"? Every new lead that fits will start getting real messages.`, paused: `Pause "${c.name}"? Nothing more goes out until you start it again.`, archived: `Archive "${c.name}"? Leads in it stop getting messages, and this can't be undone.` };
    if (!window.confirm(asks[status])) return;
    setBusy(c.id);
    try {
      await api.drip.setStatus(c.id, status);
      await load();
    } catch (e) {
      toast('Not changed', errText('drip.status', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const openActivity = async (c: DripCampaignView) => {
    setActivity({ c, rows: null });
    try {
      setActivity({ c, rows: (await api.drip.activity(c.id)).rows });
    } catch (e) {
      setActivity(null);
      toast('Could not load activity', errText('drip.activity', e), 'alert');
    }
  };
  const toDraft = (c: DripCampaignView): Draft => ({ id: c.id, name: c.name, sources: c.sources.join(', '), stages: (c.stages || []).join(', '), hoursFrom: c.hoursFrom, hoursTo: c.hoursTo, dailyLimit: c.dailyLimit, stopOnVisit: c.stopOnVisit, steps: c.steps });

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-[#5E778C]">A series of messages new leads get over time, on WhatsApp, by e-mail, or as reminders for the RM.</p>
        <Button variant="primary" size="sm" icon={<Plus size={14} />} disabled={!data} onClick={() => setEditing(blank())}>New campaign</Button>
      </div>
      {failed && <InlineNotice tone="warning">{failed}</InlineNotice>}
      {!data && !failed && <p className="p-8 text-center text-xs text-[#5E778C]">Loading…</p>}
      {data && !data.campaigns.length && <EmptyState icon={<Send size={22} />} title="No campaigns yet" description="Create your first one. It starts as a draft, so nothing is sent until you test and start it." />}
      {data?.campaigns.map((c) => (
        <Card key={c.id} title={<span className="inline-flex flex-wrap items-center gap-2">{c.name}<Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge></span>}
          subtitle={`${c.stages && c.stages.length ? `Starts at stage: ${c.stages.join(', ')}${c.sources.length ? ` (from ${c.sources.join(', ')})` : ''}` : c.sources.length ? c.sources.join(', ') : 'All new leads'} · ${hourText(c.hoursFrom)} to ${hourText(c.hoursTo)} India time · up to ${c.dailyLimit} a day`}>
          <ol className="flex flex-wrap items-center gap-1.5">
            {c.steps.map((s, i) => {
              const Icon = CHANNELS[s.channel].icon;
              return <li key={s.id || i} className="inline-flex items-center gap-1.5 rounded-full border border-[#D3E3F0] bg-[#F7FBFE] px-2.5 py-1 text-[11px] text-[#0B2A44]"><Icon size={12} aria-hidden="true" />{CHANNELS[s.channel].label}<span className="text-[#5E778C]">· {waitText(s.waitMinutes)}</span></li>;
            })}
          </ol>
          <dl className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6">
            {([['In progress', c.stats.running], ['Finished', c.stats.finished], ['Stopped', c.stats.stopped], ['Sent', c.stats.sent], ['Skipped', c.stats.skipped], ['Failed', c.stats.failed]] as Array<[string, number]>).map(([label, v]) => <div key={label}><dt className="text-[10.5px] text-[#5E778C]">{label}</dt><dd className="text-base font-semibold text-[#0B2A44]">{v.toLocaleString('en-IN')}</dd></div>)}
          </dl>
          {c.stats.entered > 0 && (
            <div className="mt-3 rounded-lg bg-[#F7FBFE] border border-[#E3EDF5] px-3 py-2">
              <p className="text-[11px] font-semibold text-[#0B2A44]">Results for these {c.stats.entered} lead{c.stats.entered === 1 ? '' : 's'}</p>
              <dl className="mt-1.5 grid grid-cols-3 gap-2">
                {([['Replied on WhatsApp', c.stats.replied], ['Site visits', c.stats.visits], ['Bookings', c.stats.bookings]] as Array<[string, number]>).map(([label, v]) => <div key={label}><dt className="text-[10.5px] text-[#5E778C]">{label}</dt><dd className="text-sm font-bold text-[#0B2A44] tabular-nums">{v} <span className="text-[11px] font-normal text-[#5E778C]">{Math.round((v / c.stats.entered) * 100)}%</span></dd></div>)}
              </dl>
              <p className="mt-1.5 text-[10.5px] text-[#5E778C]">Everything these leads did after joining, including after a call from an RM.</p>
            </div>
          )}
          {c.status !== 'active' && !c.tested && c.steps.some((s) => s.channel !== 'task') && <p className="mt-2 text-[11px] text-[#8A5A00]">Send a test before starting this campaign.</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            {c.status !== 'active' && <Button variant="secondary" size="xs" icon={<Pencil size={12} />} onClick={() => setEditing(toDraft(c))}>Edit</Button>}
            {c.status !== 'active' && <Button variant="secondary" size="xs" icon={<Send size={12} />} onClick={() => setTesting(c)}>Test</Button>}
            {c.status === 'active'
              ? <Button variant="secondary" size="xs" icon={<Pause size={12} />} loading={busy === c.id} onClick={() => void setStatus(c, 'paused')}>Pause</Button>
              : <Button variant="primary" size="xs" icon={<Play size={12} />} loading={busy === c.id} onClick={() => void setStatus(c, 'active')}>Start</Button>}
            <Button variant="secondary" size="xs" icon={<Activity size={12} />} onClick={() => void openActivity(c)}>Activity</Button>
            <Button variant="secondary" size="xs" icon={<Trash2 size={12} />} loading={busy === c.id} onClick={() => void setStatus(c, 'archived')}>Archive</Button>
          </div>
        </Card>
      ))}
      {data && <WhatsAppCard status={data.whatsapp} />}
      {data?.mail && <MailCard mail={data.mail} ready={data.email.ready} onSaved={() => void load()} />}
      {editing && data && <Builder draft={editing} data={data} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); void load(); }} />}
      {testing && <TestWindow c={testing} onClose={() => setTesting(null)} onDone={() => void load()} />}
      {activity && (
        <Modal open onClose={() => setActivity(null)} title={`Activity: ${activity.c.name}`} width="lg" footer={<Button variant="secondary" onClick={() => setActivity(null)}>Close</Button>}>
          {activity.rows === null ? <p className="p-6 text-center text-xs text-[#5E778C]">Loading…</p> : !activity.rows.length ? <p className="p-6 text-center text-xs text-[#5E778C]">Nothing yet.</p> : (
            <div className="overflow-x-auto"><table className="w-full min-w-[520px] border-collapse text-xs text-[#0B2A44]">
              <thead><tr className="border-b border-[#D3E3F0] text-left text-[#5E778C]"><th scope="col" className="p-2 font-medium">When</th><th scope="col" className="p-2 font-medium">Lead</th><th scope="col" className="p-2 font-medium">Channel</th><th scope="col" className="p-2 font-medium">Result</th></tr></thead>
              <tbody className="divide-y divide-[#EEF4F9]">{activity.rows.map((r) => <tr key={r.id} className="align-top"><td className="whitespace-nowrap p-2">{new Date(r.at).toLocaleString()}</td><td className="p-2">{r.leadId}</td><td className="p-2">{r.status === 'stopped' ? '—' : CHANNELS[r.channel as Channel]?.label}</td><td className="p-2"><span className="font-medium capitalize">{r.status}</span>{r.detail ? `: ${r.detail}` : ''}</td></tr>)}</tbody>
            </table></div>
          )}
        </Modal>
      )}
    </div>
  );
};
