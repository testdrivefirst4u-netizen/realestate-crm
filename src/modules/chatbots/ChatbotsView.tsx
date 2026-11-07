/** WhatsApp chatbots (plan feature whatsappBots; server: modules/whatsappBots.ts): build from blocks, try it in a test chat, start it, see how it does. */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, Pause, Pencil, Play, Plus, Send, Trash2 } from 'lucide-react';
import { api, type BotOutgoing, type BotSimResult, type BotStepView, type BotView, type BotsOverview } from '../../core/api';
import { reportError, toAppError } from '../../core/errors';
import { toast } from '../../core/notifications';
import { Badge, Button, Card, ConfirmDialog, EmptyState, InlineNotice, LoadingState, Modal, inputCls } from '../../components/ui';
import { BotFlowEditor, type BotDraft } from './BotFlowEditor';

const errText = (scope: string, e: unknown) => toAppError(reportError(scope, e)).userMessage;
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

type Draft = BotDraft;
const toDraft = (b: BotView): Draft => ({ id: b.id, name: b.name, trigger: b.trigger, keywords: b.keywords.join(', '), steps: b.steps, knowledge: b.knowledge });
const newDraft = (): Draft => ({ name: 'Property enquiry', trigger: 'new', keywords: '', steps: starterSteps(), knowledge: '' });

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
      {editing && <BotFlowEditor draft={editing} aiAvailable={data.aiAvailable} onClose={() => setEditing(null)} onSaved={(_, problems) => { setEditing(null); if (problems.length) toast('Saved, with something to fix', problems[0], 'alert'); void load(); }} />}
      {testing && <TestChat bot={testing} onClose={() => { setTesting(null); void load(); }} onDone={() => undefined} />}
      <ConfirmDialog open={!!removing} danger title="Delete this chatbot?" message={`“${removing?.name}” will be deleted. Chats it already had stay in WhatsApp.`} confirmLabel="Delete" loading={busy === 'remove'} onConfirm={() => void remove()} onCancel={() => setRemoving(null)} />
    </div>
  );
};
