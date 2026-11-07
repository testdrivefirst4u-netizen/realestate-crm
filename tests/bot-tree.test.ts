/** The chatbot map: it never changes what a bot does, its layout, and adding or removing steps. */
import { describe, expect, it } from 'vitest';
import { END_STEP, botProblems, replyToChat, sameFlow, startChat, type BotStep } from '../src/core/botEngine';
import { NODE_W, addStep, arrange, emptyHistory, explicitSteps, heightOf, insertStep, mapOrder, record, redo, removalCount, removeStep, setExit, setPosition, unconnectedSteps, undo, withPositions } from '../src/modules/chatbots/botTree';

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

const noOverlap = (steps: BotStep[]) => {
  for (const x of steps) for (const y of steps) {
    if (x === y) continue;
    const apart = x.pos!.x + NODE_W <= y.pos!.x || y.pos!.x + NODE_W <= x.pos!.x || x.pos!.y + heightOf(x) <= y.pos!.y || y.pos!.y + heightOf(y) <= x.pos!.y;
    expect(apart, `${x.id} and ${y.id}`).toBe(true);
  }
};

describe('arranging the map', () => {
  it('gives every step a place, children to the right of their parent', () => {
    const s = arrange(explicitSteps(OLD));
    expect(s.every((x) => x.pos)).toBe(true);
    const at = (id: string) => s.find((x) => x.id === id)!.pos!;
    expect(at('name').x).toBeGreaterThan(at('hi').x);
    expect(at('visit').x).toBeGreaterThan(at('unit').x);
    noOverlap(s);
  });
  it('a big branching bot does not overlap, even with a long list of options', () => {
    const many = Array.from({ length: 10 }, (_, i) => opt(`m${i}`, `Option ${i}`, END_STEP));
    noOverlap(arrange(explicitSteps([
      step('q', 'choice', { options: [opt('1', 'A', 'a'), opt('2', 'B', 'b'), opt('3', 'C', 'c')] }),
      step('a', 'choice', { options: [opt('4', 'A1', 'a1'), opt('5', 'A2', 'a2')] }), step('a1', 'end'), step('a2', 'message', { next: 'x' }), step('x', 'end'),
      step('b', 'choice', { options: many }), step('c', 'choice', { options: [opt('6', 'C1', 'y'), opt('7', 'C2', 'q')] }), step('y', 'end'),
    ])));
  });
  it('keeps a parent centred on its children', () => {
    const s = arrange(explicitSteps([step('m', 'message', { next: 'c' }), step('c', 'choice', { options: [opt('1', 'A', 'x'), opt('2', 'B', 'y')] }), step('x', 'end'), step('y', 'end')]));
    const mid = (id: string) => { const v = s.find((z) => z.id === id)!; return v.pos!.y + heightOf(v) / 2; };
    expect(mid('c')).toBeCloseTo((mid('x') + mid('y')) / 2);
  });
  it('loops and shared steps do not trip it up', () => {
    noOverlap(arrange(explicitSteps([step('a', 'choice', { options: [opt('1', 'Again', 'a'), opt('2', 'End', 'b'), opt('3', 'Also', 'b')] }), step('b', 'end')])));
  });
  it('steps nothing leads to still get a place, and are pointed out', () => {
    const s = arrange([step('a', 'end'), step('b', 'message')]);
    noOverlap(s);
    expect(unconnectedSteps(s)).toEqual(['b']);
  });
  it('a bot arranged once keeps where its boxes were moved', () => {
    const s = setPosition(arrange(explicitSteps(OLD)), 'visit', { x: 999, y: 888 });
    expect(withPositions(s).find((x) => x.id === 'visit')!.pos).toEqual({ x: 999, y: 888 });
  });
  it('an old bot with no places gets them', () => {
    expect(withPositions(explicitSteps(OLD)).every((x) => x.pos)).toBe(true);
  });
  it('moving boxes changes nothing the customer sees', async () => {
    const before = explicitSteps(OLD);
    const moved = before.map((x, i) => ({ ...x, pos: { x: 1000 - i * 50, y: i * 7 } }));
    const run = (steps: BotStep[]) => startChat({ steps }, engine).out;
    expect(run(moved)).toEqual(run(before));
    expect(botProblems({ steps: moved })).toEqual([]);
  });
});

