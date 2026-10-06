/**
 * Copilot context — what the user has open (lead card, WhatsApp chat, call) flows into the
 * system prompt ("Current context"), the drawer's context chip and its quick prompts.
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_QUICK_PROMPTS,
  CONTEXT_NOTE_MAX,
  GENERAL_QUICK_PROMPTS,
  LEAD_QUICK_PROMPTS,
  SYSTEM_PROMPT,
  contextLabel,
  describeContext,
  maskPhone,
  quickPromptsFor,
  type ToolContext,
} from '../src/modules/ai/copilotTools';
import type { CopilotContext } from '../src/modules/ai/copilotContext';
import { F, STAGES, SITE_VISIT } from '../src/core/config';
import type { Lead } from '../src/types/crm';

const mk = (over: Partial<Lead>): Lead => ({
  [F.ID]: 'ENQ-0001',
  [F.ENQUIRY_DATE]: '2026-09-10T05:00:00.000Z',
  [F.NAME]: 'Test',
  [F.PHONE]: '+91 98490 12345',
  Email: '',
  [F.STAGE]: STAGES.NEW,
  [F.SOURCE]: 'Website',
  [F.UNIT_TYPE]: '2 BHK',
  [F.PURCHASE_OR_RENT]: 'Purchase',
  [F.SITE_VISIT_STATUS]: SITE_VISIT.PROSPECT,
  [F.NEXT_FOLLOWUP]: '',
  [F.NOTES]: '',
  [F.RM]: 'Rahul',
  [F.BROCHURE]: 'No',
  [F.RELATIONSHIP]: 'Self',
  [F.ENQUIRED_FOR]: 'Self',
  ...over,
});

const leads: Lead[] = [
  mk({
    [F.ID]: 'ENQ-0003',
    [F.NAME]: 'Rahul Verma',
    [F.PHONE]: '+91 90000 11111',
    [F.STAGE]: STAGES.WARM,
    [F.UNIT_TYPE]: '2.5 BHK',
    [F.RM]: 'Priya',
    [F.SOURCE]: 'Instagram',
    [F.NEXT_FOLLOWUP]: '2026-10-03 11:00',
    'Follow-up 1': '2026-09-20 10:00 — first call',
    'Follow-up 2': '2026-09-25 18:00 — brochure sent',
    'Follow-up 3': '2026-09-28 12:00 — son wants a visit',
    'Follow-up 4': '2026-09-30 17:00 — visit fixed for Saturday',
  }),
  mk({ [F.ID]: 'ENQ-0009', [F.NAME]: 'Lakshmi Rao', [F.PHONE]: '98480 22222' }),
];

const now = new Date('2026-10-01T18:00:00Z');
const withContext = (context?: CopilotContext): ToolContext => ({ leads, tasks: [], inventory: [], now, currentUser: 'Priya', context });

describe('describeContext', () => {
  it('summarises the open lead with a masked phone and the last three follow-ups', () => {
    const d = describeContext(withContext({ view: 'lead', leadId: 'ENQ-0003' }));
    expect(d).toMatch(/^Current context/);
    expect(d).toContain('ENQ-0003 · Rahul Verma');
    expect(d).toContain('Stage: Warm');
    expect(d).toContain('Unit type: 2.5 BHK');
    expect(d).toContain('RM: Priya');
    expect(d).toContain('Next follow-up: 03 Oct 2026, 11:00 AM');
    expect(d).toContain('ending 1111');
    expect(d).not.toMatch(/90000\s?11111/); // never the full number
    expect(d).not.toContain('first call'); // only the last three entries
    expect(d.indexOf('brochure sent')).toBeLessThan(d.indexOf('son wants a visit'));
    expect(d.indexOf('son wants a visit')).toBeLessThan(d.indexOf('visit fixed for Saturday'));
    expect(d).toContain('get_lead_details with lead_id "ENQ-0003"');
  });

  it('passes the view note through verbatim (and caps a huge one)', () => {
    const note = 'Customer: Is the pool heated?\nAmaya (Priya): Yes — it is a temperature-controlled indoor pool.';
    expect(describeContext(withContext({ view: 'chat', leadId: 'ENQ-0003', note }))).toContain(`<<<\n${note}\n>>>`);
    const huge = 'x'.repeat(CONTEXT_NOTE_MAX) + 'TAIL';
    const capped = describeContext(withContext({ note: huge }));
    expect(capped).toContain('…(truncated)');
    expect(capped).not.toContain('TAIL');
  });

  it('matches a WhatsApp chat to its enquiry by phone, or describes the number masked', () => {
    const matched = describeContext(withContext({ view: 'chat', chatPhone: '919848022222' }));
    expect(matched).toContain('ENQ-0009 · Lakshmi Rao');
    expect(matched).toContain("matched by the chat's phone number");
    const unknown = describeContext(withContext({ view: 'chat', chatPhone: '919876543210' }));
    expect(unknown).toContain('number ending 3210');
    expect(unknown).toContain('no matching enquiry');
    expect(unknown).not.toContain('9876543210');
  });

  it('mentions a call record and an enquiry that is not loaded', () => {
    expect(describeContext(withContext({ view: 'call', callId: 'CALL-0042' }))).toContain('Call record: CALL-0042');
    expect(describeContext(withContext({ leadId: 'ENQ-0999' }))).toContain('ENQ-0999 (not in the loaded data');
  });

  it('is empty without a context', () => {
    expect(describeContext(withContext())).toBe('');
    expect(describeContext(withContext({}))).toBe('');
  });

  it('lands at the end of the system prompt, after the approved knowledge', () => {
    const p = SYSTEM_PROMPT(withContext({ view: 'lead', leadId: 'ENQ-0003' }));
    expect(p.indexOf('Current context')).toBeGreaterThan(p.indexOf('=== END OF APPROVED AMAYA KNOWLEDGE ==='));
    expect(p).toContain('ENQ-0003 · Rahul Verma');
  });
});

describe('maskPhone / contextLabel', () => {
  it('masks to the last four digits', () => {
    expect(maskPhone('+91 98490 12345')).toBe('ending 2345');
    expect(maskPhone('12')).toBe('');
    expect(maskPhone(undefined)).toBe('');
  });

  it('labels the drawer chip', () => {
    expect(contextLabel({ view: 'lead', leadId: 'ENQ-0003' }, leads)).toBe('ENQ-0003 · Rahul Verma');
    expect(contextLabel({ view: 'chat', leadId: 'ENQ-0003', chatPhone: '919000011111' }, leads)).toBe('WhatsApp · Rahul Verma');
    expect(contextLabel({ view: 'chat', chatPhone: '919876543210' }, leads)).toBe('WhatsApp · number ending 3210');
    expect(contextLabel({ view: 'call', callId: 'CALL-0042' }, leads)).toBe('Call CALL-0042');
    expect(contextLabel({}, leads)).toBeNull();
    expect(contextLabel(undefined, leads)).toBeNull();
  });
});

describe('quickPromptsFor', () => {
  const texts = (c?: CopilotContext) => quickPromptsFor(c).map((p) => p.text);

  it('offers lead prompts with a lead open', () => {
    expect(texts({ view: 'lead', leadId: 'ENQ-0003' })).toEqual([...LEAD_QUICK_PROMPTS, ...GENERAL_QUICK_PROMPTS]);
    expect(quickPromptsFor({ leadId: 'ENQ-0003' }).filter((p) => p.contextual).map((p) => p.text)).toEqual(LEAD_QUICK_PROMPTS);
  });

  it('offers chat prompts with a chat open (even inside a lead)', () => {
    expect(texts({ view: 'chat', chatPhone: '919000011111' })).toEqual([...CHAT_QUICK_PROMPTS, ...GENERAL_QUICK_PROMPTS]);
    expect(texts({ view: 'chat', leadId: 'ENQ-0003', chatPhone: '919000011111' })).toEqual([...CHAT_QUICK_PROMPTS, ...GENERAL_QUICK_PROMPTS]);
  });

  it('always offers the general prompts', () => {
    expect(texts()).toEqual(GENERAL_QUICK_PROMPTS);
    expect(texts({ view: 'dashboard' })).toEqual(GENERAL_QUICK_PROMPTS);
    expect(GENERAL_QUICK_PROMPTS).toEqual(['Why Amaya? (3 lines)', 'Monthly package for a 2 BHK couple', 'Distance from Amaya to the airport']);
  });
});
