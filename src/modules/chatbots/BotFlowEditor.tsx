/** The chatbot builder as a map: each step a box, choices branching into paths. Click a box to edit it, or + on a line to add a step. */
import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CalendarDays, CheckCircle2, CircleHelp, CornerDownRight, GitBranch, MessageSquare, Minus, Plus, Sparkles, Trash2, UserRound, X } from 'lucide-react';
import { api, type BotStepView } from '../../core/api';
import { END_STEP, botProblems, type BotStep } from '../../core/botEngine';
import { reportError, toAppError } from '../../core/errors';
import { Button, ConfirmDialog, Field, InlineNotice, Select, cx, inputCls } from '../../components/ui';
import { explicitSteps, insertStep, layoutBot, mapOrder, removalCount, removeStep, setExit, type Exit, type MapEdge, type MapNode } from './botTree';

export type BotDraft = { id?: string; name: string; trigger: 'new' | 'keyword' | 'any'; keywords: string; steps: BotStepView[]; knowledge: string };

const KINDS: Record<BotStepView['type'], { label: string; hint: string; icon: React.ElementType; tint: string; ink: string }> = {
  message: { label: 'Send a message', hint: 'Sends this, then carries on.', icon: MessageSquare, tint: '#EAF4FB', ink: '#0B5E9C' },
  question: { label: 'Ask a question', hint: 'Waits for a typed answer, and can save it on the lead.', icon: CircleHelp, tint: '#F1EDFB', ink: '#5B3FA8' },
  choice: { label: 'Offer choices', hint: 'Each option gets its own path. Up to 3 show as buttons, up to 10 as a list.', icon: GitBranch, tint: '#FFF4E5', ink: '#9A5B00' },
  visit: { label: 'Book a site visit', hint: 'Offers days, then times, and schedules the visit on the lead.', icon: CalendarDays, tint: '#E7F6EE', ink: '#067647' },
  ai: { label: 'AI answers questions', hint: 'Answers only from what you write for it. Anything else goes to your team.', icon: Sparkles, tint: '#FCEEF6', ink: '#A0267A' },
  handoff: { label: 'Hand to the team', hint: 'Says this, stops the bot and alerts the RM. The path ends here.', icon: UserRound, tint: '#EEF2F6', ink: '#3E5A70' },
  end: { label: 'End the chat', hint: 'Says this, if anything, and stops. The path ends here.', icon: CheckCircle2, tint: '#EEF2F6', ink: '#3E5A70' },
};
const SAVE_OPTIONS = [{ value: '', label: 'Do not save' }, { value: 'name', label: 'Name' }, { value: 'email', label: 'E-mail' }, { value: 'unit', label: 'Unit interested in' }, { value: 'city', label: 'City' }, { value: 'budget', label: 'Budget' }, { value: 'purpose', label: 'Purpose' }, { value: 'notes', label: 'Add as a remark' }];
const TRIGGERS = [{ value: 'new', label: 'First message from a new customer' }, { value: 'keyword', label: 'A customer sends a keyword' }, { value: 'any', label: 'Any message, if nobody replied in the last day' }];

let counter = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;
const makeStep = (type: BotStepView['type']): BotStepView => ({ id: newId('s'), type, text: '', next: '', saveTo: '', validate: 'text', options: type === 'choice' ? [{ id: newId('o'), label: 'Option 1', next: END_STEP }, { id: newId('o'), label: 'Option 2', next: END_STEP }] : [], days: 7, times: ['11:00', '15:00', '17:00'] });

