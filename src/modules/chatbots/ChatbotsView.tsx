/** WhatsApp chatbots (plan feature whatsappBots; server: modules/whatsappBots.ts): build from blocks, try it in a test chat, start it, see how it does. */
import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Bot, CalendarCheck, CheckCircle2, Clock, Copy, Facebook, Globe, HelpCircle, Instagram, MessageSquare, Pause, Pencil, Play, Plus, Search, Send, Star, Trash2, Upload, UserRound } from 'lucide-react';
import { api, type BotOutgoing, type BotSimResult, type BotStepView, type BotView, type BotsOverview, type OfficeHours } from '../../core/api';
import { BOT_CHANNELS, BOT_CHANNEL_LABEL, type BotChannel } from '../../core/botEngine';
import { WhatsAppIcon } from '../../components/WhatsAppIcon';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Button, ConfirmDialog, InlineNotice, LoadingState, Modal, Select, cx, inputCls } from '../../components/ui';
import type { BotDraft } from './BotFlowEditor';

const BotFlowEditor = React.lazy(() => import('./BotFlowEditor').then((m) => ({ default: m.BotFlowEditor })));

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const STATUS_PILL: Record<BotView['status'], { label: string; dot: string; bg: string; fg: string }> = {
  active: { label: 'Running', dot: '#16A34A', bg: '#E7F6EE', fg: '#067647' },
  paused: { label: 'Paused', dot: '#F0A202', bg: '#FFF4E5', fg: '#8A5A00' },
  draft: { label: 'Draft', dot: '#9CB0C0', bg: '#EEF2F6', fg: '#5E778C' },
};
const CHANNEL_ICON: Record<BotChannel, { icon: React.ElementType; tint: string }> = {
  whatsapp: { icon: WhatsAppIcon, tint: '#25D366' }, website: { icon: Globe, tint: '#E86B2A' }, instagram: { icon: Instagram, tint: '#C1398B' }, facebook: { icon: Facebook, tint: '#2E6FBA' },
};
const TRIGGER: Record<BotView['trigger'], string> = { new: 'First message from a new customer', keyword: 'A customer sends a keyword', any: 'Any customer message, if nobody replied in the last day' };

let counter = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;
const blank = (type: BotStepView['type'] = 'message'): BotStepView => ({ id: newId('s'), type, text: '', next: '', saveTo: '', validate: 'text', options: type === 'choice' ? [{ id: newId('o'), label: '', next: '' }, { id: newId('o'), label: '', next: '' }] : [], days: 7, times: ['11:00', '15:00', '17:00'] });
/** A ready start for a property enquiry, to change rather than begin from nothing. */
const starterSteps = (): BotStepView[] => [
  { ...blank('message'), text: 'Hello! Thanks for contacting {company}. I am the automated assistant, and I will get you to the right person.' },
  { ...blank('question'), text: 'May I know your name?', saveTo: 'name' },
  { ...blank('choice'), text: 'Thanks {first_name}. What are you looking for?', saveTo: 'unit', options: [{ id: newId('o'), label: '2 BHK', next: '' }, { id: newId('o'), label: '3 BHK', next: '' }, { id: newId('o'), label: 'Not sure yet', next: '' }] },
  { ...blank('visit'), text: 'Would you like to see the project? Which day suits you?' },
  { ...blank('handoff'), text: 'Your visit is noted for {visit}. Our team will call you to confirm. Thank you!' },
];

/** A Google review funnel: rate first; happy customers get the review link, unhappy ones go to the team (not to Google). */
const reviewSteps = (): BotStepView[] => {
  const intro = newId('s'), ask = newId('s'), happy = newId('s'), done = newId('s'), sorry = newId('s');
  return [
    { ...blank('message'), id: intro, text: 'Hi {first_name}! Thanks for choosing {company}. 🙏 Could you spare 20 seconds to share your experience?', next: ask },
    { ...blank('choice'), id: ask, text: 'How was your experience with us?', options: [
      { id: newId('o'), label: '⭐ Great', next: happy },
      { id: newId('o'), label: '😕 Could be better', next: sorry },
    ] },
    { ...blank('message'), id: happy, text: 'Wonderful! 🌟 A quick Google review helps other families find us:\n\n👉 PASTE YOUR GOOGLE REVIEW LINK HERE\n\nThank you so much!', next: done },
    { ...blank('end'), id: done, text: '' },
    { ...blank('handoff'), id: sorry, text: 'We’re sorry it wasn’t great. Our team will reach out personally to make it right — thank you for telling us.' },
  ];
};

