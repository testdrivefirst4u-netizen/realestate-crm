import { describe, it, expect } from 'vitest';
import { F, SITE_VISIT, STAGES } from '../src/core/config';
import { addDaysKey, changePct, firstCallByLead, funnelCounts, funnelStep, perfRanges, perfRow, periodRange, pipelineNow, previousRange, speedBuckets, toMisLeads, weekStartKey } from '../src/modules/mis/misData';
import { mapMetaLead } from '../server/modules/meta';
import { sourceKind } from '../src/modules/leads/SourceLogo';
import { canonicalStage, classifyStage } from '../src/core/analytics';
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

  it('counts the Disqualified stages from the sheet as lost, even with a long dash or the "Disqualifid" typo', () => {
    expect(canonicalStage('Disqualifid - Budget')).toBe(STAGES.DQ_BUDGET);
    expect(canonicalStage('Disqualified – Project Type')).toBe(STAGES.DQ_PROJECT);
    expect(canonicalStage('  disqualified -  ni ')).toBe(STAGES.DQ_NI);
    expect(canonicalStage('Others')).toBe('Others');
    for (const s of ['Disqualified - NI', 'Disqualified - Timeline', 'Disqualified – Project Type', 'Disqualifid - Budget', 'Lost']) expect(classifyStage(s)).toBe('lost');
    expect(mis(lead('x', 'Disqualified – Project Type' as any))).toMatchObject({ stage: 'disqualified', reason: 'Project type' });
  });

  it('carries the Meta campaign, ad set and ad for the campaign funnel', () => {
    const m = mis(lead('c', STAGES.NEW, { [F.CAMPAIGN]: 'Video_Sept2026', [F.AD_SET]: 'Hyderabad_50+', [F.AD_NAME]: 'Lifestyle_Video' }));
    expect(m).toMatchObject({ campaign: 'Video_Sept2026', adSet: 'Hyderabad_50+', ad: 'Lifestyle_Video' });
    expect(mis(lead('d', STAGES.NEW))).toMatchObject({ campaign: '', adSet: '', ad: '' });
  });

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

describe('speed to lead', () => {
  it('buckets leads by minutes to first response; open leads without one are "not contacted"', () => {
    const m = (respMins: number | null, responded: boolean, stage = 'open') => ({ respMins, responded, stage }) as any;
    expect(speedBuckets([m(3, true), m(5, true), m(40, true), m(200, true), m(null, false), m(null, false, 'disqualified'), m(null, true)]))
      .toEqual({ total: 7, m5: 2, h1: 1, later: 1, none: 1 });
  });
});

