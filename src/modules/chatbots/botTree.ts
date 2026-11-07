/** The chatbot as a map: where each box sits, how paths connect, adding and removing steps, and undo. No screen code, so it can be tested. */
import { END_STEP, explicitSteps, type BotStep } from '../../core/botEngine';

export { explicitSteps };

export const NODE_W = 264;
const HEADER_H = 36;
const TEXT_H = 66;
const ROW_H = 34;
const ROWS_PAD = 6;
const GAP_X = 96;
const GAP_Y = 36;

export type Pos = { x: number; y: number };
/** A way out of a step: its only path, or one option of a choice. */
export interface Exit { stepId: string; optionId?: string }

const noPaths = (s: BotStep) => s.type === 'handoff' || s.type === 'end';

export function exitsOf(s: BotStep): Array<{ exit: Exit; handle: string; target: string }> {
  if (noPaths(s)) return [];
  if (s.type === 'choice') return s.options.map((o) => ({ exit: { stepId: s.id, optionId: o.id }, handle: o.id, target: o.next || END_STEP }));
  return [{ exit: { stepId: s.id }, handle: 'next', target: s.next || END_STEP }];
}

export const heightOf = (s: BotStep) => HEADER_H + TEXT_H + (s.type === 'choice' ? ROWS_PAD * 2 + s.options.length * ROW_H : 0);
const exitY = (s: BotStep, optionId?: string) => {
  const i = optionId ? s.options.findIndex((o) => o.id === optionId) : -1;
  return i >= 0 ? HEADER_H + TEXT_H + ROWS_PAD + i * ROW_H : 0;
};
const overlaps = (a: Pos & { h: number }, b: BotStep) => !!b.pos && a.x < b.pos.x + NODE_W + 16 && a.x + NODE_W + 16 > b.pos.x && a.y < b.pos.y + heightOf(b) + 16 && a.y + a.h + 16 > b.pos.y;

const reachable = (steps: BotStep[], from?: string): Set<string> => {
  const seen = new Set<string>();
  const go = (id?: string) => {
    const s = steps.find((x) => x.id === id);
    if (!s || seen.has(s.id)) return;
    seen.add(s.id);
    exitsOf(s).forEach((x) => go(x.target));
  };
  go(from ?? steps[0]?.id);
  return seen;
};

/** Steps that nothing leads to. */
export const unconnectedSteps = (steps: BotStep[]): string[] => {
  const seen = reachable(steps);
  return steps.filter((s) => !seen.has(s.id)).map((s) => s.id);
};

/** Tidy left-to-right tree from the first step: children in columns, each parent centred on its children, nothing overlapping. */
export function arrange(steps: BotStep[]): BotStep[] {
  const pos = new Map<string, Pos>();
  const columnEnd: number[] = [];
  const place = (s: BotStep, depth: number): number => {
    pos.set(s.id, { x: 0, y: 0 });
    const centres: number[] = [];
    for (const { target } of exitsOf(s)) {
      const next = steps.find((x) => x.id === target);
      if (next && !pos.has(next.id)) centres.push(place(next, depth + 1));
    }
    const h = heightOf(s);
    const wanted = centres.length ? (centres[0] + centres[centres.length - 1]) / 2 - h / 2 : 0;
    const y = Math.max(wanted, columnEnd[depth] ?? 0, centres.length ? 0 : Math.max(0, ...columnEnd.slice(depth)));
    columnEnd[depth] = y + h + GAP_Y;
    pos.set(s.id, { x: depth * (NODE_W + GAP_X), y });
    return y + h / 2;
  };
  for (const s of steps) if (!pos.has(s.id)) place(s, 0);
  return steps.map((s) => ({ ...s, pos: pos.get(s.id) }));
}

/** A bot saved before boxes could be moved gets arranged the first time it opens. */
export const withPositions = (steps: BotStep[]): BotStep[] => (steps.every((s) => s.pos) ? steps : arrange(steps));

export const setPosition = (steps: BotStep[], id: string, pos: Pos): BotStep[] => steps.map((s) => (s.id === id ? { ...s, pos } : s));

/** Steps in the order the map reads, so step numbers run down each path. Needs every path written out: then order changes nothing. */
export function mapOrder(steps: BotStep[]): BotStep[] {
  const seen = new Set<string>();
  const ordered: BotStep[] = [];
  const go = (id: string) => {
    const s = steps.find((x) => x.id === id);
    if (!s || seen.has(s.id)) return;
    seen.add(s.id);
    ordered.push(s);
    exitsOf(s).forEach((x) => go(x.target));
  };
  if (steps[0]) go(steps[0].id);
  return [...ordered, ...steps.filter((s) => !seen.has(s.id))];
}

