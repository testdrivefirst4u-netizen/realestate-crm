/**
 * CopilotDrawer render: the context chip and the context-aware quick prompts (server render —
 * no DOM needed; effects such as the prefill auto-send do not run here).
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopilotDrawer, type CopilotDrawerProps } from '../src/modules/ai/CopilotDrawer';
import { CHAT_QUICK_PROMPTS, GENERAL_QUICK_PROMPTS, LEAD_QUICK_PROMPTS } from '../src/modules/ai/copilotTools';
import { F, STAGES, SITE_VISIT } from '../src/core/config';
import type { Lead } from '../src/types/crm';

const leads: Lead[] = [
  {
    [F.ID]: 'ENQ-0003',
    [F.ENQUIRY_DATE]: '2026-10-01 09:00',
    [F.NAME]: 'Rahul Verma',
    [F.PHONE]: '+91 90000 11111',
    Email: '',
    [F.STAGE]: STAGES.WARM,
    [F.SOURCE]: 'Instagram',
    [F.UNIT_TYPE]: '2 BHK',
    [F.PURCHASE_OR_RENT]: 'Purchase',
    [F.SITE_VISIT_STATUS]: SITE_VISIT.PROSPECT,
    [F.NEXT_FOLLOWUP]: '',
    [F.NOTES]: '',
    [F.RM]: 'Priya',
    [F.BROCHURE]: 'No',
    [F.RELATIONSHIP]: 'Self',
    [F.ENQUIRED_FOR]: 'Self',
  },
];

const base: CopilotDrawerProps = {
  isOpen: true,
  onClose: () => {},
  leads,
  tasks: [],
  inventory: [],
  currentUser: null,
  aiConfigured: true,
  aiModel: 'gemini-3.8-flash',
  canAct: true,
  actions: { addTask: async () => null, setLeadStage: async () => true, appendRemark: async () => true, updateLead: async () => null },
  onOpenLead: () => {},
  onShowLeads: () => {},
};
const render = (over: Partial<CopilotDrawerProps> = {}) => renderToStaticMarkup(createElement(CopilotDrawer, { ...base, ...over }));

describe('CopilotDrawer', () => {
  it('shows the open lead as context with its quick prompts above the input', () => {
    const html = render({ context: { view: 'lead', leadId: 'ENQ-0003' } });
    expect(html).toContain('ENQ-0003 · Rahul Verma');
    for (const p of [...LEAD_QUICK_PROMPTS, ...GENERAL_QUICK_PROMPTS]) expect(html).toContain(p);
    for (const p of CHAT_QUICK_PROMPTS) expect(html).not.toContain(p);
    expect(html.indexOf(GENERAL_QUICK_PROMPTS[0])).toBeLessThan(html.indexOf('<textarea'));
  });

  it('offers chat prompts for a WhatsApp conversation', () => {
    const html = render({ context: { view: 'chat', leadId: 'ENQ-0003', chatPhone: '919000011111', note: 'Prospect: Hello' } });
    expect(html).toContain('WhatsApp · Rahul Verma');
    for (const p of CHAT_QUICK_PROMPTS) expect(html).toContain(p);
  });

  it('shows only the general prompts without a context, and none in quick-search mode', () => {
    const plain = render();
    expect(plain).not.toContain('Context:');
    for (const p of GENERAL_QUICK_PROMPTS) expect(plain).toContain(p);
    for (const p of LEAD_QUICK_PROMPTS) expect(plain).not.toContain(p);
    const quick = render({ aiConfigured: false, context: { view: 'lead', leadId: 'ENQ-0003' } });
    for (const p of [...LEAD_QUICK_PROMPTS, ...GENERAL_QUICK_PROMPTS]) expect(quick).not.toContain(p);
    expect(quick).toContain('Quick search mode');
  });

  it('renders nothing while closed', () => {
    expect(render({ isOpen: false })).toBe('');
  });
});
