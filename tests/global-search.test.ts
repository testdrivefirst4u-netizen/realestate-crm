/** Top-bar global search: every kind of record, all-words matching, grouping, ranking and highlighting. */
import { describe, expect, it } from 'vitest';
import { globalSearch, highlightParts, queryTerms, snippetAround } from '../src/core/globalSearch';
import { F } from '../src/core/config';

const lead = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ [F.ID]: id, [F.NAME]: name, [F.PHONE]: '9876500001', [F.STAGE]: 'New', ...extra }) as any;

const data: any = {
  leads: [lead('ENQ-0001', 'Meera Kapoor'), lead('ENQ-0002', 'Rajiv Menon', { [F.NOTES]: 'Wants greetings card on booking' })],
  templates: [
    { id: 'T1', name: 'Greetings', type: 'WhatsApp', message: 'Hello {name}, greetings from the team!' },
    { id: 'T2', name: 'Site visit reminder', type: 'Site Visit', message: 'Your visit is at {time}. Greetings!' },
    { id: 'T3', name: 'Price list', type: 'Email', message: 'Please find the price list attached.' },
  ],
  tasks: [{ id: 'K1', name: 'Call Meera about loan', completed: false, lead: 'ENQ-0001', checklist: [] }],
  notes: [{ id: 'N1', text: 'Tower B lift delayed to December' }],
  checklist: [{ id: 'C1', text: 'Print brochures for the expo' }],
  inventory: [{ inventoryId: 'INV-1', unitId: 'B-1204', tower: 'B', unitType: '3 BHK', floor: 12, status: 'Available', facing: 'East' }],
  documents: [{ id: 'D1', name: 'RERA certificate', category: 'Legal & RERA' }],
  segments: [{ id: 'S1', name: 'Hot NRI buyers', description: 'NRI leads with budget over 2 Cr' }],
  users: [{ id: 'U1', name: 'Asha Admin', email: 'asha@co.test', role: 'Admin' }],
};

describe('globalSearch', () => {
  it('finds templates (the reported bug) and groups by kind', () => {
    const groups = globalSearch(data, 'Greetings');
    expect(groups.map((g) => g.kind)).toEqual(['lead', 'template']);
    const tpl = groups.find((g) => g.kind === 'template')!;
    expect(tpl.total).toBe(2);
    expect(tpl.hits[0]).toMatchObject({ id: 'T1', title: 'Greetings', subtitle: 'WhatsApp' }); // exact title ranks first
    expect(tpl.view).toBe('templates');
  });

  it('searches every kind of record', () => {
    const kinds = (q: string) => globalSearch(data, q).map((g) => g.kind);
    expect(kinds('loan')).toEqual(['task']);
    expect(kinds('lift delayed')).toEqual(['note']);
    expect(kinds('brochures')).toEqual(['checklist']);
    expect(kinds('B-1204')).toEqual(['unit']);
    expect(kinds('3 bhk east')).toEqual(['unit']);
    expect(kinds('rera')).toEqual(['document']);
    expect(kinds('nri')).toEqual(['segment']);
    expect(kinds('asha@co')).toEqual(['user']);
    expect(kinds('Menon')).toEqual(['lead']);
  });

  it('needs every word, ignores case and accents, and caps hits per group', () => {
    expect(globalSearch(data, 'price attached')[0].hits.map((h) => h.id)).toEqual(['T3']);
    expect(globalSearch(data, 'price nowhere')).toEqual([]);
    expect(globalSearch({ templates: [{ id: 'X', name: 'Café offer', type: 'General', message: '' }] } as any, 'cafe')[0].hits[0].id).toBe('X');
    const many = { templates: Array.from({ length: 9 }, (_, i) => ({ id: `T${i}`, name: `Offer ${i}`, type: 'General', message: '' })) } as any;
    const g = globalSearch(many, 'offer', 5)[0];
    expect([g.hits.length, g.total]).toEqual([5, 9]);
    expect(globalSearch(data, '   ')).toEqual([]);
  });
});

describe('helpers', () => {
  it('cuts a snippet around the match', () => {
    const text = 'x'.repeat(200) + ' the needle is here ' + 'y'.repeat(200);
    const s = snippetAround(text, ['needle'], 60);
    expect(s).toContain('needle');
    expect(s.startsWith('…') && s.endsWith('…')).toBe(true);
  });

  it('marks matches without changing the text', () => {
    const parts = highlightParts('Hello Greetings, greetings!', queryTerms('greet'));
    expect(parts.map((p) => p.text).join('')).toBe('Hello Greetings, greetings!');
    expect(parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['Greet', 'greet']);
  });
});
