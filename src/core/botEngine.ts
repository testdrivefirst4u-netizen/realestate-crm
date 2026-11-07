/**
 * The chatbot's logic with no database or network, so the same code runs real chats and the test screen.
 * Given a bot, where a chat has got to and what the customer just said, it says what to send and what to do.
 * WhatsApp's own limits are enforced here: 3 buttons of 20 characters, or 10 list rows of 24.
 */

export type StepType = 'message' | 'question' | 'choice' | 'visit' | 'ai' | 'handoff' | 'end';
export type SaveTo = '' | 'name' | 'email' | 'unit' | 'city' | 'budget' | 'purpose' | 'notes';
export const SAVE_TO: SaveTo[] = ['', 'name', 'email', 'unit', 'city', 'budget', 'purpose', 'notes'];

export interface BotOption { id: string; label: string; next: string }
export interface BotStep {
  id: string; type: StepType; text: string;
  /** Where to go after this; empty = the following step. */
  next: string;
  saveTo: SaveTo;
  validate: 'text' | 'email' | 'number';
  options: BotOption[];
  /** Site visit: how many days ahead to offer, and the times. */
  days: number; times: string[];
}
export interface BotDefinition { steps: BotStep[] }

/** A path that ends here: the chat finishes. */
export const END_STEP = '__end__';
export const MAX_STEPS = 40;
export const MAX_BUTTONS = 3;
export const MAX_ROWS = 10;
export const BUTTON_CHARS = 20;
export const ROW_CHARS = 24;
const TEXT_CHARS = 1024;
const MAX_AUTO_STEPS = 12;
const MAX_RETRIES = 2;
const MAX_AI_REPLIES = 6;
export const MAX_SENT_PER_CHAT = 60;

export type Outgoing =
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; options: Array<{ id: string; label: string }> }
  | { kind: 'list'; text: string; button: string; options: Array<{ id: string; label: string }> };

export type Effect =
  | { type: 'save'; field: SaveTo; value: string }
  | { type: 'visit'; day: string; time: string; label: string };

export interface ChatState { stepId: string; phase: '' | 'day' | 'time'; day: string; retries: number; aiReplies: number; sent: number; vars: Record<string, string> }
export type ChatStatus = 'active' | 'done' | 'handoff' | 'stopped';
export interface StepResult { out: Outgoing[]; state: ChatState; effects: Effect[]; status: ChatStatus; reason: string }
export interface StepContext { now: Date; company: string; ai?: (question: string) => Promise<string>; dateKey: (d: Date) => string }

export const STOP_WORDS = /^\s*(stop|unsubscribe|opt\s*out|cancel|block)\s*[.!]*\s*$/i;
const PERSON_WORDS = /\b(agent|human|real person|talk to (someone|a person)|executive|representative|call me|speak to|customer care)\b/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HANDOFF_TEXT = 'Thank you. Someone from our team will get back to you shortly.';

const initialState = (stepId: string, vars: Record<string, string> = {}): ChatState => ({ stepId, phase: '', day: '', retries: 0, aiReplies: 0, sent: 0, vars });

function fill(text: string, vars: Record<string, string>, ctx: StepContext): string {
  const all: Record<string, string> = { ...vars, company: ctx.company, first_name: String(vars.name || '').trim().split(/\s+/)[0] || '' };
  return String(text || '').replace(/\{(\w+)\}/g, (_, k) => all[k] ?? '').replace(/[ \t]{2,}/g, ' ').trim();
}

function following(def: BotDefinition, step: BotStep, chosen?: string): string {
  if (chosen) return chosen;
  if (step.next) return step.next;
  const i = def.steps.findIndex((s) => s.id === step.id);
  return def.steps[i + 1]?.id || '';
}

function labelTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t);
  if (!m) return t;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86400000);