describe('enquiry performance (FTD / MTD / YTD)', () => {
  const at = (id: string, day: string, stage: string, extra: Record<string, string> = {}) => lead(id, stage, { [F.ENQUIRY_DATE]: `${day}T11:00:00+05:30`, ...extra });
  const ids = (ls: Array<{ id: string }>) => ls.map((l) => l.id).sort();
  const all = toMisLeads([
    at('a', '2026-10-09', STAGES.QUALIFIED),
    at('b', '2026-10-09', STAGES.HOT),
    at('c', '2026-10-09', STAGES.DQ_BUDGET),
    at('d', '2026-10-09', STAGES.NOT_RESPONDING),
    at('e', '2026-10-09', STAGES.NEW),
    at('f', '2026-10-02', STAGES.WARM, { [F.SITE_VISIT_STATUS]: SITE_VISIT.COMPLETED, [F.SITE_VISIT_DATE]: '2026-10-09T15:00:00+05:30' }),
    at('g', '2026-09-30', STAGES.BOOKED),
    at('h', '2025-12-31', STAGES.OPEN),
    at('i', '2026-10-10', STAGES.NEW),
    at('j', '2026-03-01', STAGES.QUALIFIED, { [F.SITE_VISIT_STATUS]: SITE_VISIT.SCHEDULED }),
    at('k', '2026-03-02', STAGES.QUALIFIED, { [F.SITE_VISIT_STATUS]: SITE_VISIT.PROSPECT }),
    at('l', '2026-03-03', STAGES.DQ_NI, { [F.SITE_VISIT_STATUS]: SITE_VISIT.PROSPECT }),
    at('m', '2026-03-04', STAGES.QUALIFIED, { [F.SITE_VISIT_STATUS]: SITE_VISIT.WALK_IN }),
  ], new Map());

  it('ranges end on the report date: the day, from the 1st of the month, from 1 January', () => {
    expect(perfRanges('2026-10-09')).toEqual({ ftd: ['2026-10-09', '2026-10-09'], mtd: ['2026-10-01', '2026-10-09'], ytd: ['2026-01-01', '2026-10-09'] });
  });

  it('splits received leads into qualified / unqualified / non-responding / open, which add up', () => {
    const r = perfRanges('2026-10-09');
    const ftd = perfRow(all, r.ftd);
    expect(ids(ftd.received)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(ids(ftd.qualified)).toEqual(['a', 'b']);
    expect(ids(ftd.unqualified)).toEqual(['c']);
    expect(ids(ftd.nonResponding)).toEqual(['d']);
    expect(ids(ftd.open)).toEqual(['e']);
    for (const row of [ftd, perfRow(all, r.mtd), perfRow(all, r.ytd)]) {
      expect(row.qualified.length + row.unqualified.length + row.nonResponding.length + row.open.length).toBe(row.received.length);
    }
    // a visit counts on the day it happened, though the lead came in earlier
    expect(ids(ftd.visits)).toEqual(['f']);
    expect(ids(perfRow(all, r.mtd).received)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(ids(perfRow(all, r.ytd).received)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'j', 'k', 'l', 'm']);
  });

  it('the overall pipeline counts every enquiry as it stands', () => {
    const p = pipelineNow(all);
    expect(p.total).toHaveLength(13);
    expect(ids(p.qualified)).toEqual(['a', 'b', 'f', 'g', 'j', 'k', 'm']);
    expect(ids(p.warm)).toEqual(['f']);
    expect(ids(p.hot)).toEqual(['b']);
    // a prospect for a visit counts as planned; a disqualified one does not
    expect(ids(p.svPlanned)).toEqual(['j', 'k']);
    expect(ids(p.svDone)).toEqual(['f', 'm']);
    expect(ids(p.svDoneUndated)).toEqual(['m']);
  });
});

describe('YTD / MTD screen (server render)', () => {
  it('shows the FTD, MTD, YTD and overall blocks with their tiles', async () => {
    const { createElement } = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { PerformanceView } = await import('../src/modules/mis/PerformanceView');
    const today = new Date().toISOString().slice(0, 10);
    const leads = [lead('1', STAGES.QUALIFIED, { [F.ENQUIRY_DATE]: `${today}T11:00:00+05:30` }), lead('2', STAGES.NOT_RESPONDING, { [F.ENQUIRY_DATE]: `${today}T12:00:00+05:30` })];
    const html = renderToStaticMarkup(createElement(PerformanceView, { leads, onRefresh: () => {}, onShowLeads: () => {}, sync: { status: 'idle', hasLoadedOnce: true } as any }));
    if (process.env.MIS_HTML) (await import('node:fs')).writeFileSync(process.env.MIS_HTML, html);
    for (const t of ['YTD / MTD performance', 'Enquiry Performance Dashboard', 'For the day (FTD) overview', 'Month to date (MTD) overview', 'Year to date (YTD) overview', 'Pipeline stages &amp; conversions (overall)', 'Non-Responding', 'Site Visits Completed']) expect(html).toContain(t);
  });
});

it('Sales MIS no longer carries the YTD / MTD blocks', async () => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { MisView } = await import('../src/modules/mis/MisView');
  const html = renderToStaticMarkup(createElement(MisView, { leads: [], sources: [], canSeeCalls: false, onRefresh: () => {}, onShowLeads: () => {}, sync: { status: 'idle', hasLoadedOnce: true } as any }));
  expect(html).not.toContain('Enquiry Performance Dashboard');
});
