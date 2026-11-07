/** The chatbot map: it never changes what a bot does, its layout, and adding or removing steps. */
import { describe, expect, it } from 'vitest';
import { END_STEP, botProblems, replyToChat, startChat, type BotStep } from '../src/core/botEngine';
import { NODE_W, explicitSteps, insertStep, layoutBot, mapOrder, removalCount, removeStep, setExit } from '../src/modules/chatbots/botTree';

const step = (id: string, type: BotStep['type'], over: Partial<BotStep> = {}): BotStep => ({ id, type, text: `${id}`, next: '', saveTo: '', validate: 'text', options: [], days: 3, times: ['11:00'], ...over });
const opt = (id: string, label: string, next = '') => ({ id, label, next });
const OLD = [step('hi', 'message'), step('name', 'question'), step('unit', 'choice', { options: [opt('a', '2 BHK'), opt('b', '3 BHK'), opt('c', 'Team', 'team')] }), step('visit', 'visit'), step('team', 'handoff')];
const engine = { now: new Date('2026-11-10T06:30:00Z'), company: 'A', dateKey: (d: Date) => d.toISOString().slice(0, 10) };
const ids = (s: BotStep[]) => s.map((x) => x.id);

describe('writing every path out', () => {
  it('a bot built before the map works exactly the same', async () => {
    const after = explicitSteps(OLD);
    const walk = async (steps: BotStep[], answers: Array<[string, string]>) => {
      const out: unknown[] = [];
      let r = startChat({ steps }, engine);
      out.push(r.out, r.status);
      for (const [text, replyId] of answers) {
        r = await replyToChat({ steps }, r.state, { text, replyId }, engine);
        out.push(r.out, r.status, r.effects);
      }
      return out;
    };
    for (const path of [[['Meera', ''], ['', 'a'], ['', 'd:2026-11-11'], ['', 't:11:00']], [['Meera', ''], ['', 'c']]] as Array<Array<[string, string]>>) {
      expect(await walk(after, path)).toEqual(await walk(OLD, path));
    }
    expect(botProblems({ steps: after })).toEqual([]);
  });
  it('the last step ends the chat, shown as an end', () => {
    expect(explicitSteps([step('a', 'message')])[0].next).toBe(END_STEP);
    expect(startChat({ steps: explicitSteps([step('a', 'message')]) }, engine).status).toBe('done');
  });
  it('a step that already says where it goes keeps that', () => {
    expect(explicitSteps([step('a', 'message', { next: 'c' }), step('b', 'end'), step('c', 'end')])[0].next).toBe('c');
  });
  it('steps that end a path have none', () => {
    expect(explicitSteps([step('a', 'handoff'), step('b', 'end')]).map((s) => s.next)).toEqual(['', '']);
  });
});