describe('telling whether a bot still behaves the same', () => {
  const base = () => explicitSteps(OLD);
  it('moved boxes are the same', () => expect(sameFlow(OLD, arrange(base()))).toBe(true));
  it('a bot saved before paths were written out is the same', () => expect(sameFlow(OLD, base())).toBe(true));
  it('steps in another order are the same', () => expect(sameFlow(base(), [base()[0], ...base().slice(1).reverse()])).toBe(true));
  it('different words are not', () => expect(sameFlow(base(), base().map((s) => (s.id === 'hi' ? { ...s, text: 'Other' } : s)))).toBe(false));
  it('a different path is not', () => expect(sameFlow(base(), setExit(base(), { stepId: 'hi' }, 'team'))).toBe(false));
  it('a renamed option is not', () => expect(sameFlow(base(), base().map((s) => (s.id === 'unit' ? { ...s, options: s.options.map((o) => ({ ...o, label: 'New' })) } : s)))).toBe(false));
  it('another first step is not', () => expect(sameFlow(base(), [base()[1], base()[0], ...base().slice(2)])).toBe(false));
  it('a step more is not', () => expect(sameFlow(base(), [...base(), step('z', 'end')])).toBe(false));
});

describe('adding a step gives it a place', () => {
  const line = () => arrange(explicitSteps([step('a', 'message'), step('b', 'message'), step('c', 'end')]));
  it('where it was dropped', () => {
    const s = addStep(line(), { stepId: 'b' }, step('n', 'message'), { x: 5000, y: 5000 });
    expect(s.find((x) => x.id === 'n')!.pos).toEqual({ x: 5000, y: 5000 });
  });
  it('on a line, between the two, moving what follows along', () => {
    const before = line();
    const s = addStep(before, { stepId: 'a' }, step('n', 'message'));
    noOverlap(s);
    const x = (id: string) => s.find((v) => v.id === id)!.pos!.x;
    expect(x('a')).toBeLessThan(x('n'));
    expect(x('n')).toBeLessThan(x('b'));
    expect(x('b')).toBeLessThan(x('c'));
  });
  it('never on top of another box', () => {
    const s = arrange(explicitSteps([step('c', 'choice', { options: [opt('1', 'A', 'x'), opt('2', 'B', END_STEP)] }), step('x', 'end')]));
    noOverlap(addStep(s, { stepId: 'c', optionId: '2' }, step('n', 'message')));
  });
  it('a drop on top of a box moves clear of it', () => {
    const s = line();
    noOverlap(addStep(s, { stepId: 'a' }, step('n', 'message'), { ...s[1].pos! }));
  });
  it('keeps the links right', () => {
    const s = addStep(line(), { stepId: 'a' }, step('n', 'message'));
    expect(s.find((x) => x.id === 'a')!.next).toBe('n');
    expect(s.find((x) => x.id === 'n')!.next).toBe('b');
  });
});

describe('removing a line', () => {
  it('leaves that path open, and what it led to unconnected', () => {
    const s = setExit(explicitSteps([step('a', 'message'), step('b', 'end')]), { stepId: 'a' }, END_STEP);
    expect(s[0].next).toBe(END_STEP);
    expect(unconnectedSteps(s)).toEqual(['b']);
  });
});

describe('undo', () => {
  const v = (id: string) => [step(id, 'end')];
  it('goes back and forward', () => {
    let h = record(emptyHistory, v('a'));
    const back = undo(h, v('b'))!;
    expect(back.steps).toEqual(v('a'));
    h = back.history;
    expect(undo(h, back.steps)).toBeNull();
    const again = redo(h, back.steps)!;
    expect(again.steps).toEqual(v('b'));
    expect(redo(again.history, again.steps)).toBeNull();
  });
  it('a new change clears what could be redone', () => {
    const back = undo(record(emptyHistory, v('a')), v('b'))!;
    expect(record(back.history, back.steps).future).toEqual([]);
  });
  it('typing in one box undoes as one change', () => {
    let h = record(emptyHistory, v('a'), 'edit:x');
    h = record(h, v('b'), 'edit:x');
    h = record(h, v('c'), 'edit:x');
    expect(h.past).toEqual([v('a')]);
    expect(record(h, v('d'), 'edit:y').past).toHaveLength(2);
  });
  it('undoing ends the group, so more typing is a new change', () => {
    const h = record(emptyHistory, v('a'), 'edit:x');
    const back = undo(h, v('b'))!;
    expect(record(back.history, back.steps, 'edit:x').past).toHaveLength(1);
  });
  it('remembers a limited number of changes', () => {
    let h = emptyHistory;
    for (let i = 0; i < 100; i++) h = record(h, v(String(i)));
    expect(h.past).toHaveLength(60);
    expect(h.past[59]).toEqual(v('99'));
  });
  it('brings back a removed branch exactly', () => {
    const s = arrange(explicitSteps(OLD));
    const h = record(emptyHistory, s);
    expect(undo(h, removeStep(s, 'unit'))!.steps).toEqual(s);
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
    expect(unconnectedSteps(s)).toEqual(['b']);
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
