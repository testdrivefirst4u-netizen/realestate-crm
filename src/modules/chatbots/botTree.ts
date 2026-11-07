/** The chatbot as a map: where each step sits, how the paths connect, and adding or removing steps. No screen code, so it can be tested. */
import { END_STEP, type BotStep } from '../../core/botEngine';

export const NODE_W = 236;
export const NODE_H = 104;
const GAP_X = 28;
const GAP_Y = 76;
const PILL_W = 132;

/** A way out of a step: its only path, or one option of a choice. */
export interface Exit { stepId: string; optionId?: string }
export interface MapNode { key: string; kind: 'step' | 'end' | 'jump'; stepId: string; x: number; y: number; w: number; h: number; number: number }
export interface MapEdge { key: string; fromKey: string; toKey: string; label: string; exit: Exit }
export interface BotMap { nodes: MapNode[]; edges: MapEdge[]; width: number; height: number; unconnected: string[] }

const noPaths = (s: BotStep) => s.type === 'handoff' || s.type === 'end';

/** Every path written out, so moving things around cannot change where anything goes. "Blank" used to mean the following step. */
export function explicitSteps(steps: BotStep[]): BotStep[] {
  return steps.map((s, i) => {
    const after = steps[i + 1]?.id || END_STEP;
    if (noPaths(s)) return { ...s, next: '' };
    if (s.type === 'choice') return { ...s, next: '', options: s.options.map((o) => ({ ...o, next: o.next || s.next || after })) };
    return { ...s, next: s.next || after };
  });
}

function exitsOf(s: BotStep): Array<{ exit: Exit; label: string; target: string }> {
  if (noPaths(s)) return [];
  if (s.type === 'choice') return s.options.map((o) => ({ exit: { stepId: s.id, optionId: o.id }, label: o.label || 'Option', target: o.next || END_STEP }));
  return [{ exit: { stepId: s.id }, label: '', target: s.next || END_STEP }];
}

/**
 * Lays the steps out as a tree from the first one. Each step sits once; a path back to one already placed shows as a small
 * "Goes to step 3" tag, so lines never cross the map. Parents sit centred over their children.
 */
export function layoutBot(steps: BotStep[]): BotMap {
  const nodes: MapNode[] = [];
  const edges: MapEdge[] = [];
  const placed = new Set<string>();
  const numberOf = new Map(steps.map((s, i) => [s.id, i + 1]));
  let cursor = 0;
  let deepest = 0;
  let n = 0;

  const leaf = (kind: 'end' | 'jump', target: string, depth: number): MapNode => {
    const node: MapNode = { key: `${kind}${n++}`, kind, stepId: target, x: cursor, y: depth * (NODE_H + GAP_Y), w: PILL_W, h: 44, number: numberOf.get(target) || 0 };
    cursor += PILL_W + GAP_X;
    nodes.push(node);
    deepest = Math.max(deepest, node.y + node.h);
    return node;
  };
  const place = (step: BotStep, depth: number): MapNode => {
    placed.add(step.id);
    const node: MapNode = { key: step.id, kind: 'step', stepId: step.id, x: 0, y: depth * (NODE_H + GAP_Y), w: NODE_W, h: NODE_H, number: numberOf.get(step.id) || 0 };
    nodes.push(node);
    deepest = Math.max(deepest, node.y + node.h);
    const kids: MapNode[] = [];
    for (const { exit, label, target } of exitsOf(step)) {
      const next = steps.find((s) => s.id === target);
      const child = !next ? leaf('end', END_STEP, depth + 1) : placed.has(target) ? leaf('jump', target, depth + 1) : place(next, depth + 1);
      kids.push(child);
      edges.push({ key: `${step.id}:${exit.optionId || 'next'}`, fromKey: node.key, toKey: child.key, label, exit });
    }
    if (kids.length) {
      const left = kids[0].x + kids[0].w / 2;
      const right = kids[kids.length - 1].x + kids[kids.length - 1].w / 2;
      node.x = Math.max((left + right) / 2 - NODE_W / 2, 0);
      // a lone narrow child: make sure the next branch clears this box
      cursor = Math.max(cursor, node.x + NODE_W + GAP_X);
    } else {
      node.x = cursor;
      cursor += NODE_W + GAP_X;
    }
    return node;
  };
  if (steps[0]) place(steps[0], 0);
  return {
    nodes, edges, width: Math.max(cursor, NODE_W), height: deepest,
    unconnected: steps.filter((s) => !placed.has(s.id)).map((s) => s.id),
  };
}

const targetOf = (steps: BotStep[], e: Exit): string => {
  const s = steps.find((x) => x.id === e.stepId);
  if (!s) return END_STEP;
  if (e.optionId) return s.options.find((o) => o.id === e.optionId)?.next || END_STEP;
  return s.next || END_STEP;
};

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

/** Point one way out at another step. */
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

/** How much goes with a step if removed: a choice takes its branches, unless something else still leads there. */
export function removalCount(steps: BotStep[], id: string): number {
  const r = removeStep(steps, id);
  return steps.length - r.length;
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