interface Template { id: string; name: string; desc: string; keywords: string; trigger: BotDraft['trigger']; steps: () => BotStepView[] }
const TEMPLATES: Template[] = [
  { id: 'enquiry', name: 'Property enquiry', desc: 'Greets the customer, captures their name and interest, offers a site visit, then hands off to your team.', keywords: '', trigger: 'new', steps: starterSteps },
  { id: 'reviews', name: 'Collect Google reviews', desc: 'Asks for a rating; sends happy customers your Google review link and routes unhappy ones to your team instead of to Google.', keywords: 'review, feedback', trigger: 'keyword', steps: reviewSteps },
  { id: 'blank', name: 'Start from scratch', desc: 'An empty bot with one welcome message — build the flow your own way.', keywords: '', trigger: 'new', steps: () => [{ ...blank('message'), text: 'Hello! Thanks for contacting {company}.' }] },
];

type Draft = BotDraft;
const toDraft = (b: BotView): Draft => ({ id: b.id, name: b.name, trigger: b.trigger, keywords: b.keywords.join(', '), channels: b.channels, steps: b.steps, knowledge: b.knowledge });
const draftFromTemplate = (t: Template): Draft => ({ name: t.name, trigger: t.trigger, keywords: t.keywords, channels: [...BOT_CHANNELS], steps: t.steps(), knowledge: '' });
const newDraft = (): Draft => draftFromTemplate(TEMPLATES[0]);

/* ----------------------------- import / export ---------------------------- */
const TYPES = ['message', 'question', 'choice', 'visit', 'ai', 'handoff', 'end'];
const SAVES = ['', 'name', 'email', 'phone', 'unit', 'city', 'budget', 'purpose', 'notes'];
const coerceStep = (raw: any): BotStepView => ({
  id: typeof raw?.id === 'string' && raw.id ? raw.id : newId('s'),
  type: (TYPES.includes(raw?.type) ? raw.type : 'message') as BotStepView['type'],
  text: String(raw?.text ?? ''), next: String(raw?.next ?? ''),
  saveTo: (SAVES.includes(raw?.saveTo) ? raw.saveTo : '') as BotStepView['saveTo'],
  validate: raw?.validate === 'email' || raw?.validate === 'number' ? raw.validate : 'text',
  options: Array.isArray(raw?.options) ? raw.options.map((o: any, j: number) => ({ id: typeof o?.id === 'string' && o.id ? o.id : newId('o'), label: String(o?.label ?? `Option ${j + 1}`), next: String(o?.next ?? '') })) : [],
  days: Number(raw?.days) || 7,
  times: Array.isArray(raw?.times) ? raw.times.map(String).filter(Boolean) : ['11:00', '15:00', '17:00'],
});
const normalizeImport = (raw: any): Draft => ({
  name: String(raw?.name ?? 'Imported bot').slice(0, 80),
  trigger: raw?.trigger === 'keyword' || raw?.trigger === 'any' ? raw.trigger : 'new',
  keywords: Array.isArray(raw?.keywords) ? raw.keywords.join(', ') : String(raw?.keywords ?? ''),
  channels: (Array.isArray(raw?.channels) ? (raw.channels as any[]).filter((c) => BOT_CHANNELS.includes(c)) : []) as BotChannel[],
  steps: Array.isArray(raw?.steps) ? raw.steps.map(coerceStep) : [],
  knowledge: String(raw?.knowledge ?? ''),
});
const exportText = (b: BotView) => JSON.stringify({ name: b.name, trigger: b.trigger, keywords: b.keywords, channels: b.channels, knowledge: b.knowledge, steps: b.steps }, null, 2);

type Line = { from: 'bot' | 'you' | 'note'; o?: BotOutgoing; text?: string };