describe('the map', () => {
  const m = () => layoutBot(explicitSteps(OLD));
  it('places each step once, with a line for each path', () => {
    const map = m();
    expect(map.nodes.filter((n) => n.kind === 'step').map((n) => n.stepId).sort()).toEqual(ids(OLD).sort());
    expect(map.edges.find((e) => e.exit.optionId === 'a')!.label).toBe('2 BHK');
    expect(map.unconnected).toEqual([]);
  });
  it('a child sits below its parent, and siblings never overlap', () => {
    const map = m();
    for (const e of map.edges) {
      const a = map.nodes.find((n) => n.key === e.fromKey)!, b = map.nodes.find((n) => n.key === e.toKey)!;
      expect(b.y).toBeGreaterThan(a.y);
    }
    const rows = new Map<number, typeof map.nodes>();
    for (const n of map.nodes) rows.set(n.y, [...(rows.get(n.y) || []), n]);
    for (const row of rows.values()) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].w);
    }
  });
  it('a big branching bot still does not overlap', () => {
    const big = explicitSteps([
      step('q', 'choice', { options: [opt('1', 'A', 'a'), opt('2', 'B', 'b'), opt('3', 'C', 'c')] }),
      step('a', 'choice', { options: [opt('4', 'A1', 'a1'), opt('5', 'A2', 'a2')] }), step('a1', 'end'), step('a2', 'message', { next: 'x' }), step('x', 'end'),
      step('b', 'message', { next: END_STEP }), step('c', 'choice', { options: [opt('6', 'C1'), opt('7', 'C2', 'q')] }),
    ]);
    const map = layoutBot(big);
    const rows = new Map<number, typeof map.nodes>();
    for (const n of map.nodes) rows.set(n.y, [...(rows.get(n.y) || []), n]);
    for (const row of rows.values()) {
      const sorted = [...row].sort((a, b) => a.x - b.x);
      for (let i = 1; i < sorted.length; i++) expect(sorted[i].x).toBeGreaterThanOrEqual(sorted[i - 1].x + sorted[i - 1].w);
    }
  });
  it('a path back to an earlier step is a tag, so lines never cross', () => {
    const loop = explicitSteps([step('a', 'choice', { options: [opt('1', 'Again', 'a'), opt('2', 'End', 'b')] }), step('b', 'end')]);
    const jump = layoutBot(loop).nodes.find((n) => n.kind === 'jump')!;
    expect(jump).toMatchObject({ stepId: 'a', number: 1 });
  });
  it('an open path shows where to add a step', () => {
    expect(layoutBot(explicitSteps([step('a', 'message')])).nodes.map((n) => n.kind)).toEqual(['step', 'end']);
    expect(layoutBot([]).nodes).toEqual([]);
  });
  it('points out steps nothing leads to', () => {
    expect(layoutBot([step('a', 'end'), step('b', 'message')]).unconnected).toEqual(['b']);
  });
  it('keeps a parent centred over its children', () => {
    const map = layoutBot(explicitSteps([step('c', 'choice', { options: [opt('1', 'A', 'x'), opt('2', 'B', 'y')] }), step('x', 'end'), step('y', 'end')]));
    const [c, x, y] = ['c', 'x', 'y'].map((k) => map.nodes.find((n) => n.key === k)!);
    expect(c.x + NODE_W / 2).toBeCloseTo((x.x + y.x + NODE_W) / 2);
  });
});

describe('step numbers follow the map', () => {
  it('a step added in the middle takes the next number', () => {
    const s = insertStep(explicitSteps([step('a', 'message'), step('b', 'end')]), { stepId: 'a' }, step('n', 'message'));
    expect(ids(s)).toEqual(['a', 'b', 'n']);
    expect(ids(mapOrder(s))).toEqual(['a', 'n', 'b']);
  });
  it('runs down one branch before the next', () => {
    const s = explicitSteps([step('c', 'choice', { options: [opt('1', 'A', 'x'), opt('2', 'B', 'y')] }), step('y', 'end'), step('x', 'message', { next: 'z' }), step('z', 'end')]);
    expect(ids(mapOrder(s))).toEqual(['c', 'x', 'z', 'y']);
  });
  it('unconnected steps go last and none are lost', () => {
    expect(ids(mapOrder([step('a', 'end'), step('b', 'message'), step('c', 'end')]))).toEqual(['a', 'b', 'c']);
  });
  it('reordering does not change what the bot does', async () => {
    const before = explicitSteps(OLD);
    const shuffled = [before[0], ...before.slice(1).reverse()];
    const run = async (steps: BotStep[]) => {
      const a = startChat({ steps }, engine);
      const b = await replyToChat({ steps }, a.state, { text: 'Meera', replyId: '' }, engine);
      const c = await replyToChat({ steps }, b.state, { text: '', replyId: 'c' }, engine);
      return [a.out, b.out, c.out, c.status, c.effects];
    };
    expect(await run(mapOrder(shuffled))).toEqual(await run(before));
  });
});

