/**
 * Call history → enquiry matching: unlinked calls show the enquiry with the same phone number
 * (the backend's matchedLeadId first, else a client-side phone match) and link in one click.
 */
import { describe, expect, it } from 'vitest';
import { leadsByPhone, linkPatch, matchForCall } from '../src/modules/calls/callsUtils';
import { F, SITE_VISIT, STAGES } from '../src/core/config';
import type { CallRecord, Lead } from '../src/types/crm';

const mkLead = (over: Partial<Lead>): Lead => ({
  [F.ID]: 'ENQ-0001',
  [F.ENQUIRY_DATE]: '2026-09-10T05:00:00.000Z',
  [F.NAME]: 'Test',
  [F.PHONE]: '',
  Email: '',
  [F.STAGE]: STAGES.NEW,
  [F.SOURCE]: 'Website',
  [F.UNIT_TYPE]: '',
  [F.PURCHASE_OR_RENT]: 'Purchase',
  [F.SITE_VISIT_STATUS]: SITE_VISIT.PROSPECT,
  [F.NEXT_FOLLOWUP]: '',
  [F.NOTES]: '',
  [F.RM]: '',
  [F.BROCHURE]: 'No',
  [F.RELATIONSHIP]: 'Self',
  [F.ENQUIRED_FOR]: 'Self',
  ...over,
});

const mkCall = (over: Partial<CallRecord>): CallRecord => ({
  id: 'CALL-0001',
  leadId: '',
  customerName: '',
  phone: '',
  direction: 'Inbound',
  callDate: '2026-10-02T05:00:00.000Z',
  status: 'Completed',
  ...over,
});

const rahul = mkLead({ [F.ID]: 'ENQ-0003', [F.NAME]: 'Rahul Verma', [F.PHONE]: '+91 90000 11111', [F.STAGE]: STAGES.WARM, [F.UNIT_TYPE]: '2.5 BHK-A', [F.RM]: 'Priya' });
const lakshmi = mkLead({ [F.ID]: 'ENQ-0009', [F.NAME]: 'Lakshmi Rao', [F.PHONE]: '98480 22222', [F.STAGE]: STAGES.HOT, [F.UNIT_TYPE]: '3 BHK', [F.RM]: 'Arjun' });
const trashed = mkLead({ [F.ID]: 'ENQ-0011', [F.NAME]: 'Old Duplicate', [F.PHONE]: '9876500000', [F.STAGE]: STAGES.TRASH });
const leads = [rahul, lakshmi, trashed];
const byId = new Map(leads.map((l) => [String(l[F.ID]), l]));
const byPhone = leadsByPhone(leads);

describe('leadsByPhone', () => {
  it('keys enquiries by the last 10 digits and skips trashed / deleted ones', () => {
    expect(byPhone.get('9000011111')).toBe(rahul);
    expect(byPhone.get('9848022222')).toBe(lakshmi);
    expect(byPhone.has('9876500000')).toBe(false);
  });

  it('keeps the first enquiry for a shared number and ignores short numbers', () => {
    const dup = mkLead({ [F.ID]: 'ENQ-0020', [F.NAME]: 'Second', [F.PHONE]: '9000011111' });
    const m = leadsByPhone([rahul, dup, mkLead({ [F.ID]: 'ENQ-0021', [F.PHONE]: '12345' })]);
    expect(m.get('9000011111')).toBe(rahul);
    expect(m.size).toBe(1);
  });
});

describe('matchForCall', () => {
  it('uses the server suggestion, enriched from the loaded lead (fresh stage, RM, unit type)', () => {
    const call = mkCall({ phone: '+919000011111', matchedLeadId: 'ENQ-0003', matchedName: 'R Verma', matchedStage: 'New', matchedRM: 'Old RM' });
    expect(matchForCall(call, byId, byPhone)).toEqual({
      leadId: 'ENQ-0003',
      name: 'Rahul Verma',
      stage: STAGES.WARM,
      rm: 'Priya',
      unitType: '2.5 BHK-A',
      phone: '+91 90000 11111',
      via: 'server',
    });
  });

  it('falls back to the server fields when that enquiry is not loaded in the app', () => {
    const call = mkCall({ phone: '9123456789', matchedLeadId: 'ENQ-0500', matchedName: 'Meera Iyer', matchedStage: 'Qualified', matchedRM: 'Kiran' });
    expect(matchForCall(call, byId, byPhone)).toEqual({ leadId: 'ENQ-0500', name: 'Meera Iyer', stage: 'Qualified', rm: 'Kiran', unitType: '', phone: '9123456789', via: 'server' });
  });

  it('matches by phone on the client when the backend sent no suggestion', () => {
    const match = matchForCall(mkCall({ phone: '+91 98480 22222' }), byId, byPhone);
    expect(match?.leadId).toBe('ENQ-0009');
    expect(match?.via).toBe('phone');
    expect(match?.unitType).toBe('3 BHK');
    expect(match?.rm).toBe('Arjun');
  });

  it('returns null for linked calls, unknown numbers, short numbers and trashed enquiries', () => {
    expect(matchForCall(mkCall({ leadId: 'ENQ-0003', phone: '9000011111', matchedLeadId: 'ENQ-0003' }), byId, byPhone)).toBeNull();
    expect(matchForCall(mkCall({ phone: '9999999999' }), byId, byPhone)).toBeNull();
    expect(matchForCall(mkCall({ phone: '12345' }), byId, byPhone)).toBeNull();
    expect(matchForCall(mkCall({ phone: '' }), byId, byPhone)).toBeNull();
    expect(matchForCall(mkCall({ phone: '9876500000' }), byId, byPhone)).toBeNull();
  });
});

describe('linkPatch', () => {
  it('links the call and fills a missing name / number from the enquiry', () => {
    expect(linkPatch({ customerName: '', phone: '' }, { leadId: 'ENQ-0003', name: 'Rahul Verma', phone: '+91 90000 11111' })).toEqual({
      leadId: 'ENQ-0003',
      customerName: 'Rahul Verma',
      phone: '+91 90000 11111',
    });
  });

  it("keeps the call's own caller name and number", () => {
    expect(linkPatch({ customerName: 'Rahul (caller ID)', phone: '+919000011111' }, { leadId: 'ENQ-0003', name: 'Rahul Verma', phone: '+91 90000 11111' })).toEqual({
      leadId: 'ENQ-0003',
      customerName: 'Rahul (caller ID)',
      phone: '+919000011111',
    });
  });
});
