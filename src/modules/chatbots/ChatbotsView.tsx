/** WhatsApp chatbots (plan feature whatsappBots; server: modules/whatsappBots.ts): build from blocks, try it in a test chat, start it, see how it does. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Bot, Pause, Pencil, Play, Plus, Send, Trash2, X } from 'lucide-react';
import { api, type BotOutgoing, type BotSimResult, type BotStepView, type BotView, type BotsOverview } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, ConfirmDialog, EmptyState, Field, InlineNotice, LoadingState, Modal, Select, cx, inputCls } from '../../components/ui';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
const TYPES: Array<{ id: BotStepView['type']; label: string; hint: string }> = [
  { id: 'message', label: 'Send a message', hint: 'Sends this, then carries on.' },
  { id: 'question', label: 'Ask a question', hint: 'Waits for a typed answer, and can save it on the lead.' },
  { id: 'choice', label: 'Offer choices', hint: 'Up to 3 become buttons, up to 10 a list. Each can lead somewhere different.' },
  { id: 'visit', label: 'Book a site visit', hint: 'Offers days, then times, and schedules the visit on the lead.' },
  { id: 'ai', label: 'AI answers questions', hint: 'Answers only from what you write below. Anything else goes to your team.' },
  { id: 'handoff', label: 'Hand to the team', hint: 'Says this, stops the bot and alerts the RM.' },
  { id: 'end', label: 'End the chat', hint: 'Says this, if anything, and stops.' },
];
const SAVE_OPTIONS = [{ value: '', label: 'Do not save' }, { value: 'name', label: 'Name' }, { value: 'email', label: 'E-mail' }, { value: 'unit', label: 'Unit interested in' }, { value: 'city', label: 'City' }, { value: 'budget', label: 'Budget' }, { value: 'purpose', label: 'Purpose' }, { value: 'notes', label: 'Add as a remark' }];
const STATUS: Record<BotView['status'], { label: string; tone: 'sage' | 'amber' | 'muted' }> = { active: { label: 'Running', tone: 'sage' }, paused: { label: 'Paused', tone: 'amber' }, draft: { label: 'Draft', tone: 'muted' } };
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

type Draft = { id?: string; name: string; trigger: BotView['trigger']; keywords: string; steps: BotStepView[]; knowledge: string };
const toDraft = (b: BotView): Draft => ({ id: b.id, name: b.name, trigger: b.trigger, keywords: b.keywords.join(', '), steps: b.steps, knowledge: b.knowledge });
const newDraft = (): Draft => ({ name: 'Property enquiry', trigger: 'new', keywords: '', steps: starterSteps(), knowledge: '' });

const StepEditor: React.FC<{ step: BotStepView; index: number; all: BotStepView[]; aiAvailable: boolean; onChange: (s: BotStepView) => void; onMove: (d: -1 | 1) => void; onRemove: () => void }> = ({ step, index, all, aiAvailable, onChange, onMove, onRemove }) => {
  const set = <K extends keyof BotStepView>(k: K, v: BotStepView[K]) => onChange({ ...step, [k]: v });
  const goTo = [{ value: '', label: 'The next step' }, ...all.filter((s) => s.id !== step.id).map((s) => ({ value: s.id, label: `Step ${all.indexOf(s) + 1}: ${(s.text || TYPES.find((t) => t.id === s.type)!.label).slice(0, 34)}` }))];
  const info = TYPES.find((t) => t.id === step.type)!;
  const setOption = (i: number, patch: Partial<BotStepView['options'][number]>) => set('options', step.options.map((o, j) => (j === i ? { ...o, ...patch } : o)));
  return (
    <section className="rounded-xl border border-[#D3E3F0] bg-white p-3" aria-label={`Step ${index + 1}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-[#E3EEF7] text-[11px] font-bold text-[#0B5E9C]">{index + 1}</span>
        <div className="min-w-[180px] flex-1"><Select value={step.type} aria-label="Kind of step" onChange={(e) => onChange({ ...blank(e.target.value as BotStepView['type']), id: step.id, text: step.text })} options={TYPES.filter((t) => t.id !== 'ai' || aiAvailable || step.type === 'ai').map((t) => ({ value: t.id, label: t.label }))} /></div>
        <span className="flex gap-1">
          <Button variant="secondary" size="xs" icon={<ArrowUp size={12} />} aria-label="Move up" disabled={index === 0} onClick={() => onMove(-1)} />
          <Button variant="secondary" size="xs" icon={<ArrowDown size={12} />} aria-label="Move down" disabled={index === all.length - 1} onClick={() => onMove(1)} />
          <Button variant="secondary" size="xs" icon={<X size={12} />} aria-label="Remove step" onClick={onRemove} />
        </span>
      </div>
      <p className="mt-1 text-[11px] text-[#5E778C]">{info.hint}</p>
      <textarea className={cx(inputCls, 'mt-2')} rows={2} maxLength={1024} value={step.text} onChange={(e) => set('text', e.target.value)} aria-label="Message" placeholder={step.type === 'end' || step.type === 'visit' || step.type === 'handoff' ? 'Message (optional)' : 'Message'} />
      {step.type === 'question' && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Field label="Save the answer as"><Select value={step.saveTo} onChange={(e) => set('saveTo', e.target.value as BotStepView['saveTo'])} options={SAVE_OPTIONS} /></Field>
          <Field label="Answer must be"><Select value={step.validate} onChange={(e) => set('validate', e.target.value as BotStepView['validate'])} options={[{ value: 'text', label: 'Any text' }, { value: 'email', label: 'An e-mail address' }, { value: 'number', label: 'A number' }]} /></Field>
        </div>
      )}
      {step.type === 'choice' && (
        <div className="mt-2 space-y-1.5">
          <Field label="Save the choice as"><Select value={step.saveTo} onChange={(e) => set('saveTo', e.target.value as BotStepView['saveTo'])} options={SAVE_OPTIONS} /></Field>
          {step.options.map((o, i) => (
            <div key={o.id} className="flex flex-wrap items-center gap-1.5">
              <input className={cx(inputCls, 'min-w-[120px] !w-auto flex-1')} maxLength={24} value={o.label} onChange={(e) => setOption(i, { label: e.target.value })} placeholder={`Option ${i + 1}`} aria-label={`Option ${i + 1}`} />
              <div className="min-w-[150px] flex-1"><Select value={o.next} aria-label={`Option ${i + 1} goes to`} onChange={(e) => setOption(i, { next: e.target.value })} options={goTo} /></div>
              <Button variant="secondary" size="xs" icon={<X size={12} />} aria-label={`Remove option ${i + 1}`} onClick={() => set('options', step.options.filter((_, j) => j !== i))} />
            </div>
          ))}
          {step.options.length < 10 && <Button variant="secondary" size="xs" icon={<Plus size={12} />} onClick={() => set('options', [...step.options, { id: newId('o'), label: '', next: '' }])}>Add option</Button>}
          <p className="text-[11px] text-[#5E778C]">{step.options.length > 3 ? 'WhatsApp will show these as a list, up to 24 characters each.' : 'WhatsApp will show these as buttons. Over 20 characters becomes a list.'}</p>
        </div>
      )}
      {step.type === 'visit' && (
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          <Field label="Days to offer, from tomorrow"><input className={inputCls} type="number" min={1} max={10} value={step.days} onChange={(e) => set('days', Number(e.target.value))} /></Field>
          <Field label="Times" hint="Separate with commas, like 11:00, 15:30"><input className={inputCls} value={step.times.join(', ')} onChange={(e) => set('times', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></Field>
        </div>
      )}
      {step.type !== 'choice' && step.type !== 'handoff' && step.type !== 'end' && <div className="mt-2"><Field label="Then go to"><Select value={step.next} onChange={(e) => set('next', e.target.value)} options={goTo} /></Field></div>}
    </section>
  );
};

const BotEditor: React.FC<{ draft: Draft; aiAvailable: boolean; onClose: () => void; onSaved: (id: string, problems: string[]) => void }> = ({ draft, aiAvailable, onClose, onSaved }) => {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const steps = d.steps;
  const setSteps = (s: BotStepView[]) => setD((x) => ({ ...x, steps: s }));
  const save = async () => {
    setBusy(true);
    setProblem('');
    try {
      const r = await api.bots.save({ ...d, keywords: d.keywords });
      onSaved(r.id, r.problems);
    } catch (e) {
      setProblem(errText('bots.save', e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} width="lg" title={d.id ? `Edit ${draft.name}` : 'New chatbot'}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button></>}>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className={inputCls} maxLength={80} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
          <Field label="Starts when"><Select value={d.trigger} onChange={(e) => setD({ ...d, trigger: e.target.value as Draft['trigger'] })} options={(Object.keys(TRIGGER) as Array<BotView['trigger']>).map((k) => ({ value: k, label: TRIGGER[k] }))} /></Field>
        </div>
        {d.trigger === 'keyword' && <Field label="Keywords" hint="Separate with commas, like price, brochure"><input className={inputCls} value={d.keywords} onChange={(e) => setD({ ...d, keywords: e.target.value })} /></Field>}
        <p className="text-[11px] text-[#5E778C]">You can use {'{name}'}, {'{first_name}'}, {'{company}'}, {'{unit}'}, {'{visit}'} in messages. Anyone who says STOP, or asks for a person, leaves the bot at any point.</p>
        <div className="space-y-2">
          {steps.map((s, i) => (
            <StepEditor key={s.id} step={s} index={i} all={steps} aiAvailable={aiAvailable}
              onChange={(n) => setSteps(steps.map((x) => (x.id === s.id ? n : x)))}
              onMove={(dir) => { const c = [...steps]; c.splice(i, 1); c.splice(i + dir, 0, s); setSteps(c); }}
              onRemove={() => setSteps(steps.filter((x) => x.id !== s.id))} />
          ))}
          <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => setSteps([...steps, blank()])}>Add step</Button>
        </div>
        {(steps.some((s) => s.type === 'ai') || d.knowledge) && (
          <Field label="What the AI may use" hint="Projects, prices, locations, amenities, timings. It answers only from this, in up to 6 replies a chat. Keep it current: a wrong price here goes to customers.">
            <textarea className={inputCls} rows={6} maxLength={20000} value={d.knowledge} onChange={(e) => setD({ ...d, knowledge: e.target.value })} />
          </Field>
        )}
        {problem && <InlineNotice tone="warning">{problem}</InlineNotice>}
      </div>
    </Modal>
  );
};

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

const Stat: React.FC<{ label: string; value: number }> = ({ label, value }) => <div><dt className="text-[10.5px] text-[#5E778C]">{label}</dt><dd className="text-sm font-bold tabular-nums text-[#0B2A44]">{value.toLocaleString('en-IN')}</dd></div>;

export const ChatbotsView: React.FC = () => {
  const [data, setData] = useState<BotsOverview | null>(null);
  const [failed, setFailed] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [testing, setTesting] = useState<BotView | null>(null);
  const [removing, setRemoving] = useState<BotView | null>(null);
  const [busy, setBusy] = useState('');
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
  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-[#0B2A44] sm:text-2xl">WhatsApp Chatbots</h2>
          <p className="mt-0.5 text-xs text-[#5E778C]">Answers customers who write in, collects their details and books visits. It steps aside as soon as a person replies.</p>
        </div>
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing(newDraft())}>New chatbot</Button>
      </div>
      {!data.connected && <InlineNotice tone="warning">Connect a WhatsApp number in Settings › WhatsApp direct to start a bot. You can still build and test one now.</InlineNotice>}
      {!data.bots.length ? <EmptyState icon={<Bot size={22} />} title="No chatbots yet" description="Start from a ready property enquiry bot, and change it to suit you." action={<Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing(newDraft())}>New chatbot</Button>} /> : data.bots.map((b) => {
        const s = STATUS[b.status];
        return (
          <Card key={b.id} title={<span className="inline-flex flex-wrap items-center gap-2">{b.name}<Badge tone={s.tone}>{s.label}</Badge></span>} subtitle={`${b.steps.length} step${b.steps.length === 1 ? '' : 's'} · ${TRIGGER[b.trigger]}${b.trigger === 'keyword' ? `: ${b.keywords.join(', ')}` : ''}`}>
            <dl className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              <Stat label="Chats started" value={b.stats.started} /><Stat label="In progress" value={b.stats.inProgress} /><Stat label="Finished" value={b.stats.finished} /><Stat label="Handed to team" value={b.stats.handedOff} /><Stat label="Answered a question" value={b.stats.withAnswers} /><Stat label="Visits booked" value={b.stats.visits} />
            </dl>
            {b.stats.waitingAt.length > 0 && <p className="mt-2 text-[11px] text-[#5E778C]">Waiting most at: step {b.stats.waitingAt[0].step} ({b.stats.waitingAt[0].n}){b.stats.waitingAt[0].text ? `, “${b.stats.waitingAt[0].text}”` : ''}</p>}
            {b.problems.length > 0 && <InlineNotice tone="warning" className="mt-2">{b.problems[0]}{b.problems.length > 1 ? ` And ${b.problems.length - 1} more.` : ''}</InlineNotice>}
            {b.status !== 'active' && !b.problems.length && !b.tested && <p className="mt-2 text-[11px] text-[#8A5A00]">Try it in the test chat, right to its end, before starting it.</p>}
            <div className="mt-3 flex flex-wrap gap-2">
              {b.status !== 'active' && <Button variant="secondary" size="xs" icon={<Pencil size={12} />} onClick={() => setEditing(toDraft(b))}>Edit</Button>}
              <Button variant="secondary" size="xs" icon={<Send size={12} />} disabled={b.problems.length > 0} onClick={() => setTesting(b)}>Test chat</Button>
              {b.status === 'active'
                ? <Button variant="secondary" size="xs" icon={<Pause size={12} />} loading={busy === b.id} onClick={() => void status(b, 'paused')}>Pause</Button>
                : <Button variant="primary" size="xs" icon={<Play size={12} />} loading={busy === b.id} disabled={!b.tested || b.problems.length > 0 || !data.connected} onClick={() => void status(b, 'active')}>Start</Button>}
              {b.status !== 'active' && <Button variant="secondary" size="xs" icon={<Trash2 size={12} />} aria-label={`Delete ${b.name}`} onClick={() => setRemoving(b)} />}
            </div>
          </Card>
        );
      })}
      {editing && <BotEditor draft={editing} aiAvailable={data.aiAvailable} onClose={() => setEditing(null)} onSaved={(_, problems) => { setEditing(null); if (problems.length) toast('Saved, with something to fix', problems[0], 'alert'); void load(); }} />}
      {testing && <TestChat bot={testing} onClose={() => { setTesting(null); void load(); }} onDone={() => undefined} />}
      <ConfirmDialog open={!!removing} danger title="Delete this chatbot?" message={`“${removing?.name}” will be deleted. Chats it already had stay in WhatsApp.`} confirmLabel="Delete" loading={busy === 'remove'} onConfirm={() => void remove()} onCancel={() => setRemoving(null)} />
    </div>
  );
};
