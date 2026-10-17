import { describe, it, expect } from 'vitest';
import { F, SITE_VISIT, STAGES } from '../src/core/config';
import { addDaysKey, changePct, firstCallByLead, funnelCounts, funnelStep, periodRange, previousRange, toMisLeads, weekStartKey } from '../src/modules/mis/misData';
import { mapMetaLead } from '../server/modules/meta';
import { sourceKind } from '../src/modules/leads/SourceLogo';
import type { CallRecord, Lead } from '../src/types/crm';

const lead = (id: string, stage: string, extra: Record<string, string> = {}): Lead =>
  ({ [F.ID]: id, [F.ENQUIRY_DATE]: '2026-10-05T10:00:00+05:30', [F.STAGE]: stage, [F.SITE_VISIT_STATUS]: '', ...extra }) as Lead;

describe('MIS stage mapping', () => {
  const map = (l: Lead) => toMisLeads([l], new Map())[0];

  it('maps CRM stages onto MIS stages', () => {
    expect(map(lead('1', STAGES.NEW)).stage).toBe('open');
    expect(map(lead('2', STAGES.QUALIFIED)).stage).toBe('qualified');
    expect(map(lead('3', STAGES.HOT)).stage).toBe('hot');
    expect(map(lead('4', STAGES.BOOKED)).stage).toBe('booked');
    expect(map(lead('5', STAGES.QUALIFIED, { [F.SITE_VISIT_STATUS]: SITE_VISIT.SCHEDULED }))).toMatchObject({ stage: 'prospect', svPlanned: true });
  });

  it('gives disqualified leads a reason, and a lost lead after a visit is "not interested post SV"', () => {
    expect(map(lead('6', STAGES.DQ_BUDGET))).toMatchObject({ stage: 'disqualified', reason: 'Budget' });
    expect(map(lead('7', STAGES.NOT_RESPONDING))).toMatchObject({ stage: 'disqualified', reason: 'Call not answered' });
    expect(map(lead('8', STAGES.JUNK, { [F.SITE_VISIT_STATUS]: SITE_VISIT.COMPLETED })).stage).toBe('ni');
  });

  it('leaves trashed leads out', () => {
    expect(toMisLeads([lead('9', STAGES.TRASH)], new Map())).toHaveLength(0);
  });

  it('takes the earliest of first follow-up and first call as the response', () => {
    const l = lead('10', STAGES.OPEN, { 'Follow-up 1': '2026-10-05 12:00 — Called' });
    const calls = [{ id: 'c', leadId: '10', startTime: '2026-10-05T10:30:00+05:30' } as CallRecord];
    expect(toMisLeads([l], firstCallByLead(calls))[0].respMins).toBe(30);
  });
});

describe('MIS periods', () => {
  it('does calendar math on day keys', () => {
    expect(addDaysKey('2026-03-01', -1)).toBe('2026-02-28');
    expect(weekStartKey('2026-10-18')).toBe('2026-10-12'); // Sunday → Monday before
  });

  it('builds week, month and comparison ranges', () => {
    const today = '2026-10-15';
    expect(periodRange('week', undefined, today)).toEqual(['2026-10-12', '2026-10-15']);
    expect(periodRange('lastmonth', undefined, today)).toEqual(['2026-09-01', '2026-09-30']);
    expect(periodRange('monthtoyesterday', undefined, today)).toEqual(['2026-10-01', '2026-10-14']);
    expect(periodRange('lastmonthsame', undefined, today)).toEqual(['2026-09-01', '2026-09-14']);
  });
});

describe('source logos', () => {
  it('matches sources by keyword', () => {
    expect(sourceKind('Facebook')).toBe('facebook');
    expect(sourceKind('Instagram')).toBe('instagram');
    expect(sourceKind('Website/Whatsapp')).toBe('website');
    expect(sourceKind('Google Sheet')).toBe('sheet');
    expect(sourceKind('Google Ads')).toBe('google');
  });
});

describe('MIS funnel and trends', () => {
  const mis = (l: Lead) => toMisLeads([l], new Map())[0];

  it('places each lead at the furthest step it reached, counting earlier steps too', () => {
    const list = [
      mis(lead('a', STAGES.NEW)),
      mis(lead('b', STAGES.NEW, { 'Follow-up 1': '2026-10-05 12:00 — Called' })),
      mis(lead('c', STAGES.QUALIFIED)),
      mis(lead('d', STAGES.WARM, { [F.SITE_VISIT_STATUS]: SITE_VISIT.SCHEDULED })),
      mis(lead('e', STAGES.HOT, { [F.SITE_VISIT_STATUS]: SITE_VISIT.COMPLETED })),
      mis(lead('f', STAGES.BOOKED)),
      mis(lead('g', STAGES.DQ_BUDGET)),
    ];
    expect(list.map(funnelStep)).toEqual([0, 1, 2, 3, 4, 5, 0]);
    expect(funnelCounts(list)).toEqual([7, 5, 4, 3, 2, 1]);
  });

  it('compares like-for-like stretches', () => {
    const today = '2026-10-15'; // Thursday
    expect(previousRange('today', today)?.range).toEqual(['2026-10-14', '2026-10-14']);
    expect(previousRange('week', today)?.range).toEqual(['2026-10-05', '2026-10-08']);
    expect(previousRange('month', '2026-03-31')?.range).toEqual(['2026-02-01', '2026-02-28']);
    expect(previousRange('all', today)).toBeNull();
    expect(changePct(12, 10)).toBe(20);
    expect(changePct(5, 0)).toBeNull();
  });

  it('reads City / State / Country and normalises country codes', () => {
    const m = mis(lead('h', STAGES.NEW, { [F.CITY]: 'Dubai', [F.COUNTRY]: 'AE' }));
    expect(m).toMatchObject({ city: 'Dubai', country: 'UAE' });
  });
});

describe('Meta lead forms', () => {
  it('passes city, state and country through to intake', () => {
    const out = mapMetaLead(
      { id: '1', form_id: 'F', created_time: '', field_data: [{ name: 'full_name', values: ['Asha'] }, { name: 'city', values: ['Pune'] }, { name: 'province', values: ['Maharashtra'] }, { name: 'country', values: ['IN'] }] } as any,
      { config: {} } as any,
    );
    expect(out).toMatchObject({ city: 'Pune', state: 'Maharashtra', country: 'IN' });
  });

  it('passes the campaign, ad set, ad and form through to intake', () => {
    const out = mapMetaLead(
      { id: '1', form_id: 'F1', created_time: '', campaign_name: 'Video_Sept2026', adset_name: 'Hyderabad_50+', ad_name: 'Lifestyle_Video', field_data: [{ name: 'phone_number', values: ['9876543210'] }] } as any,
      { config: { meta: { forms: [{ id: 'F1', name: 'Rhythm_Aug26_v3', status: 'ACTIVE' }] } } } as any,
    );
    expect(out).toMatchObject({ meta_campaign: 'Video_Sept2026', meta_ad_set: 'Hyderabad_50+', meta_ad: 'Lifestyle_Video', meta_form: 'Rhythm_Aug26_v3' });
  });
});
