/** The chatbot builder: a map you can drag. Boxes move, dots connect, lines can be re-pointed or removed, and every change can be undone. */
import React, { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, Handle, MarkerType, MiniMap, Panel, Position, ReactFlow, ReactFlowProvider, applyNodeChanges, getBezierPath, useNodesInitialized, useReactFlow, useUpdateNodeInternals, useViewport, type Connection, type Edge, type EdgeProps, type EdgeChange, type FinalConnectionState, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { AlertTriangle, CalendarDays, CheckCircle2, CircleHelp, GitBranch, LayoutGrid, Maximize, MessageSquare, Minus, Plus, Redo2, Sparkles, Trash2, Undo2, UserRound, X } from 'lucide-react';
import { api, type BotStepView } from '../../core/api';
import { END_STEP, botProblems, type BotStep } from '../../core/botEngine';
import { reportError, toAppError } from '../../core/errors';
import { Button, ConfirmDialog, Field, InlineNotice, Select, cx, inputCls } from '../../components/ui';
import { NODE_W, addStep, arrange, emptyHistory, exitsOf, explicitSteps, mapOrder, record, redo, removalCount, removeStep, setExit, setPosition, undo, unconnectedSteps, withPositions, type Exit, type History, type Pos } from './botTree';

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
const LINE = '#9CB6CA';
const LINE_ON = '#0B6BB0';

let counter = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;
const makeStep = (type: BotStepView['type']): BotStepView => ({ id: newId('s'), type, text: '', next: '', saveTo: '', validate: 'text', options: type === 'choice' ? [{ id: newId('o'), label: 'Option 1', next: END_STEP }, { id: newId('o'), label: 'Option 2', next: END_STEP }] : [], days: 7, times: ['11:00', '15:00', '17:00'] });
const exitOfHandle = (stepId: string, handle?: string | null): Exit => (handle && handle !== 'next' ? { stepId, optionId: handle } : { stepId });
const clientPoint = (e: MouseEvent | TouchEvent) => ('changedTouches' in e ? { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY } : { x: e.clientX, y: e.clientY });
const boxAt = (p: { x: number; y: number }) => document.elementFromPoint(p.x, p.y)?.closest('.react-flow__node')?.getAttribute('data-id') || '';

/** What boxes and lines can ask the editor to do. */
type Actions = { openAdd: (exit: Exit, x: number, y: number) => void; remove: (id: string) => void; unlink: (exit: Exit) => void; hover: (edge: string) => void };
const ActionsContext = createContext<Actions | null>(null);

type BoxData = { step: BotStepView; number: number; problem: boolean; start: boolean; unconnected: boolean; open: string[]; removable: boolean };
type BoxNode = Node<BoxData, 'bot'>;
type LineData = { exit: Exit; hover: boolean; lit: boolean };
type LineEdge = Edge<LineData, 'bot'>;

const dot = (ink: string): React.CSSProperties => ({ width: 13, height: 13, background: '#fff', border: `2px solid ${ink}` });

const OpenPath: React.FC<{ exit: Exit }> = ({ exit }) => {
  const a = useContext(ActionsContext)!;
  return <button type="button" aria-label="Add the next step" title="Add the next step. Left open, the chat ends here." onClick={(e) => { e.stopPropagation(); a.openAdd(exit, e.clientX, e.clientY); }} className="nodrag nopan absolute left-full top-1/2 ml-2.5 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border border-dashed border-[#7E93A6] bg-white text-[#3E5A70] hover:border-[#0B6BB0] hover:text-[#0B6BB0]"><Plus size={13} /></button>;
};

const Box: React.FC<NodeProps<BoxNode>> = memo(({ id, data, selected }) => {
  const { step, number, problem, start, unconnected, open, removable } = data;
  const K = KINDS[step.type];
  const a = useContext(ActionsContext)!;
  const sync = useUpdateNodeInternals();
  const rows = step.type === 'choice' ? step.options.map((o) => o.id).join() : '';
  useEffect(() => sync(id), [id, rows, sync]);
  const single = step.type !== 'choice' && step.type !== 'handoff' && step.type !== 'end';
  return (
    <div className={cx('group relative rounded-xl border-2 bg-white shadow-sm transition-shadow hover:shadow-md', selected ? 'border-[#0B6BB0]' : problem ? 'border-[#F2B8B5]' : 'border-[#D3E3F0]')} style={{ width: NODE_W }}>
      {start && <span className="absolute -top-6 left-0 rounded-full bg-[#067647] px-2 py-0.5 text-[10.5px] font-semibold text-white">Start</span>}
      {unconnected && !start && <span className="absolute -top-6 left-0 rounded-full bg-[#FFF8E6] px-2 py-0.5 text-[10.5px] font-semibold text-[#8A5A00] ring-1 ring-[#F2D58A]">Nothing leads here</span>}
      <Handle type="target" position={Position.Left} isConnectableStart={false} style={{ ...dot('#7E93A6'), top: 18 }} />
      <div className="flex h-[34px] items-center gap-1.5 rounded-t-[10px] px-2.5 text-[11.5px] font-semibold" style={{ background: K.tint, color: K.ink }}>
        <K.icon size={13} aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{K.label}</span>
        {problem && <AlertTriangle size={13} className="flex-none text-[#B42318]" aria-label="Needs fixing" />}
        <button type="button" aria-label={`Remove step ${number}`} disabled={!removable} title={removable ? 'Remove this step' : 'The first step needs one path to hand over to. Change what it does instead.'} onClick={(e) => { e.stopPropagation(); a.remove(id); }} className={cx('nodrag nopan flex-none rounded p-0.5 text-[#B42318] hover:bg-white focus-visible:opacity-100 disabled:cursor-not-allowed disabled:text-[#9CB6CA]', selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}><Trash2 size={13} /></button>
        <span className="flex-none tabular-nums opacity-70">{number}</span>
      </div>
      <p className="line-clamp-3 h-[66px] break-words px-2.5 py-1.5 text-[12px] leading-snug text-[#0B2A44]">{step.text || <span className="text-[#7E93A6]">{step.type === 'visit' ? 'Which day suits you?' : step.type === 'end' ? 'Stops quietly' : 'No message yet'}</span>}</p>
      {step.type === 'choice' && (
        <ul className="space-y-0 border-t border-[#E3EDF5] py-1.5">
          {step.options.map((o) => (
            <li key={o.id} className="relative flex h-[34px] items-center px-2.5">
              <span className="min-w-0 flex-1 truncate rounded-md bg-[#FFF4E5] px-2 py-1 text-[11.5px] font-semibold text-[#9A5B00]" title={o.label}>{o.label || 'Option'}</span>
              <Handle id={o.id} type="source" position={Position.Right} isConnectableEnd={false} style={dot('#9A5B00')} />
              {open.includes(o.id) && <OpenPath exit={{ stepId: id, optionId: o.id }} />}
            </li>
          ))}
        </ul>
      )}
      {single && <Handle id="next" type="source" position={Position.Right} isConnectableEnd={false} style={dot(K.ink)} />}
      {single && open.includes('next') && <OpenPath exit={{ stepId: id }} />}
    </div>
  );
});
Box.displayName = 'Box';

const Line: React.FC<EdgeProps<LineEdge>> = ({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd, selected, data }) => {
  const a = useContext(ActionsContext)!;
  const [path, x, y] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition });
  const on = selected || data?.lit || data?.hover;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} interactionWidth={26} style={{ stroke: on ? LINE_ON : LINE, strokeWidth: on ? 2.25 : 1.5 }} />
      {(selected || data?.hover) && data && (
        <EdgeLabelRenderer>
          <div className="nodrag nopan absolute flex gap-1" style={{ transform: `translate(-50%,-50%) translate(${x}px,${y}px)`, pointerEvents: 'all', zIndex: 1002 }} onMouseEnter={() => a.hover(id)} onMouseLeave={() => a.hover('')}>
            <button type="button" aria-label="Add a step on this line" title="Add a step on this line" onClick={(e) => { e.stopPropagation(); a.openAdd(data.exit, e.clientX, e.clientY); }} className="flex h-6 w-6 items-center justify-center rounded-full border border-[#0B6BB0] bg-white text-[#0B6BB0] shadow-sm hover:bg-[#EAF4FB]"><Plus size={13} /></button>
            {selected && <button type="button" aria-label="Remove this line" title="Remove this line" onClick={(e) => { e.stopPropagation(); a.unlink(data.exit); }} className="flex h-6 w-6 items-center justify-center rounded-full border border-[#F2B8B5] bg-white text-[#B42318] shadow-sm hover:bg-[#FEF3F2]"><X size={13} /></button>}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
};

const nodeTypes = { bot: Box };
const edgeTypes = { bot: Line };

const AddMenu: React.FC<{ x: number; y: number; aiAvailable: boolean; onPick: (t: BotStepView['type']) => void; onClose: () => void }> = ({ x, y, aiAvailable, onPick, onClose }) => {
  const types = (Object.keys(KINDS) as Array<BotStepView['type']>).filter((t) => t !== 'ai' || aiAvailable);
  const left = Math.max(8, Math.min(x + 6, window.innerWidth - 232));
  const top = Math.max(8, Math.min(y + 6, window.innerHeight - (types.length * 34 + 20)));
  return (
    <>
      <div className="absolute inset-0 z-40" onClick={onClose} aria-hidden="true" />
      <div role="menu" aria-label="Add a step" className="fixed z-50 w-56 rounded-lg border border-[#D3E3F0] bg-white p-1 shadow-xl" style={{ left, top }}>
        {types.map((t) => {
          const K = KINDS[t];
          return <button key={t} type="button" role="menuitem" onClick={() => onPick(t)} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs font-medium text-[#0B2A44] hover:bg-[#F2F7FB]"><span className="flex h-6 w-6 flex-none items-center justify-center rounded" style={{ background: K.tint, color: K.ink }}><K.icon size={13} aria-hidden="true" /></span>{K.label}</button>;
        })}
      </div>
    </>
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
    onChange({ ...fresh, id: step.id, pos: step.pos, text: step.text, next: type === 'handoff' || type === 'end' || type === 'choice' ? '' : onward, options: type === 'choice' ? fresh.options.map((o, i) => ({ ...o, next: i === 0 ? onward : END_STEP })) : [] });
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

const Toolbar: React.FC<{ canUndo: boolean; canRedo: boolean; onUndo: () => void; onRedo: () => void; onArrange: () => void }> = ({ canUndo, canRedo, onUndo, onRedo, onArrange }) => {
  const rf = useReactFlow();
  const { zoom } = useViewport();
  return (
    <Panel position="top-left" className="flex flex-wrap items-center gap-1 rounded-lg border border-[#D3E3F0] bg-white p-1 shadow-sm">
      <Button variant="secondary" size="xs" icon={<Undo2 size={12} />} aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo} />
      <Button variant="secondary" size="xs" icon={<Redo2 size={12} />} aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!canRedo} onClick={onRedo} />
      <span className="mx-0.5 h-4 w-px bg-[#D3E3F0]" aria-hidden="true" />
      <Button variant="secondary" size="xs" icon={<Minus size={12} />} aria-label="Zoom out" onClick={() => void rf.zoomOut({ duration: 120 })} />
      <span className="w-10 text-center text-[11px] tabular-nums text-[#3E5A70]">{Math.round(zoom * 100)}%</span>
      <Button variant="secondary" size="xs" icon={<Plus size={12} />} aria-label="Zoom in" onClick={() => void rf.zoomIn({ duration: 120 })} />
      <Button variant="secondary" size="xs" icon={<Maximize size={12} />} aria-label="Fit the whole map" title="Fit the whole map" onClick={() => void rf.fitView({ padding: 0.15, maxZoom: 1, duration: 200 })} />
      <span className="mx-0.5 h-4 w-px bg-[#D3E3F0]" aria-hidden="true" />
      <Button variant="secondary" size="xs" icon={<LayoutGrid size={12} />} onClick={onArrange}>Arrange</Button>
    </Panel>
  );
};

const Editor: React.FC<{ draft: BotDraft; aiAvailable: boolean; onClose: () => void; onSaved: (id: string, problems: string[]) => void }> = ({ draft, aiAvailable, onClose, onSaved }) => {
  const rf = useReactFlow();
  const [d, setD] = useState<Omit<BotDraft, 'steps'>>(() => ({ id: draft.id, name: draft.name, trigger: draft.trigger, keywords: draft.keywords, knowledge: draft.knowledge }));
  const [flow, setFlow] = useState<{ steps: BotStep[]; history: History }>(() => ({ steps: withPositions(mapOrder(explicitSteps(draft.steps as BotStep[]))), history: emptyHistory }));
  const steps = flow.steps;
  const [selected, setSelected] = useState('');
  const [selectedEdge, setSelectedEdge] = useState('');
  const [hoverEdge, setHoverEdge] = useState('');
  const [menu, setMenu] = useState<{ x: number; y: number; exit?: Exit; at?: Pos } | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [dirty, setDirty] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [removing, setRemoving] = useState('');
  const pane = useRef<HTMLDivElement>(null);
  // the whole map in view on opening, once every box has been measured
  const measured = useNodesInitialized();
  const fitted = useRef(false);
  useEffect(() => {
    if (!measured || fitted.current) return;
    fitted.current = true;
    void rf.fitView({ padding: 0.15, maxZoom: 1 });
  }, [measured, rf]);

  const update = useCallback((fn: (s: BotStep[]) => BotStep[], group?: string) => {
    setFlow((f) => {
      const steps = mapOrder(fn(f.steps));
      // a change that changes nothing, like one drop reported twice, must not take an extra undo
      if (JSON.stringify(steps) === JSON.stringify(f.steps)) return f;
      return { steps, history: record(f.history, f.steps, group) };
    });
    setDirty(true);
  }, []);
  const keepInView = useCallback(() => {
    setTimeout(() => {
      const r = pane.current?.getBoundingClientRect();
      if (!r) return;
      const shown = [...(pane.current?.querySelectorAll('.react-flow__node') ?? [])].some((n) => {
        const b = n.getBoundingClientRect();
        return b.right > r.left && b.left < r.right && b.bottom > r.top && b.top < r.bottom;
      });
      if (!shown) void rf.fitView({ padding: 0.15, maxZoom: 1, duration: 200 });
    }, 80);
  }, [rf]);
  const doUndo = useCallback(() => { setFlow((f) => { const r = undo(f.history, f.steps); return r ? { steps: r.steps, history: r.history } : f; }); setDirty(true); setNotice(''); keepInView(); }, [keepInView]);
  const doRedo = useCallback(() => { setFlow((f) => { const r = redo(f.history, f.steps); return r ? { steps: r.steps, history: r.history } : f; }); setDirty(true); keepInView(); }, [keepInView]);

  const problems = useMemo(() => botProblems({ steps }), [steps]);
  const current = steps.find((s) => s.id === selected) as BotStepView | undefined;
  const numberOf = (id: string) => steps.findIndex((s) => s.id === id) + 1;

  const doRemove = (id: string) => {
    update((s) => removeStep(s, id));
    setRemoving('');
    setSelected('');
    setNotice('Step removed.');
  };
  const askRemove = (id: string) => {
    const n = removalCount(steps, id);
    if (n > 1) setRemoving(id);
    else if (n === 1) doRemove(id);
  };
  const link = (exit: Exit, target: string) => {
    if (target && target !== exit.stepId) update((s) => setExit(s, exit, target));
  };
  const unlink = (exit: Exit) => {
    update((s) => setExit(s, exit, END_STEP));
    setSelectedEdge('');
    setHoverEdge('');
  };
  const pick = (type: BotStepView['type']) => {
    if (!menu) return;
    const step = makeStep(type) as BotStep;
    const next = menu.exit ? addStep(steps, menu.exit, step, menu.at) : [{ ...step, pos: { x: 0, y: 0 } }];
    update(() => next);
    setMenu(null);
    setSelected(step.id);
    setSelectedEdge('');
    const at = next.find((s) => s.id === step.id)?.pos;
    if (at) {
      // bring it into view if it landed off screen
      setTimeout(() => {
        const r = pane.current?.getBoundingClientRect();
        if (!r) return;
        const p = rf.flowToScreenPosition(at);
        const v = rf.getViewport();
        const edge = 24;
        const w = (NODE_W + 40) * v.zoom;
        const h = 130 * v.zoom;
        const dx = p.x < r.left + edge ? r.left + edge - p.x : p.x + w > r.right - edge ? r.right - edge - p.x - w : 0;
        const dy = p.y < r.top + 70 ? r.top + 70 - p.y : p.y + h > r.bottom - edge ? r.bottom - edge - p.y - h : 0;
        if (dx || dy) void rf.setViewport({ x: v.x + dx, y: v.y + dy, zoom: v.zoom }, { duration: 200 });
      }, 60);
    }
  };
  const tidy = () => {
    update((s) => arrange(s));
    setTimeout(() => void rf.fitView({ padding: 0.15, maxZoom: 1, duration: 200 }), 40);
  };

  // boxes and lines call through this, so they need not redraw whenever the editor does
  const latest = useRef<Actions | null>(null);
  useEffect(() => {
    latest.current = { openAdd: (exit, x, y) => setMenu({ x, y, exit }), remove: askRemove, unlink, hover: setHoverEdge };
  });
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const actions = useMemo<Actions>(() => ({
    openAdd: (e, x, y) => latest.current?.openAdd(e, x, y),
    remove: (id) => latest.current?.remove(id),
    unlink: (e) => latest.current?.unlink(e),
    // a short wait, so moving from the line onto its buttons does not hide them
    hover: (edge) => { clearTimeout(hoverTimer.current); if (edge) setHoverEdge(edge); else hoverTimer.current = setTimeout(() => setHoverEdge(''), 150); },
  }), []);

  const build = useCallback((prev: BoxNode[]): BoxNode[] => {
    const ids = new Set(steps.map((s) => s.id));
    const lost = new Set(unconnectedSteps(steps));
    const old = new Map(prev.map((n) => [n.id, n]));
    return steps.map((s, i) => ({
      ...old.get(s.id), id: s.id, type: 'bot' as const, position: s.pos || { x: 0, y: 0 }, selected: s.id === selected,
      data: { step: s as BotStepView, number: i + 1, problem: problems.some((p) => p.startsWith(`Step ${i + 1}:`)), start: i === 0, unconnected: lost.has(s.id), open: exitsOf(s).filter((x) => !ids.has(x.target)).map((x) => x.handle), removable: removalCount(steps, s.id) > 0 },
    }));
  }, [steps, selected, problems]);
  const [nodes, setNodes] = useState<BoxNode[]>(() => build([]));
  useEffect(() => setNodes(build), [build]);

  const edges = useMemo<LineEdge[]>(() => {
    const ids = new Set(steps.map((s) => s.id));
    return steps.flatMap((s) => exitsOf(s).filter((x) => ids.has(x.target)).map((x) => {
      const id = `${s.id}:${x.handle}`;
      const lit = !!selected && (s.id === selected || x.target === selected);
      const on = lit || id === selectedEdge || id === hoverEdge;
      return { id, type: 'bot' as const, zIndex: on ? 1001 : 0, source: s.id, sourceHandle: x.handle, target: x.target, selected: id === selectedEdge, reconnectable: 'target' as const, markerEnd: { type: MarkerType.ArrowClosed, color: on ? LINE_ON : LINE, width: 18, height: 18 }, data: { exit: x.exit, hover: id === hoverEdge, lit } };
    }));
  }, [steps, selected, selectedEdge, hoverEdge]);

  const selectBox = (id: string) => { setSelected(id); setSelectedEdge(''); };
  const onNodesChange = (changes: NodeChange<BoxNode>[]) => {
    const picked = changes.find((c) => c.type === 'select' && c.selected);
    if (picked && picked.type === 'select') selectBox(picked.id);
    setNodes((ns) => applyNodeChanges(changes.filter((c) => c.type !== 'select' && c.type !== 'remove'), ns));
  };
  const onEdgesChange = (changes: EdgeChange<LineEdge>[]) => {
    const picked = changes.find((c) => c.type === 'select' && c.selected);
    if (picked && picked.type === 'select') { setSelectedEdge(picked.id); setSelected(''); }
  };
  const reconnecting = useRef(false);
  const onConnectEnd = (e: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const from = state.fromNode?.id;
    if (reconnecting.current || state.isValid || !from) return;
    const exit = exitOfHandle(from, state.fromHandle?.id);
    const p = clientPoint(e);
    const box = boxAt(p);
    if (box) link(exit, box);
    else setMenu({ x: p.x, y: p.y, exit, at: rf.screenToFlowPosition(p) });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable]');
      if (e.key === 'Escape') {
        if (menu) setMenu(null);
        else { setSelected(''); setSelectedEdge(''); }
        return;
      }
      if (typing || removing || leaving) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) doRedo(); else doUndo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selected) askRemove(selected);
        else {
          const line = edges.find((x) => x.id === selectedEdge);
          if (line?.data) unlink(line.data.exit);
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 7000);
    return () => clearTimeout(t);
  }, [notice]);

  const save = async () => {
    setBusy(true);
    setProblem('');
    try {
      const r = await api.bots.save({ ...d, steps: steps as BotStepView[] });
      onSaved(r.id, r.problems);
    } catch (e) {
      setProblem(toAppError(reportError('bots.save', e)).userMessage);
    } finally {
      setBusy(false);
    }
  };
  const editHeader = (patch: Partial<typeof d>) => { setD((x) => ({ ...x, ...patch })); setDirty(true); };

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#F4F8FB]" role="dialog" aria-modal="true" aria-label={d.id ? `Edit ${draft.name}` : 'New chatbot'}>
      <header className="flex flex-wrap items-end gap-3 border-b border-[#D3E3F0] bg-white px-4 py-3">
        <div className={cx(current && 'hidden sm:block', 'min-w-[160px] flex-1')}><Field label="Bot name"><input className={inputCls} maxLength={80} value={d.name} onChange={(e) => editHeader({ name: e.target.value })} /></Field></div>
        <div className={cx(current && 'hidden sm:block', 'w-full sm:w-[260px]')}><Field label="Starts when"><Select value={d.trigger} onChange={(e) => editHeader({ trigger: e.target.value as BotDraft['trigger'] })} options={TRIGGERS} /></Field></div>
        {d.trigger === 'keyword' && <div className={cx(current && 'hidden sm:block', 'w-full sm:w-[170px]')}><Field label="Keywords"><input className={inputCls} placeholder="price, brochure" value={d.keywords} onChange={(e) => editHeader({ keywords: e.target.value })} /></Field></div>}
        <span className="ml-auto flex flex-none items-center gap-2 pb-0.5">
          {dirty && <span className="text-[11px] text-[#5E778C]">Not saved yet</span>}
          <Button variant="secondary" onClick={() => (dirty ? setLeaving(true) : onClose())}>Close</Button>
          <Button variant="primary" loading={busy} onClick={() => void save()}>Save</Button>
        </span>
      </header>
      {problem && <InlineNotice tone="warning" className="m-2">{problem}</InlineNotice>}
      {problems.length > 0 && !problem && <p className="flex items-center gap-1.5 border-b border-[#F8D9B0] bg-[#FFF8E6] px-4 py-1.5 text-xs text-[#8A5A00]"><AlertTriangle size={13} className="flex-none" aria-hidden="true" /><span className="min-w-0 truncate">{problems[0]}{problems.length > 1 ? ` And ${problems.length - 1} more.` : ''}</span></p>}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <div ref={pane} className="relative min-h-0 min-w-0 flex-1">
          <ActionsContext.Provider value={actions}>
            <ReactFlow<BoxNode, LineEdge>
              nodes={nodes} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
              onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
              onNodeClick={(_, n) => { selectBox(n.id); setMenu(null); }}
              onEdgeClick={(_, x) => { setSelectedEdge(x.id); setSelected(''); }}
              onPaneClick={() => { setSelected(''); setSelectedEdge(''); setMenu(null); }}
              onNodeDragStop={(_, n) => { const s = steps.find((x) => x.id === n.id); if (s && (s.pos?.x !== n.position.x || s.pos?.y !== n.position.y)) update((all) => setPosition(all, n.id, { x: n.position.x, y: n.position.y })); }}
              onEdgeMouseEnter={(_, x) => actions.hover(x.id)} onEdgeMouseLeave={() => actions.hover('')}
              onConnect={(c: Connection) => { if (c.source) link(exitOfHandle(c.source, c.sourceHandle), c.target); }}
              onConnectEnd={onConnectEnd}
              onReconnect={(old, c) => { if (old.data && c.target) link(old.data.exit, c.target); }}
              onReconnectStart={() => { reconnecting.current = true; }}
              onReconnectEnd={(e, old, _h, state) => { reconnecting.current = false; if (!state.isValid && old.data) link(old.data.exit, boxAt(clientPoint(e))); }}
              minZoom={0.25} maxZoom={1.5} snapToGrid snapGrid={[8, 8]}
              selectNodesOnDrag={false} deleteKeyCode={null} selectionKeyCode={null} multiSelectionKeyCode={null} zoomOnDoubleClick={false} connectionRadius={28}
              connectionLineStyle={{ stroke: LINE_ON, strokeWidth: 2 }} attributionPosition="bottom-left"
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1.5} color="#C9D9E6" />
              <Toolbar canUndo={flow.history.past.length > 0} canRedo={flow.history.future.length > 0} onUndo={doUndo} onRedo={doRedo} onArrange={tidy} />
              <MiniMap pannable zoomable className="!hidden md:!block" nodeColor={(n) => KINDS[(n as BoxNode).data.step.type].ink} maskColor="rgba(11,42,68,0.08)" />
              {steps.length > 0 && <Panel position="top-right" className="hidden rounded-md bg-white/80 px-2 py-1 text-[11px] text-[#5E778C] xl:block">Drag a box to move it. Drag a dot to another box to connect.</Panel>}
            </ReactFlow>
          </ActionsContext.Provider>
          {!steps.length && (
            <div className="absolute left-1/2 top-1/3 z-10 -translate-x-1/2 text-center">
              <p className="mb-2 text-sm text-[#5E778C]">Start with the first step.</p>
              <Button variant="primary" icon={<Plus size={14} />} onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })}>Add first step</Button>
            </div>
          )}
          {notice && (
            <div role="status" className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-[#0B2A44] px-3 py-2 text-xs text-white shadow-lg">
              {notice}<button type="button" className="font-semibold underline" onClick={doUndo}>Undo</button>
            </div>
          )}
          {menu && <AddMenu x={menu.x} y={menu.y} aiAvailable={aiAvailable} onPick={pick} onClose={() => setMenu(null)} />}
        </div>
        {current && (
          <div className="max-h-[50vh] lg:max-h-none">
            <Inspector key={current.id} step={current} number={numberOf(current.id)} all={steps as BotStepView[]} canRemove={removalCount(steps, current.id) > 0} removeCount={removalCount(steps, current.id)} aiAvailable={aiAvailable} knowledge={d.knowledge} onKnowledge={(v) => editHeader({ knowledge: v })}
              onChange={(n) => update((s) => s.map((x) => (x.id === n.id ? (n as BotStep) : x)), `edit:${n.id}`)}
              onExit={(e, target) => update((s) => setExit(s, e, target))}
              onRemove={() => askRemove(current.id)} onClose={() => setSelected('')} />
          </div>
        )}
      </div>
      <ConfirmDialog open={leaving} danger title="Close without saving?" message="Your changes to this bot will be lost." confirmLabel="Close without saving" onConfirm={onClose} onCancel={() => setLeaving(false)} />
      <ConfirmDialog open={!!removing} danger title="Remove this step and what follows it?" message={`Its paths go with it: ${removing ? removalCount(steps, removing) : 0} steps in all. You can undo this.`} confirmLabel="Remove" onConfirm={() => doRemove(removing)} onCancel={() => setRemoving('')} />
    </div>
  );
};

export const BotFlowEditor: React.FC<{ draft: BotDraft; aiAvailable: boolean; onClose: () => void; onSaved: (id: string, problems: string[]) => void }> = (props) => createPortal(<ReactFlowProvider><Editor {...props} /></ReactFlowProvider>, document.body);