const labelDay = (key: string) => new Date(`${key}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

/** Buttons when they fit, a list when they do not. */
function offer(text: string, options: Array<{ id: string; label: string }>): Outgoing {
  if (options.length <= MAX_BUTTONS && options.every((o) => o.label.length <= BUTTON_CHARS)) return { kind: 'buttons', text, options };
  return { kind: 'list', text, button: 'Choose', options: options.slice(0, MAX_ROWS) };
}
function matchOption<T extends { id: string; label: string }>(options: T[], reply: { text: string; replyId: string }): T | null {
  if (reply.replyId) {
    const byId = options.find((o) => o.id === reply.replyId);
    if (byId) return byId;
  }
  const said = reply.text.trim().toLowerCase();
  if (!said) return null;
  const n = /^\d+$/.test(said) ? Number(said) : 0;
  if (n >= 1 && n <= options.length) return options[n - 1];
  return options.find((o) => o.label.trim().toLowerCase() === said) || null;
}
const dayOptions = (step: BotStep, ctx: StepContext) => Array.from({ length: Math.min(step.days || 7, MAX_ROWS) }, (_, i) => {
  const key = ctx.dateKey(addDays(ctx.now, i + 1)); // from tomorrow: no one is offered a time already gone
  return { id: `d:${key}`, label: labelDay(key).slice(0, ROW_CHARS) };
});
const timeOptions = (step: BotStep) => (step.times.length ? step.times : ['11:00', '15:00', '17:00']).map((t) => ({ id: `t:${t}`, label: labelTime(t) }));

/** Send steps from here until one waits for the customer, or the chat ends. */
function runFrom(def: BotDefinition, startId: string, state: ChatState, ctx: StepContext, out: Outgoing[], effects: Effect[]): StepResult {
  let id = startId;
  const s = { ...state, phase: '' as const, retries: 0, day: '' };
  for (let i = 0; i < MAX_AUTO_STEPS; i++) {
    const step = def.steps.find((x) => x.id === id);
    if (!step) return { out, state: s, effects, status: 'done', reason: 'finished' };
    s.stepId = step.id;
    const text = fill(step.text, s.vars, ctx);
    switch (step.type) {
      case 'message':
        if (text) out.push({ kind: 'text', text });
        id = following(def, step);
        continue;
      case 'question':
      case 'ai':
        if (text) out.push({ kind: 'text', text });
        return { out, state: s, effects, status: 'active', reason: '' };
      case 'choice':
        out.push(offer(text, step.options.map((o) => ({ id: o.id, label: o.label }))));
        return { out, state: s, effects, status: 'active', reason: '' };
      case 'visit':
        out.push(offer(text || 'Which day suits you for a site visit?', dayOptions(step, ctx)));
        return { out, state: { ...s, phase: 'day' }, effects, status: 'active', reason: '' };
      case 'handoff':
        out.push({ kind: 'text', text: text || HANDOFF_TEXT });
        return { out, state: s, effects, status: 'handoff', reason: 'The bot handed this chat to the team.' };
      case 'end':
        if (text) out.push({ kind: 'text', text });
        return { out, state: s, effects, status: 'done', reason: 'finished' };
    }
  }
  return { out, state: s, effects, status: 'handoff', reason: 'The bot went round in a circle, so it stopped.' };
}

export function startChat(def: BotDefinition, ctx: StepContext, vars: Record<string, string> = {}): StepResult {
  const first = def.steps[0];
  if (!first) return { out: [], state: initialState(''), effects: [], status: 'done', reason: 'finished' };
  return runFrom(def, first.id, initialState(first.id, vars), ctx, [], []);
}

/** The customer said something. */
export async function replyToChat(def: BotDefinition, state: ChatState, reply: { text: string; replyId: string }, ctx: StepContext): Promise<StepResult> {
  const out: Outgoing[] = [];
  const effects: Effect[] = [];
  const s: ChatState = { ...state, vars: { ...state.vars } };
  const text = reply.text.trim();
  if (STOP_WORDS.test(text)) return { out, state: s, effects, status: 'stopped', reason: 'The customer asked to stop.' };
  if (PERSON_WORDS.test(text)) {
    out.push({ kind: 'text', text: HANDOFF_TEXT });
    return { out, state: s, effects, status: 'handoff', reason: 'The customer asked for a person.' };
  }
  if (s.sent >= MAX_SENT_PER_CHAT) {
    out.push({ kind: 'text', text: HANDOFF_TEXT });
    return { out, state: s, effects, status: 'handoff', reason: 'This chat reached the limit of bot messages.' };
  }
  const step = def.steps.find((x) => x.id === s.stepId);
  if (!step) return { out, state: s, effects, status: 'done', reason: 'finished' };

  const retry = (message: string, again?: Outgoing): StepResult => {
    if (s.retries >= MAX_RETRIES) {
      out.push({ kind: 'text', text: HANDOFF_TEXT });
      return { out, state: s, effects, status: 'handoff', reason: 'The bot could not understand the answer.' };
    }
    s.retries += 1;
    out.push(again || { kind: 'text', text: message });
    return { out, state: s, effects, status: 'active', reason: '' };
  };

  switch (step.type) {
    case 'question': {
      if (!text) return retry('Please type your answer.');
      if (step.validate === 'email' && !EMAIL.test(text)) return retry('That does not look like an e-mail address. Please type it again.');
      if (step.validate === 'number' && !/\d/.test(text)) return retry('Please answer with a number.');
      const value = text.slice(0, 300);
      if (step.saveTo) {
        s.vars[step.saveTo] = value;
        effects.push({ type: 'save', field: step.saveTo, value });
      }
      return runFrom(def, following(def, step), s, ctx, out, effects);
    }
    case 'choice': {
      const picked = matchOption(step.options, reply);
      if (!picked) return retry('', offer('Please choose one of these.', step.options.map((o) => ({ id: o.id, label: o.label }))));
      if (step.saveTo) {
        s.vars[step.saveTo] = picked.label;
        effects.push({ type: 'save', field: step.saveTo, value: picked.label });
      }
      return runFrom(def, following(def, step, picked.next), s, ctx, out, effects);
    }
    case 'visit': {
      if (s.phase === 'time') {
        const picked = matchOption(timeOptions(step), reply);
        if (!picked) return retry('', offer('Please choose a time.', timeOptions(step)));
        const time = picked.id.slice(2);
        const label = `${labelDay(s.day)} at ${labelTime(time)}`;
        s.vars.visit = label;
        effects.push({ type: 'visit', day: s.day, time, label });
        return runFrom(def, following(def, step), s, ctx, out, effects);
      }
      const days = dayOptions(step, ctx);
      const picked = matchOption(days, reply);
      if (!picked) return retry('', offer('Please choose a day.', days));
      s.day = picked.id.slice(2);
      s.phase = 'time';
      s.retries = 0;
      out.push(offer('What time suits you?', timeOptions(step)));
      return { out, state: s, effects, status: 'active', reason: '' };
    }
    case 'ai': {
      if (!text) return retry('Please type your question.');
      let answer = '';
      try {
        answer = ctx.ai ? String(await ctx.ai(text.slice(0, 500))).trim() : '';
      } catch {
        answer = '';
      }
      if (!answer || /HANDOFF/.test(answer)) {
        out.push({ kind: 'text', text: HANDOFF_TEXT });
        return { out, state: s, effects, status: 'handoff', reason: 'The AI could not answer this from the information it has.' };
      }
      out.push({ kind: 'text', text: answer.slice(0, TEXT_CHARS) });
      s.aiReplies += 1;
      if (s.aiReplies >= MAX_AI_REPLIES) {
        const next = following(def, step);
        if (next) return runFrom(def, next, s, ctx, out, effects);
        out.push({ kind: 'text', text: HANDOFF_TEXT });
        return { out, state: s, effects, status: 'handoff', reason: 'The customer had many questions.' };
      }
      return { out, state: s, effects, status: 'active', reason: '' };
    }
    default:
      return runFrom(def, following(def, step), s, ctx, out, effects);
  }
}

/* ------------------------------ checking a bot ----------------------------- */

const WAITS: StepType[] = ['question', 'choice', 'visit', 'ai'];

/** What stops a bot being started, each in words an Admin can act on. */
export function botProblems(def: BotDefinition): string[] {
  const p: string[] = [];
  const steps = def.steps;
  if (!steps.length) return ['Add at least one step.'];
  if (steps.length > MAX_STEPS) p.push(`A bot can have up to ${MAX_STEPS} steps.`);
  const ids = new Set(steps.map((s) => s.id));
  const nameOf = (s: BotStep) => `Step ${steps.indexOf(s) + 1}`;
  for (const s of steps) {
    const n = nameOf(s);
    if (s.text.length > TEXT_CHARS) p.push(`${n}: the message can be up to ${TEXT_CHARS} characters.`);
    if (['message', 'question', 'choice', 'ai'].includes(s.type) && !s.text.trim()) p.push(`${n}: write the message.`);
    if (s.next && s.next !== END_STEP && !ids.has(s.next)) p.push(`${n}: it goes to a step that no longer exists.`);
    if (s.type === 'choice') {
      if (s.options.length < 2) p.push(`${n}: give at least 2 options.`);
      if (s.options.length > MAX_ROWS) p.push(`${n}: WhatsApp allows up to ${MAX_ROWS} options.`);
      const longest = s.options.length > MAX_BUTTONS ? ROW_CHARS : Math.max(BUTTON_CHARS, ROW_CHARS);
      for (const o of s.options) {
        if (!o.label.trim()) p.push(`${n}: every option needs a label.`);
        if (o.label.length > longest) p.push(`${n}: “${o.label}” is too long. Options can be up to ${longest} characters.`);
        if (o.next && o.next !== END_STEP && !ids.has(o.next)) p.push(`${n}: “${o.label}” goes to a step that no longer exists.`);
      }
      if (new Set(s.options.map((o) => o.label.trim().toLowerCase())).size !== s.options.length) p.push(`${n}: two options have the same label.`);
    }
    if (s.type === 'visit') {
      if (s.days < 1 || s.days > MAX_ROWS) p.push(`${n}: offer between 1 and ${MAX_ROWS} days.`);
      if (s.times.length > MAX_ROWS) p.push(`${n}: offer up to ${MAX_ROWS} times.`);
      if (s.times.some((t) => !/^([01]?\d|2[0-3]):[0-5]\d$/.test(t))) p.push(`${n}: write times like 11:00 or 15:30.`);
    }
  }
  // steps nothing leads to, and messages that loop without ever waiting for the customer
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (!id || seen.has(id)) return;
    const s = steps.find((x) => x.id === id);
    if (!s) return;
    seen.add(id);
    if (s.type === 'handoff' || s.type === 'end') return;
    if (s.type === 'choice') s.options.forEach((o) => visit(following(def, s, o.next)));
    else visit(following(def, s));
  };
  visit(steps[0].id);
  for (const s of steps) if (!seen.has(s.id)) p.push(`${nameOf(s)}: nothing leads to this step, so no one would ever reach it.`);
  for (const start of steps) {
    let at: BotStep | undefined = start;
    const path = new Set<string>();
    while (at && !WAITS.includes(at.type) && at.type !== 'handoff' && at.type !== 'end') {
      if (path.has(at.id)) {
        p.push(`${nameOf(start)}: these steps go round in a circle without waiting for the customer.`);
        break;
      }
      path.add(at.id);
      const nextId = following(def, at);
      at = steps.find((x) => x.id === nextId);
    }
  }
  return [...new Set(p)];
}