const targetOf = (steps: BotStep[], e: Exit): string => {
  const s = steps.find((x) => x.id === e.stepId);
  if (!s) return END_STEP;
  if (e.optionId) return s.options.find((o) => o.id === e.optionId)?.next || END_STEP;
  return s.next || END_STEP;
};

/** Point one way out at another step, or at END_STEP to leave the path open. */
export function setExit(steps: BotStep[], e: Exit, target: string): BotStep[] {
  return steps.map((s) => {
    if (s.id !== e.stepId) return s;
    if (e.optionId) return { ...s, options: s.options.map((o) => (o.id === e.optionId ? { ...o, next: target } : o)) };
    return { ...s, next: target };
  });
}

/** A new step on a path: whatever came next now comes after it. */
export function insertStep(steps: BotStep[], e: Exit, step: BotStep): BotStep[] {
  const after = targetOf(steps, e);
  let made = step;
  if (step.type === 'choice') made = { ...step, options: step.options.map((o, i) => ({ ...o, next: i === 0 ? after : END_STEP })) };
  else if (step.type !== 'handoff' && step.type !== 'end') made = { ...step, next: after };
  return [...setExit(steps, e, step.id), made];
}

/**
 * Adds a step and gives it a place: where it was dropped, or just after the step it follows. Adding on an existing line moves
 * what follows along to make room. It never sits on top of another box.
 */
export function addStep(steps: BotStep[], e: Exit, step: BotStep, at?: Pos): BotStep[] {
  const source = steps.find((s) => s.id === e.stepId);
  let all = insertStep(steps, e, step);
  let spot: Pos = at ?? { x: (source?.pos?.x ?? 0) + NODE_W + GAP_X, y: (source?.pos?.y ?? 0) + (source ? exitY(source, e.optionId) : 0) };
  if (!at) {
    const onward = reachable(steps, targetOf(steps, e));
    const startX = spot.x;
    all = all.map((s) => (s.pos && s.id !== e.stepId && onward.has(s.id) && s.pos.x >= startX ? { ...s, pos: { x: s.pos.x + NODE_W + GAP_X, y: s.pos.y } } : s));
  }
  const made = all.find((s) => s.id === step.id)!;
  const others = all.filter((s) => s.id !== step.id);
  while (others.some((o) => overlaps({ ...spot, h: heightOf(made) }, o))) spot = { ...spot, y: spot.y + 40 };
  return all.map((s) => (s.id === step.id ? { ...s, pos: spot } : s));
}

/** How much goes with a step if removed: a choice takes its branches, unless something else still leads there. */
export function removalCount(steps: BotStep[], id: string): number {
  return steps.length - removeStep(steps, id).length;
}

/**
 * Removes a step. A step with one path is lifted out and the path closes up. A choice has no single path to close up, so its
 * branches go with it. The first step can only go if it has one path to hand over to.
 */
export function removeStep(steps: BotStep[], id: string): BotStep[] {
  const s = steps.find((x) => x.id === id);
  if (!s) return steps;
  const onward = !noPaths(s) && s.type !== 'choice' ? s.next || END_STEP : END_STEP;
  if (steps[0]?.id === id && !steps.some((x) => x.id === onward)) return steps;
  const before = reachable(steps);
  const redirect = (t: string) => (t === id ? onward : t);
  const relinked = steps.filter((x) => x.id !== id).map((x) => ({ ...x, next: redirect(x.next), options: x.options.map((o) => ({ ...o, next: redirect(o.next) })) }));
  const ordered = steps[0]?.id === id ? [relinked.find((x) => x.id === onward)!, ...relinked.filter((x) => x.id !== onward)] : relinked;
  const after = reachable(ordered);
  // what only this step led to goes too; steps already unconnected stay for the person to deal with
  return ordered.filter((x) => after.has(x.id) || !before.has(x.id));
}

/* ---------------------------------- undo ---------------------------------- */

const HISTORY_LIMIT = 60;
export interface History { past: BotStep[][]; future: BotStep[][]; group: string }
export const emptyHistory: History = { past: [], future: [], group: '' };

/** Note the state before a change. Changes in the same group, like typing in one box, undo together. */
export function record(h: History, before: BotStep[], group = ''): History {
  if (group && h.group === group) return { ...h, future: [] };
  return { past: [...h.past, before].slice(-HISTORY_LIMIT), future: [], group };
}
export function undo(h: History, present: BotStep[]): { history: History; steps: BotStep[] } | null {
  const steps = h.past[h.past.length - 1];
  if (!steps) return null;
  return { steps, history: { past: h.past.slice(0, -1), future: [present, ...h.future], group: '' } };
}
export function redo(h: History, present: BotStep[]): { history: History; steps: BotStep[] } | null {
  const steps = h.future[0];
  if (!steps) return null;
  return { steps, history: { past: [...h.past, present], future: h.future.slice(1), group: '' } };
}