/** The test chat: the real bot logic on the saved bot. Nothing is sent to anyone, and no lead changes. */
const TestChat: React.FC<{ bot: BotView; onClose: () => void; onDone: () => void }> = ({ bot, onClose, onDone }) => {
  const [lines, setLines] = useState<Line[]>([]);
  const [sim, setSim] = useState<BotSimResult | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const take = useCallback((r: BotSimResult) => {
    setSim(r);
    setLines((l) => [
      ...l,
      ...r.out.map((o) => ({ from: 'bot' as const, o })),
      ...r.effects.map((e) => ({ from: 'note' as const, text: e.type === 'visit' ? `Would schedule a site visit: ${e.label}` : `Would save ${e.field}: ${e.value}` })),
      ...(r.status !== 'active' ? [{ from: 'note' as const, text: r.status === 'handoff' ? `Bot stops and alerts the team: ${r.reason}` : r.status === 'stopped' ? 'Bot stops. The customer asked it to.' : 'End of the bot. It is ready to start.' }] : []),
    ]);
    if (r.status !== 'active') onDone();
  }, [onDone]);
  const begin = useCallback(async () => {
    setBusy(true);
    try {
      take(await api.bots.simulate({ id: bot.id, rev: bot.rev }));
    } catch (e) {
      setProblem(errText('bots.simulate', e));
    } finally {
      setBusy(false);
    }
  }, [bot.id, bot.rev, take]);
  useEffect(() => { void begin(); }, [begin]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [lines]);
  const say = async (words: string, replyId = '') => {
    if (!sim) return;
    setBusy(true);
    setText('');
    setLines((l) => [...l, { from: 'you', text: words }]);
    try {
      take(await api.bots.simulate({ id: bot.id, rev: bot.rev, state: sim.state, text: words, replyId }));
    } catch (e) {
      setProblem(errText('bots.simulate', e));
    } finally {
      setBusy(false);
    }
  };
  const open = sim?.status === 'active';
  return (
    <Modal open onClose={onClose} title={`Test chat: ${bot.name}`} subtitle="Nothing is sent to anyone, and no lead changes.">
      <div className="flex max-h-[55vh] min-h-[260px] flex-col gap-1.5 overflow-y-auto rounded-lg bg-[#EFEAE2] p-3">
        {lines.map((l, i) => l.from === 'note' ? <p key={i} className="self-center rounded bg-white/80 px-2 py-0.5 text-center text-[11px] text-[#54656F]">{l.text}</p> : l.from === 'you' ? (
          <div key={i} className="max-w-[80%] self-end whitespace-pre-wrap break-words rounded-lg bg-[#D9FDD3] px-2.5 py-1.5 text-[13px] text-[#111B21]">{l.text}</div>
        ) : (
          <div key={i} className="max-w-[85%] self-start rounded-lg bg-white px-2.5 py-1.5 text-[13px] text-[#111B21]">
            <p className="whitespace-pre-wrap break-words">{l.o!.text}</p>
            {l.o!.kind !== 'text' && i >= lines.map((x) => x.from).lastIndexOf('bot') && (
              <div className="mt-1.5 flex flex-col gap-1">{l.o!.options.map((o) => <button key={o.id} type="button" disabled={busy || !open} className="rounded border border-[#D1D7DB] px-2 py-1 text-center text-[12.5px] font-medium text-[#008069] hover:bg-[#F5F6F6] disabled:opacity-50" onClick={() => void say(o.label, o.id)}>{o.label}</button>)}</div>
            )}
          </div>
        ))}
        <div ref={end} />
      </div>
      {problem && <InlineNotice tone="warning" className="mt-2">{problem}</InlineNotice>}
      <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void say(text.trim()); }}>
        <input className={inputCls} value={text} disabled={!open || busy} onChange={(e) => setText(e.target.value)} placeholder={open ? 'Type as the customer' : 'This chat has ended'} aria-label="Type as the customer" />
        <Button variant="primary" icon={<Send size={13} />} aria-label="Send" disabled={!open || busy || !text.trim()} onClick={() => { if (text.trim()) void say(text.trim()); }} />
      </form>
      {sim && !open && <Button variant="secondary" size="sm" className="mt-2" onClick={() => { setLines([]); setSim(null); void begin(); }}>Try again from the start</Button>}
    </Modal>
  );
};