const AddMenu: React.FC<{ aiAvailable: boolean; onPick: (t: BotStepView['type']) => void; onClose: () => void }> = ({ aiAvailable, onPick, onClose }) => (
  <div role="menu" aria-label="Add a step" className="absolute left-1/2 top-full z-30 mt-1 w-56 -translate-x-1/2 rounded-lg border border-[#D3E3F0] bg-white p-1 shadow-xl">
    {(Object.keys(KINDS) as Array<BotStepView['type']>).filter((t) => t !== 'ai' || aiAvailable).map((t) => {
      const K = KINDS[t];
      return <button key={t} type="button" role="menuitem" onClick={() => onPick(t)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs font-medium text-[#0B2A44] hover:bg-[#F2F7FB]"><span className="flex h-6 w-6 flex-none items-center justify-center rounded" style={{ background: K.tint, color: K.ink }}><K.icon size={13} aria-hidden="true" /></span>{K.label}</button>;
    })}
    <button type="button" role="menuitem" onClick={onClose} className="mt-0.5 w-full rounded px-2 py-1 text-left text-[11px] text-[#5E778C] hover:bg-[#F2F7FB]">Cancel</button>
  </div>
);

const StepBox: React.FC<{ node: MapNode; step: BotStepView; selected: boolean; hasProblem: boolean; onClick: () => void }> = ({ node, step, selected, hasProblem, onClick }) => {
  const K = KINDS[step.type];
  return (
    <button type="button" onClick={onClick} aria-pressed={selected} aria-label={`Step ${node.number}: ${K.label}. ${step.text}`} style={{ left: node.x, top: node.y, width: node.w, height: node.h }}
      className={cx('absolute flex flex-col overflow-hidden rounded-xl border-2 bg-white text-left shadow-sm transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0B6BB0]', selected ? 'border-[#0B6BB0]' : hasProblem ? 'border-[#F2B8B5]' : 'border-[#D3E3F0]')}>
      <span className="flex w-full flex-none items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-semibold" style={{ background: K.tint, color: K.ink }}>
        <K.icon size={13} aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{K.label}</span>
        {hasProblem ? <AlertTriangle size={13} className="flex-none text-[#B42318]" aria-label="Needs fixing" /> : <span className="flex-none tabular-nums opacity-70">{node.number}</span>}
      </span>
      <span className="line-clamp-3 flex-1 break-words px-2.5 py-1.5 text-[12px] leading-snug text-[#0B2A44]">{step.text || <span className="text-[#7E93A6]">{step.type === 'visit' ? 'Which day suits you?' : step.type === 'end' ? 'Stops quietly' : 'No message yet'}</span>}</span>
    </button>
  );
};

const Inspector: React.FC<{ step: BotStepView; number: number; all: BotStepView[]; canRemove: boolean; removeCount: number; aiAvailable: boolean; knowledge: string; onKnowledge: (v: string) => void; onChange: (s: BotStepView) => void; onExit: (e: Exit, target: string) => void; onRemove: () => void; onClose: () => void }> = ({ step, number, all, canRemove, removeCount, aiAvailable, knowledge, onKnowledge, onChange, onExit, onRemove, onClose }) => {
  const set = <K extends keyof BotStepView>(k: K, v: BotStepView[K]) => onChange({ ...step, [k]: v });
  const K = KINDS[step.type];
  const goTo = [{ value: END_STEP, label: 'End the chat' }, ...all.filter((s) => s.id !== step.id).map((s) => ({ value: s.id, label: `Step ${all.indexOf(s) + 1}: ${(s.text || KINDS[s.type].label).slice(0, 34)}` }))];
  const setOption = (i: number, label: string) => set('options', step.options.map((o, j) => (j === i ? { ...o, label } : o)));
  const changeType = (type: BotStepView['type']) => {
    const fresh = makeStep(type);
    const onward = step.type === 'choice' ? step.options[0]?.next || END_STEP : step.next || END_STEP;
    onChange({ ...fresh, id: step.id, text: step.text, next: type === 'handoff' || type === 'end' || type === 'choice' ? '' : onward, options: type === 'choice' ? fresh.options.map((o, i) => ({ ...o, next: i === 0 ? onward : END_STEP })) : [] });
  };
  return (
    <aside className="flex h-full w-full flex-col border-t border-[#D3E3F0] bg-white lg:w-[340px] lg:flex-none lg:border-l lg:border-t-0" aria-label={`Edit step ${number}`}>
      <div className="flex items-center justify-between border-b border-[#E3EDF5] px-4 py-2.5">
        <p className="text-sm font-bold text-[#0B2A44]">Step {number}</p>
        <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-[#5E778C] hover:bg-[#F2F7FB]"><X size={16} /></button>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        <Field label="What it does" hint={K.hint}><Select value={step.type} onChange={(e) => changeType(e.target.value as BotStepView['type'])} options={(Object.keys(KINDS) as Array<BotStepView['type']>).filter((t) => t !== 'ai' || aiAvailable || step.type === 'ai').map((t) => ({ value: t, label: KINDS[t].label }))} /></Field>
        <Field label={step.type === 'end' || step.type === 'visit' || step.type === 'handoff' ? 'Message (optional)' : 'Message'} hint="You can use {name}, {first_name}, {company}, {unit} and {visit}."><textarea className={inputCls} rows={4} maxLength={1024} value={step.text} onChange={(e) => set('text', e.target.value)} /></Field>
        {step.type === 'question' && (
          <>
            <Field label="Save the answer as"><Select value={step.saveTo} onChange={(e) => set('saveTo', e.target.value as BotStepView['saveTo'])} options={SAVE_OPTIONS} /></Field>
            <Field label="Answer must be"><Select value={step.validate} onChange={(e) => set('validate', e.target.value as BotStepView['validate'])} options={[{ value: 'text', label: 'Any text' }, { value: 'email', label: 'An e-mail address' }, { value: 'number', label: 'A number' }]} /></Field>
          </>
        )}
        {step.type === 'choice' && (
          <>
            <Field label="Save the choice as"><Select value={step.saveTo} onChange={(e) => set('saveTo', e.target.value as BotStepView['saveTo'])} options={SAVE_OPTIONS} /></Field>
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-[#5E778C]">Options</p>
              {step.options.map((o, i) => (
                <div key={o.id} className="rounded-lg border border-[#E3EDF5] p-2">
                  <div className="flex items-center gap-1.5">
                    <input className={inputCls} maxLength={24} value={o.label} onChange={(e) => setOption(i, e.target.value)} aria-label={`Option ${i + 1}`} placeholder={`Option ${i + 1}`} />
                    <Button variant="secondary" size="xs" icon={<X size={12} />} aria-label={`Remove option ${i + 1}`} disabled={step.options.length <= 1} onClick={() => set('options', step.options.filter((_, j) => j !== i))} />
                  </div>
                  <div className="mt-1.5"><Select value={o.next || END_STEP} aria-label={`Option ${i + 1} goes to`} onChange={(e) => onExit({ stepId: step.id, optionId: o.id }, e.target.value)} options={goTo} /></div>
                </div>
              ))}
              {step.options.length < 10 && <Button variant="secondary" size="xs" icon={<Plus size={12} />} onClick={() => set('options', [...step.options, { id: newId('o'), label: `Option ${step.options.length + 1}`, next: END_STEP }])}>Add option</Button>}
              <p className="text-[11px] text-[#5E778C]">{step.options.length > 3 ? 'WhatsApp will show these as a list, up to 24 characters each.' : 'WhatsApp will show these as buttons. Over 20 characters becomes a list.'}</p>
            </div>
          </>
        )}
        {step.type === 'visit' && (
          <>
            <Field label="Days to offer, from tomorrow"><input className={inputCls} type="number" min={1} max={10} value={step.days} onChange={(e) => set('days', Number(e.target.value))} /></Field>
            <Field label="Times" hint="Separate with commas, like 11:00, 15:30"><input className={inputCls} value={step.times.join(', ')} onChange={(e) => set('times', e.target.value.split(',').map((x) => x.trim()).filter(Boolean))} /></Field>
          </>
        )}
        {step.type === 'ai' && <Field label="What the AI may use" hint="Projects, prices, locations, amenities, timings. It answers only from this, in up to 6 replies a chat. Keep it current: a wrong price here goes to customers."><textarea className={inputCls} rows={8} maxLength={20000} value={knowledge} onChange={(e) => onKnowledge(e.target.value)} /></Field>}
        {!['choice', 'handoff', 'end'].includes(step.type) && <Field label="Then go to"><Select value={step.next || END_STEP} onChange={(e) => onExit({ stepId: step.id }, e.target.value)} options={goTo} /></Field>}
      </div>
      <div className="border-t border-[#E3EDF5] p-3">
        <Button variant="secondary" size="sm" icon={<Trash2 size={13} />} disabled={!canRemove} title={canRemove ? undefined : 'The first step needs one path to hand over to. Change what it does instead.'} onClick={onRemove}>Remove step{removeCount > 1 ? ` and ${removeCount - 1} after it` : ''}</Button>
      </div>
    </aside>
  );
};

export const BotFlowEditor: React.FC<{ draft: BotDraft; aiAvailable: boolean; onClose: () => void; onSaved: (id: string, problems: string[]) => void }> = ({ draft, aiAvailable, onClose, onSaved }) => {
  const [d, setD] = useState<BotDraft>(() => ({ ...draft, steps: mapOrder(explicitSteps(draft.steps as BotStep[])) as BotStepView[] }));
  const [selected, setSelected] = useState(d.steps[0]?.id || '');
  const [adding, setAdding] = useState('');
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [removing, setRemoving] = useState('');

  const update = (fn: (steps: BotStepView[]) => BotStepView[]) => {
    setD((x) => ({ ...x, steps: mapOrder(fn(x.steps) as BotStep[]) as BotStepView[] }));
    setDirty(true);
  };
  const steps = d.steps;
  const map = useMemo(() => layoutBot(steps as BotStep[]), [steps]);
  const problems = useMemo(() => botProblems({ steps: steps as BotStep[] }), [steps]);
  const stepHasProblem = (n: number) => problems.some((p) => p.startsWith(`Step ${n}:`));
  const nodeOf = useMemo(() => new Map(map.nodes.map((n) => [n.key, n])), [map]);
  const current = steps.find((s) => s.id === selected);
  const numberOf = (id: string) => steps.findIndex((s) => s.id === id) + 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (adding) setAdding('');
      else if (selected) setSelected('');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [adding, selected]);

  const add = (e: Exit, type: BotStepView['type']) => {
    const step = makeStep(type);
    update((s) => insertStep(s as BotStep[], e, step as BotStep) as BotStepView[]);
    setAdding('');
    setSelected(step.id);
  };
  const addFirst = (type: BotStepView['type']) => {
    const step = makeStep(type);
    update(() => (explicitSteps([step as BotStep]) as BotStepView[]));
    setAdding('');
    setSelected(step.id);
  };
  const confirmRemove = (id: string) => {
    if (removalCount(steps as BotStep[], id) > 1) setRemoving(id);
    else doRemove(id);
  };
  const doRemove = (id: string) => {
    update((s) => removeStep(s as BotStep[], id) as BotStepView[]);
    setRemoving('');
    setSelected('');
  };
  const save = async () => {
    setBusy(true);
    setProblem('');
    try {
      const r = await api.bots.save(d);
      onSaved(r.id, r.problems);
    } catch (e) {
      setProblem(toAppError(reportError('bots.save', e)).userMessage);
    } finally {
      setBusy(false);
    }
  };
  const edgePath = (e: MapEdge) => {
    const a = nodeOf.get(e.fromKey)!;
    const b = nodeOf.get(e.toKey)!;
    const x1 = a.x + a.w / 2, y1 = a.y + a.h, x2 = b.x + b.w / 2, y2 = b.y;
    const mid = (y1 + y2) / 2;
    const t = e.label ? 0.35 : 0.5;
    const u = 1 - t;
    const at = (a: number, b: number, c: number) => (u * u * u + 3 * u * u * t) * a + 3 * u * t * t * b + t * t * t * c;
    return { d: `M${x1} ${y1} C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`, midX: u * u * u * x1 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x2, midY: at(y1, mid, y2) + 3 * u * u * t * (mid - y1), x2, y2 };
  };
  const pad = 40;
  const canvasW = (map.width + pad * 2) * zoom;
  const canvasH = (map.height + pad * 2 + 60) * zoom;

  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-[#F4F8FB]" role="dialog" aria-modal="true" aria-label={d.id ? `Edit ${draft.name}` : 'New chatbot'}>
      <header className="flex flex-wrap items-end gap-3 border-b border-[#D3E3F0] bg-white px-4 py-3">
        <div className="min-w-[180px] flex-1"><Field label="Bot name"><input className={inputCls} maxLength={80} value={d.name} onChange={(e) => { setD({ ...d, name: e.target.value }); setDirty(true); }} /></Field></div>
        <div className="min-w-[220px]"><Field label="Starts when"><Select value={d.trigger} onChange={(e) => { setD({ ...d, trigger: e.target.value as BotDraft['trigger'] }); setDirty(true); }} options={TRIGGERS} /></Field></div>
        {d.trigger === 'keyword' && <div className="min-w-[160px]"><Field label="Keywords"><input className={inputCls} placeholder="price, brochure" value={d.keywords} onChange={(e) => { setD({ ...d, keywords: e.target.value }); setDirty(true); }} /></Field></div>}
        <span className="flex gap-2 pb-0.5"><Button variant="secondary" onClick={() => (dirty ? setLeaving(true) : onClose())}>Close</Button><Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button></span>
      </header>
      {problem && <InlineNotice tone="warning" className="m-2">{problem}</InlineNotice>}
      {problems.length > 0 && !problem && <p className="flex items-center gap-1.5 border-b border-[#F8D9B0] bg-[#FFF8E6] px-4 py-1.5 text-xs text-[#8A5A00]"><AlertTriangle size={13} className="flex-none" aria-hidden="true" /><span className="min-w-0 truncate">{problems[0]}{problems.length > 1 ? ` And ${problems.length - 1} more.` : ''}</span></p>}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div className="relative min-h-0 flex-1 overflow-auto" onClick={(e) => { if (e.target === e.currentTarget) { setSelected(''); setAdding(''); } }}>
          <div className="sticky left-3 top-3 z-20 inline-flex gap-1 rounded-lg border border-[#D3E3F0] bg-white p-1 shadow-sm">
            <Button variant="secondary" size="xs" icon={<Minus size={12} />} aria-label="Zoom out" disabled={zoom <= 0.5} onClick={() => setZoom((z) => Math.max(0.5, Math.round((z - 0.1) * 10) / 10))} />
            <span className="w-10 self-center text-center text-[11px] tabular-nums text-[#3E5A70]">{Math.round(zoom * 100)}%</span>
            <Button variant="secondary" size="xs" icon={<Plus size={12} />} aria-label="Zoom in" disabled={zoom >= 1.2} onClick={() => setZoom((z) => Math.min(1.2, Math.round((z + 0.1) * 10) / 10))} />
          </div>
          {!steps.length ? (
            <div className="relative mx-auto mt-16 w-fit text-center">
              <p className="mb-2 text-sm text-[#5E778C]">Start with the first step.</p>
              <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding('first')}>Add first step</Button>
              {adding === 'first' && <AddMenu aiAvailable={aiAvailable} onPick={addFirst} onClose={() => setAdding('')} />}
            </div>
          ) : (
            <div style={{ width: canvasW, height: canvasH }} onClick={(e) => { if (e.target === e.currentTarget) { setSelected(''); setAdding(''); } }}>
              <div className="relative origin-top-left" style={{ width: map.width + pad * 2, height: map.height + pad * 2, transform: `scale(${zoom})` }}>
                <div className="absolute" style={{ left: pad, top: pad, width: map.width, height: map.height }}>
                  <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={map.width} height={map.height} aria-hidden="true">
                    {map.edges.map((e) => <path key={e.key} d={edgePath(e).d} fill="none" stroke="#9CB6CA" strokeWidth={1.5} />)}
                  </svg>
                  {map.edges.map((e) => {
                    const p = edgePath(e);
                    const target = nodeOf.get(e.toKey)!;
                    return (
                      <React.Fragment key={e.key}>
                        {e.label && <span className="absolute z-10 max-w-[120px] -translate-x-1/2 truncate rounded-full border border-[#F2D9AE] bg-[#FFF4E5] px-2 py-0.5 text-[10.5px] font-semibold text-[#9A5B00]" style={{ left: p.x2, top: p.y2 - 34 }} title={e.label}>{e.label}</span>}
                        {target.kind !== 'end' && (
                          <span className="absolute z-10 -translate-x-1/2 -translate-y-1/2" style={{ left: p.midX, top: p.midY }}>
                            <button type="button" aria-label="Add a step here" title="Add a step here" onClick={() => setAdding(e.key)} className="flex h-5 w-5 items-center justify-center rounded-full border border-[#9CB6CA] bg-white text-[#3E5A70] hover:border-[#0B6BB0] hover:text-[#0B6BB0]"><Plus size={11} /></button>
                            {adding === e.key && <AddMenu aiAvailable={aiAvailable} onPick={(t) => add(e.exit, t)} onClose={() => setAdding('')} />}
                          </span>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {map.nodes.map((n) => {
                    if (n.kind === 'step') {
                      const s = steps.find((x) => x.id === n.stepId)!;
                      return <StepBox key={n.key} node={n} step={s} selected={selected === s.id} hasProblem={stepHasProblem(n.number)} onClick={() => { setSelected(s.id); setAdding(''); }} />;
                    }
                    const edge = map.edges.find((e) => e.toKey === n.key)!;
                    if (n.kind === 'jump') {
                      return <button key={n.key} type="button" onClick={() => setSelected(n.stepId)} style={{ left: n.x, top: n.y, width: n.w, height: n.h }} className="absolute flex items-center justify-center gap-1 rounded-lg border border-dashed border-[#9CB6CA] bg-white text-[11.5px] font-medium text-[#3E5A70] hover:bg-[#F2F7FB]"><CornerDownRight size={12} aria-hidden="true" />Goes to step {n.number}</button>;
                    }
                    return (
                      <span key={n.key} className="absolute" style={{ left: n.x, top: n.y, width: n.w, height: n.h }}>
                        <button type="button" onClick={() => setAdding(edge.key)} className="flex h-full w-full flex-col items-center justify-center rounded-lg border border-dashed border-[#9CB6CA] bg-white text-[11px] text-[#5E778C] hover:border-[#0B6BB0] hover:text-[#0B6BB0]"><span className="inline-flex items-center gap-1 font-semibold"><Plus size={12} aria-hidden="true" />Add a step</span><span className="text-[10px]">or the chat ends here</span></button>
                        {adding === edge.key && <AddMenu aiAvailable={aiAvailable} onPick={(t) => add(edge.exit, t)} onClose={() => setAdding('')} />}
                      </span>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          {map.unconnected.length > 0 && (
            <div className="sticky bottom-3 left-3 z-20 inline-block max-w-md rounded-lg border border-[#F8D9B0] bg-[#FFF8E6] p-2.5 text-xs text-[#6B4700] shadow-sm">
              <p className="font-semibold">Not connected to anything</p>
              <div className="mt-1 flex flex-wrap gap-1">{map.unconnected.map((id) => <button key={id} type="button" className="rounded border border-[#F2D58A] bg-white px-2 py-0.5 hover:bg-[#FFFDF5]" onClick={() => setSelected(id)}>Step {numberOf(id)}: {KINDS[steps.find((s) => s.id === id)!.type].label}</button>)}</div>
            </div>
          )}
        </div>

        {current ? (
          <div className="max-h-[50vh] lg:max-h-none">
            <Inspector key={current.id} step={current} number={numberOf(current.id)} all={steps} canRemove={removeStep(steps as BotStep[], current.id).length < steps.length} removeCount={removalCount(steps as BotStep[], current.id)} aiAvailable={aiAvailable} knowledge={d.knowledge} onKnowledge={(v) => { setD((x) => ({ ...x, knowledge: v })); setDirty(true); }}
              onChange={(n) => update((s) => s.map((x) => (x.id === n.id ? n : x)))}
              onExit={(e, target) => update((s) => setExit(s as BotStep[], e, target) as BotStepView[])}
              onRemove={() => confirmRemove(current.id)} onClose={() => setSelected('')} />
          </div>
        ) : null}
      </div>
      <ConfirmDialog open={leaving} danger title="Close without saving?" message="Your changes to this bot will be lost." confirmLabel="Close without saving" onConfirm={onClose} onCancel={() => setLeaving(false)} />
      <ConfirmDialog open={!!removing} danger title="Remove this step and what follows it?" message={`Its paths go with it: ${removing ? removalCount(steps as BotStep[], removing) : 0} steps in all.`} confirmLabel="Remove" onConfirm={() => doRemove(removing)} onCancel={() => setRemoving('')} />
    </div>,
    document.body,
  );
};