describe('adding a step', () => {
  it('in the middle of a path, what came next follows it', () => {
    const s = insertStep(explicitSteps([step('a', 'message'), step('b', 'end')]), { stepId: 'a' }, step('n', 'question'));
    expect(s.find((x) => x.id === 'a')!.next).toBe('n');
    expect(s.find((x) => x.id === 'n')!.next).toBe('b');
    expect(botProblems({ steps: s })).toEqual([]);
  });
  it('on one option, the others stay as they are', () => {
    const s = insertStep(explicitSteps([step('c', 'choice', { options: [opt('1', 'A', 'x'), opt('2', 'B', 'x')] }), step('x', 'end')]), { stepId: 'c', optionId: '1' }, step('n', 'message'));
    expect(s[0].options.map((o) => o.next)).toEqual(['n', 'x']);
    expect(s.find((x) => x.id === 'n')!.next).toBe('x');
  });
  it('a choice carries on down its first option, and the rest end until you add to them', () => {
    const s = insertStep(explicitSteps([step('a', 'message'), step('b', 'end')]), { stepId: 'a' }, step('n', 'choice', { options: [opt('1', 'A'), opt('2', 'B')] }));
    expect(s.find((x) => x.id === 'n')!.options.map((o) => o.next)).toEqual(['b', END_STEP]);
  });
  it('a step that ends a path cuts off what came after it', () => {
    const s = insertStep(explicitSteps([step('a', 'message'), step('b', 'end')]), { stepId: 'a' }, step('n', 'handoff'));
    expect(layoutBot(s).unconnected).toEqual(['b']);
  });
  it('pointing a path at another step', () => {
    const s = setExit(explicitSteps([step('a', 'message'), step('b', 'end'), step('c', 'end')]), { stepId: 'a' }, 'c');
    expect(s[0].next).toBe('c');
  });
});

describe('removing a step', () => {
  const line = () => explicitSteps([step('a', 'message'), step('b', 'question'), step('c', 'end')]);
  it('the path closes up', () => {
    const s = removeStep(line(), 'b');
    expect(ids(s)).toEqual(['a', 'c']);
    expect(s[0].next).toBe('c');
  });
  it('the first step hands over to the next', () => {
    const s = removeStep(line(), 'a');
    expect(ids(s)[0]).toBe('b');
    expect(botProblems({ steps: s })).toEqual([]);
  });
  it('a first step with no single path to hand over cannot go', () => {
    const s = explicitSteps([step('c', 'choice', { options: [opt('1', 'A', 'x'), opt('2', 'B', 'x')] }), step('x', 'end')]);
    expect(removeStep(s, 'c')).toEqual(s);
    expect(removalCount(s, 'c')).toBe(0);
  });
  it('a choice takes its branches, but not what something else still leads to', () => {
    const s = explicitSteps([
      step('a', 'choice', { options: [opt('1', 'Go', 'c'), opt('2', 'Skip', 'z')] }),
      step('c', 'choice', { options: [opt('3', 'P', 'p'), opt('4', 'Z', 'z')] }), step('p', 'end'), step('z', 'end'),
    ]);
    const r = removeStep(s, 'c');
    expect(ids(r)).toEqual(['a', 'z']);
    expect(r[0].options[0].next).toBe(END_STEP);
    expect(removalCount(s, 'c')).toBe(2);
  });
  it('a loop back to the removed step does not leave a broken path', () => {
    const s = explicitSteps([step('a', 'message', { next: 'b' }), step('b', 'choice', { options: [opt('1', 'Again', 'b'), opt('2', 'End', 'c')] }), step('c', 'end')]);
    expect(botProblems({ steps: removeStep(s, 'b') })).toEqual([]);
  });
  it('leaves steps already unconnected for the person to deal with', () => {
    expect(ids(removeStep(explicitSteps([step('a', 'end'), step('b', 'end'), step('c', 'end')]), 'a'))).toContain('c');
  });
});

describe('the end of a path', () => {
  it('is not a broken link', () => {
    expect(botProblems({ steps: [step('a', 'message', { next: END_STEP })] })).toEqual([]);
    expect(botProblems({ steps: [step('c', 'choice', { options: [opt('1', 'A', END_STEP), opt('2', 'B', END_STEP)] })] })).toEqual([]);
  });
  it('finishes the chat when reached', async () => {
    const d = { steps: [step('c', 'choice', { options: [opt('1', 'A', END_STEP), opt('2', 'B', END_STEP)] })] };
    expect(await replyToChat(d, startChat(d, engine).state, { text: 'A', replyId: '' }, engine)).toMatchObject({ status: 'done' });
  });
});