const Stat: React.FC<{ label: string; value: number; icon: React.ElementType; tint: string }> = ({ label, value, icon: Icon, tint }) => (
  <div className="rounded-xl border border-[#EDF2F7] bg-[#F8FBFD] px-3 py-2.5">
    <div className="text-xl font-bold tabular-nums text-[#0B2A44]">{value.toLocaleString('en-IN')}</div>
    <div className="mt-0.5 flex items-center gap-1 text-[10.5px] leading-tight text-[#5E778C]"><Icon size={11} style={{ color: tint }} />{label}</div>
  </div>
);

const two = (n: number) => String(n).padStart(2, '0');
/** DD-MM-YYYY HH:mm, matching the bot-card dates. */
const fmtDT = (iso: string) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${two(d.getDate())}-${two(d.getMonth() + 1)}-${d.getFullYear()} ${two(d.getHours())}:${two(d.getMinutes())}`;
};
/** One icon per card: WhatsApp when it is one of the channels, else the first channel. */
const cardChannel = (b: BotView): BotChannel => (b.channels.includes('whatsapp') ? 'whatsapp' : b.channels[0] || 'whatsapp');
const PAGE_SIZE = 8;

const Info: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="min-w-0">
    <dt className="text-[11px] font-medium text-[#8296A6]">{label}</dt>
    <dd className="mt-0.5 truncate text-[13px] font-medium text-[#0B2A44]" title={value}>{value}</dd>
  </div>
);

const OH_DAYS: Array<{ id: number; label: string }> = [{ id: 1, label: 'Mon' }, { id: 2, label: 'Tue' }, { id: 3, label: 'Wed' }, { id: 4, label: 'Thu' }, { id: 5, label: 'Fri' }, { id: 6, label: 'Sat' }, { id: 0, label: 'Sun' }];
const OH_HOURS = Array.from({ length: 24 }, (_, h) => h);
const ohLabel = (h: number) => (h === 24 ? '12 AM' : `${(h % 12) || 12} ${h < 12 ? 'AM' : 'PM'}`);

/** Website chat office hours: when closed, the widget shows "Away" and greets with the away message. */
const OfficeHoursModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [oh, setOh] = useState<OfficeHours | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => { api.botChats.officeHours().then(setOh).catch((e) => toast('Could not load', errText('bots.officeHours', e), 'alert')); }, []);
  const set = (patch: Partial<OfficeHours>) => setOh((o) => (o ? { ...o, ...patch } : o));
  const toggleDay = (d: number) => setOh((o) => (o ? { ...o, days: o.days.includes(d) ? o.days.filter((x) => x !== d) : [...o.days, d].sort((a, b) => a - b) } : o));
  const save = async () => {
    if (!oh) return;
    if (oh.enabled && (!oh.days.length || oh.to <= oh.from)) { toast('Check office hours', 'Pick at least one day and a closing time after the opening time.', 'alert'); return; }
    setSaving(true);
    try { setOh(await api.botChats.saveOfficeHours(oh)); toast('Office hours saved', oh.enabled ? 'The website chat shows “Away” outside these hours.' : 'Office hours are off — the chat always shows “Online”.', 'success'); onClose(); }
    catch (e) { toast('Not saved', errText('bots.saveOfficeHours', e), 'alert'); }
    finally { setSaving(false); }
  };
  return (
    <Modal open onClose={onClose} title="Website chat office hours" subtitle="When you're closed, the website chat shows “Away” and greets visitors with your away message. WhatsApp and other channels are not affected." footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={saving} disabled={!oh} onClick={() => void save()}>Save</Button></>}>
      {!oh ? <LoadingState label="Loading…" /> : (
        <div className="space-y-4">
          <label className="flex items-center gap-2.5 text-sm font-semibold text-[#0B2A44]">
            <input type="checkbox" checked={oh.enabled} onChange={(e) => set({ enabled: e.target.checked })} className="h-4 w-4 rounded border-[#C4D6E6] text-[#0B6BB0]" />
            Turn on office hours
          </label>
          <div className={cx('space-y-4', !oh.enabled && 'pointer-events-none opacity-50')}>
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-[#8296A6]">Open on</p>
              <div className="flex flex-wrap gap-1.5">
                {OH_DAYS.map((d) => <button key={d.id} type="button" onClick={() => toggleDay(d.id)} className={cx('rounded-lg border px-3 py-1.5 text-[13px] font-semibold', oh.days.includes(d.id) ? 'border-[#0B6BB0] bg-[#E8F2FB] text-[#0B2A44]' : 'border-[#D3E3F0] bg-white text-[#5E778C]')}>{d.label}</button>)}
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs font-semibold text-[#5E778C]">Open from<Select className="mt-1 w-[110px]" value={String(oh.from)} onChange={(e) => set({ from: Number(e.target.value) })} options={OH_HOURS.map((h) => ({ value: String(h), label: ohLabel(h) }))} /></label>
              <label className="text-xs font-semibold text-[#5E778C]">Until<Select className="mt-1 w-[110px]" value={String(oh.to)} onChange={(e) => set({ to: Number(e.target.value) })} options={OH_HOURS.concat([24]).filter((h) => h > 0).map((h) => ({ value: String(h), label: ohLabel(h) }))} /></label>
              <span className="pb-2 text-[11px] text-[#8296A6]">India time (IST)</span>
            </div>
            <label className="block text-xs font-semibold text-[#5E778C]">Away message
              <textarea className={cx(inputCls, 'mt-1 w-full resize-y')} rows={3} maxLength={300} value={oh.away} onChange={(e) => set({ away: e.target.value })} placeholder="Thanks for your message! We're away right now — leave your name and number and we'll get back during office hours." />
            </label>
          </div>
        </div>
      )}
    </Modal>
  );
};

export const ChatbotsView: React.FC = () => {
  const [data, setData] = useState<BotsOverview | null>(null);
  const [failed, setFailed] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [testing, setTesting] = useState<BotView | null>(null);
  const [removing, setRemoving] = useState<BotView | null>(null);
  const [json, setJson] = useState<{ mode: 'import' | 'export'; text: string } | null>(null);
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const [page, setPage] = useState(0);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [officeHoursOpen, setOfficeHoursOpen] = useState(false);
  const copyId = (id: string) => { navigator.clipboard?.writeText(id).then(() => toast('Copied', 'Bot ID copied', 'success')).catch(() => undefined); };
  const doImport = () => {
    try {
      setEditing(normalizeImport(JSON.parse(json?.text || '')));
      setJson(null);
    } catch {
      toast('Could not read that', 'Please paste a valid bot flow JSON.', 'alert');
    }
  };
  const load = useCallback(async () => {
    try {
      setData(await api.bots.list());
      setFailed('');
    } catch (e) {
      setFailed(errText('bots.list', e));
    }
  }, []);
  useEffect(() => void load(), [load]);
  const status = async (b: BotView, next: 'active' | 'paused') => {
    setBusy(b.id);
    try {
      await api.bots.setStatus(b.id, next);
      toast(next === 'active' ? 'Bot started' : 'Bot paused', b.name, 'success');
      await load();
    } catch (e) {
      toast('Not changed', errText('bots.status', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  const remove = async () => {
    if (!removing) return;
    setBusy('remove');
    try {
      await api.bots.remove(removing.id);
      setRemoving(null);
      await load();
    } catch (e) {
      toast('Not deleted', errText('bots.remove', e), 'alert');
    } finally {
      setBusy('');
    }
  };
  if (!data) return failed ? <InlineNotice tone="warning">{failed}</InlineNotice> : <LoadingState label="Loading chatbots…" />;

  const q = query.trim().toLowerCase();
  const filtered = data.bots.filter((b) => {
    const okq = !q || b.name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q);
    const okf = filter === 'all' || (filter === 'active' ? b.status === 'active' : b.status !== 'active');
    return okq && okf;
  });
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const curPage = Math.min(page, pages - 1);
  const slice = filtered.slice(curPage * PAGE_SIZE, curPage * PAGE_SIZE + PAGE_SIZE);
  const from = filtered.length ? curPage * PAGE_SIZE + 1 : 0;
  const to = curPage * PAGE_SIZE + slice.length;
  const detail = detailId ? data.bots.find((b) => b.id === detailId) || null : null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#0B2A44] sm:text-2xl">Create and manage bots</h2>
          <p className="mt-0.5 text-xs text-[#5E778C]">One bot that answers on WhatsApp, your website, Instagram and Facebook — pick its channels when you build it. It collects details, books visits, and steps aside the moment a person replies.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="relative">
            <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[#8296A6]" />
            <input className={cx(inputCls, 'w-[210px] pl-8')} value={query} onChange={(e) => { setQuery(e.target.value); setPage(0); }} placeholder="Search bots" aria-label="Search bots" />
          </label>
          <Select value={filter} onChange={(e) => { setFilter(e.target.value as typeof filter); setPage(0); }} aria-label="Filter by status" className="w-[120px]"
            options={[{ value: 'all', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'inactive', label: 'Inactive' }]} />
          <Button variant="secondary" icon={<Clock size={14} />} onClick={() => setOfficeHoursOpen(true)}>Office hours</Button>
          <Button variant="secondary" icon={<Upload size={14} />} onClick={() => setJson({ mode: 'import', text: '' })}>Import JSON</Button>
          <Button variant="primary" icon={<Plus size={14} />} onClick={() => setChoosing(true)}>New bot</Button>
        </div>
      </div>
      {!data.connected && <InlineNotice tone="warning">Connect a WhatsApp number in Settings › WhatsApp direct to start a bot. You can still build and test one now.</InlineNotice>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {curPage === 0 && !q && filter === 'all' && (
          <button type="button" onClick={() => setChoosing(true)} className="group flex min-h-[214px] flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-[#BBD3E6] bg-[#F3F8FC] text-[#0B6BB0] transition hover:border-[#0B6BB0] hover:bg-[#EAF3FB]">
            <span className="flex h-14 w-14 items-center justify-center rounded-full bg-[#0B6BB0] text-white shadow-sm transition group-hover:scale-105"><Plus size={26} /></span>
            <span className="text-base font-semibold">Create a New Bot</span>
          </button>
        )}
        {slice.map((b) => {
          const C = CHANNEL_ICON[cardChannel(b)];
          const active = b.status === 'active';
          return (
            <div key={b.id} className="flex flex-col overflow-hidden rounded-2xl border border-[#E2ECF3] bg-white shadow-[0_1px_3px_rgba(16,40,64,0.06)]">
              <div className="flex-1 p-4">
                <div className="flex items-start gap-3">
                  <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full text-white shadow-sm" style={{ background: C.tint }} title={BOT_CHANNEL_LABEL[cardChannel(b)]}><C.icon size={18} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="truncate text-[15px] font-bold text-[#0B2A44]" title={b.name}>{b.name}</h3>
                      <button type="button" aria-label={`Edit ${b.name}`} title="Edit" onClick={() => setEditing(toDraft(b))} className="flex-none rounded-lg p-1 text-[#5E778C] hover:bg-[#EEF3F7] hover:text-[#0B6BB0]"><Pencil size={15} /></button>
                    </div>
                    <div className="mt-0.5 flex items-center gap-1 text-[11px] text-[#8296A6]">
                      <span className="truncate" title={b.id}>ID: {b.id}</span>
                      <button type="button" aria-label="Copy bot ID" title="Copy ID" onClick={() => copyId(b.id)} className="flex-none rounded p-0.5 hover:bg-[#EEF3F7] hover:text-[#0B6BB0]"><Copy size={12} /></button>
                    </div>
                  </div>
                </div>
                <dl className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3">
                  <Info label="Created On" value={fmtDT(b.createdAt)} />
                  <Info label="Chat Count" value={`${b.stats.started.toLocaleString('en-IN')} Visitor${b.stats.started === 1 ? '' : 's'}`} />
                  <Info label="Updated On" value={fmtDT(b.updatedAt)} />
                  <div>
                    <dt className="text-[11px] font-medium text-[#8296A6]">Status</dt>
                    <dd className="mt-0.5"><span className={cx('inline-flex items-center gap-1.5 text-[13px] font-semibold', active ? 'text-[#067647]' : 'text-[#C0392B]')}><span className="h-1.5 w-1.5 rounded-full" style={{ background: active ? '#16A34A' : '#D64545' }} />{active ? 'Active' : 'Inactive'}</span></dd>
                  </div>
                </dl>
              </div>
              <button type="button" onClick={() => setDetailId(b.id)} className="border-t border-[#EEF3F7] py-2.5 text-center text-[13px] font-semibold text-[#0B6BB0] transition hover:bg-[#F5FAFE]">View Details</button>
            </div>
          );
        })}
        {!filtered.length && (q || filter !== 'all') && (
          <div className="col-span-full rounded-2xl border border-dashed border-[#D7E3EC] bg-white p-10 text-center text-sm text-[#5E778C]">No bots match your search or filter.</div>
        )}
      </div>

      {filtered.length > PAGE_SIZE && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-sm text-[#5E778C]">
          <span>Showing {from}-{to} of {filtered.length}</span>
          <div className="flex items-center gap-1.5">
            <button type="button" disabled={curPage === 0} onClick={() => setPage(curPage - 1)} className="rounded-lg border border-[#D3E3F0] px-3 py-1.5 font-semibold text-[#0B6BB0] disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[#F2F7FB]">Prev</button>
            <span className="rounded-lg bg-[#0B6BB0] px-3 py-1.5 font-semibold text-white">{curPage + 1}</span>
            <button type="button" disabled={curPage >= pages - 1} onClick={() => setPage(curPage + 1)} className="rounded-lg border border-[#D3E3F0] px-3 py-1.5 font-semibold text-[#0B6BB0] disabled:cursor-not-allowed disabled:opacity-40 hover:bg-[#F2F7FB]">Next</button>
          </div>
        </div>
      )}

      {detail && (() => {
        const canStart = detail.tested && !detail.problems.length && !(detail.channels.includes('whatsapp') && !data.connected);
        return (
          <Modal open onClose={() => setDetailId(null)} width="lg" title={detail.name}
            subtitle={`${detail.steps.length} step${detail.steps.length === 1 ? '' : 's'} · ${TRIGGER[detail.trigger]}${detail.trigger === 'keyword' ? `: ${detail.keywords.join(', ')}` : ''}`}>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {detail.channels.map((ch) => { const C = CHANNEL_ICON[ch]; return <span key={ch} title={BOT_CHANNEL_LABEL[ch]} className="inline-flex items-center gap-1.5 rounded-full bg-[#F2F7FB] px-2.5 py-1 text-[11px] font-semibold text-[#3E5A70]"><span className="flex h-4 w-4 items-center justify-center rounded-full text-white" style={{ background: C.tint }}><C.icon size={10} /></span>{BOT_CHANNEL_LABEL[ch]}</span>; })}
              <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold" style={{ background: STATUS_PILL[detail.status].bg, color: STATUS_PILL[detail.status].fg }}><span className="h-1.5 w-1.5 rounded-full" style={{ background: STATUS_PILL[detail.status].dot }} />{STATUS_PILL[detail.status].label}</span>
            </div>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Stat label="Chats started" value={detail.stats.started} icon={MessageSquare} tint="#0B6BB0" />
              <Stat label="In progress" value={detail.stats.inProgress} icon={Clock} tint="#9A5B00" />
              <Stat label="Finished" value={detail.stats.finished} icon={CheckCircle2} tint="#067647" />
              <Stat label="Handed to team" value={detail.stats.handedOff} icon={UserRound} tint="#8A3E28" />
              <Stat label="Answered" value={detail.stats.withAnswers} icon={HelpCircle} tint="#5B3FA8" />
              <Stat label="Visits booked" value={detail.stats.visits} icon={CalendarCheck} tint="#C1398B" />
            </dl>
            {detail.stats.waitingAt.length > 0 && <p className="mt-3 text-[11px] text-[#5E778C]">Waiting most at: step {detail.stats.waitingAt[0].step} ({detail.stats.waitingAt[0].n}){detail.stats.waitingAt[0].text ? `, “${detail.stats.waitingAt[0].text}”` : ''}</p>}
            {detail.problems.length > 0 && <InlineNotice tone="warning" className="mt-3">{detail.problems[0]}{detail.problems.length > 1 ? ` And ${detail.problems.length - 1} more.` : ''}</InlineNotice>}
            {detail.status !== 'active' && !detail.problems.length && !detail.tested && <p className="mt-3 text-[11px] text-[#8A5A00]">Try it in the test chat, right to its end, before starting it.</p>}
            <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[#EEF3F7] pt-3">
              {detail.status === 'active'
                ? <Button variant="secondary" size="sm" icon={<Pause size={13} />} loading={busy === detail.id} onClick={() => void status(detail, 'paused')}>Pause</Button>
                : <Button variant="primary" size="sm" icon={<Play size={13} />} loading={busy === detail.id} disabled={!canStart} onClick={() => void status(detail, 'active')}>Start</Button>}
              <Button variant="secondary" size="sm" icon={<Send size={13} />} disabled={detail.problems.length > 0} onClick={() => { const b = detail; setDetailId(null); setTesting(b); }}>Test chat</Button>
              {detail.status !== 'active' && <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => { const b = detail; setDetailId(null); setEditing(toDraft(b)); }}>Edit</Button>}
              <Button variant="secondary" size="sm" icon={<Copy size={13} />} onClick={() => setJson({ mode: 'export', text: exportText(detail) })}>Export JSON</Button>
              {detail.status !== 'active' && <Button variant="secondary" size="sm" icon={<Trash2 size={13} />} aria-label={`Delete ${detail.name}`} className="ml-auto" onClick={() => { const b = detail; setDetailId(null); setRemoving(b); }} />}
            </div>
          </Modal>
        );
      })()}

      <Modal open={choosing} onClose={() => setChoosing(false)} width="md" title="Start a new chatbot" subtitle="Pick a template to begin — you can change everything after.">
        <div className="grid gap-2.5 sm:grid-cols-2">
          {TEMPLATES.map((t) => (
            <button key={t.id} type="button" onClick={() => { setChoosing(false); setEditing(draftFromTemplate(t)); }} className="flex flex-col items-start gap-1.5 rounded-xl border border-[#E2ECF3] bg-white p-4 text-left transition hover:border-[#0B6BB0] hover:bg-[#F5FAFE]">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-[#EAF2FC] text-[#0B6BB0]">{t.id === 'reviews' ? <Star size={18} /> : t.id === 'blank' ? <Plus size={18} /> : <Bot size={18} />}</span>
              <b className="text-[14px] font-bold text-[#0B2A44]">{t.name}</b>
              <span className="text-xs text-[#5E778C]">{t.desc}</span>
            </button>
          ))}
        </div>
      </Modal>

      {editing && <Suspense fallback={<LoadingState label="Opening the map" />}><BotFlowEditor draft={editing} aiAvailable={data.aiAvailable} onClose={() => setEditing(null)} onSaved={(_, problems) => { setEditing(null); if (problems.length) toast('Saved, with something to fix', problems[0], 'alert'); void load(); }} /></Suspense>}
      {testing && <TestChat bot={testing} onClose={() => { setTesting(null); void load(); }} onDone={() => undefined} />}
      <Modal open={!!json} onClose={() => setJson(null)} width="md"
        title={json?.mode === 'export' ? 'Bot flow JSON' : 'Import a bot flow'}
        subtitle={json?.mode === 'export' ? 'Copy this and paste it into another company’s Chatbots screen, or keep it as a backup.' : 'Paste a bot flow JSON. It opens in the editor so you can review, pick channels and save.'}
        footer={json?.mode === 'import'
          ? <><Button variant="secondary" onClick={() => setJson(null)}>Cancel</Button><Button variant="primary" onClick={doImport}>Open in editor</Button></>
          : <><Button variant="secondary" icon={<Copy size={13} />} onClick={() => { navigator.clipboard?.writeText(json?.text || '').then(() => toast('Copied', 'JSON copied to clipboard', 'success')).catch(() => undefined); }}>Copy</Button><Button variant="primary" onClick={() => setJson(null)}>Done</Button></>}>
        <textarea className={`${inputCls} font-mono text-[12px]`} rows={14} readOnly={json?.mode === 'export'} value={json?.text || ''} onChange={(e) => setJson((j) => (j ? { ...j, text: e.target.value } : j))} onFocus={(e) => { if (json?.mode === 'export') e.currentTarget.select(); }} placeholder={'{\n  "name": "My bot",\n  "trigger": "new",\n  "channels": ["website"],\n  "knowledge": "",\n  "steps": [ ... ]\n}'} />
      </Modal>
      <ConfirmDialog open={!!removing} danger title="Delete this chatbot?" message={`“${removing?.name}” will be deleted. Chats it already had stay in WhatsApp.`} confirmLabel="Delete" loading={busy === 'remove'} onConfirm={() => void remove()} onCancel={() => setRemoving(null)} />
      {officeHoursOpen && <OfficeHoursModal onClose={() => setOfficeHoursOpen(false)} />}
    </div>
  );
};
