/**
 * search_project_documents — the Copilot's read tool over the brochure, floor plans,
 * monthly packages, payment schedule and legal & RERA papers.
 */
import { describe, it, expect } from 'vitest';
import { PROJECT_DOCUMENTS } from '../src/documents/projectDocuments';
import {
  DOC_RESULTS_MAX,
  READ_TOOL_NAMES,
  TOOL_DECLARATIONS,
  docTokens,
  executeReadTool,
  isReadTool,
  resultTable,
  searchProjectDocuments,
  type ToolContext,
} from '../src/modules/ai/copilotTools';

const ctx: ToolContext = { leads: [], tasks: [], inventory: [], now: new Date('2026-10-01T18:00:00Z') };
const top = (q: string, n = 3) => searchProjectDocuments(q, n).results.map((r) => r.reference);

describe('searchProjectDocuments', () => {
  it('finds the right passage for typical sales questions', () => {
    expect(top('Distance from Amaya to the airport')[0]).toBe('Brochure 2:4');
    expect(top('2.5 BHK carpet area').slice(0, 2)).toEqual(['Floor Plans 3:1', 'Floor Plans 3:2']);
    expect(top('2 BHK').slice(0, 2)).toEqual(['Floor Plans 2:1', 'Floor Plans 2:2']);
    expect(top('RERA registration number')[0]).toBe('Legal & RERA 1:1');
    expect(top('car parking price')[0]).toBe('Payment Schedule 1:2');
    expect(top('home loan banks')[0]).toBe('Payment Schedule 3:2');
    expect(top('minimum age')[0]).toBe('Legal & RERA 4:2');
    expect(top('payment milestones')[0]).toMatch(/^Payment Schedule 2:/);
    expect(top('monthly package 2 BHK couple')[0]).toBe('Packages 5:2');
    expect(top('GST stamp duty')[0]).toBe('Payment Schedule 1:4');
    expect(top('does it have a gym?')[0]).toBe('Brochure 3:3');
  });

  it('understands British spellings, plurals and figures written either way', () => {
    expect(top('theatre')[0]).toBe('Brochure 3:4');
    expect(top('lifts')[0]).toBe('Brochure 4:3');
    expect(top('specialised care')[0]).toBe('Packages 5:4');
    expect(top('8999')[0]).toBe('Payment Schedule 1:1'); // written "₹8,999" in the document
    expect(top('2,50,000')[0]).toBe('Payment Schedule 1:2');
    expect(docTokens('₹2,50,000 per 1,112.94 sq.ft 2.5 BHK')).toEqual(['250000', 'per', '1112.94', 'sq', 'ft', '2.5', 'bhk']);
  });

  it('returns passages verbatim with their reference, document and chapter', () => {
    const hit = searchProjectDocuments('RERA registration').results[0];
    const verse = PROJECT_DOCUMENTS.flatMap((d) => d.verses).find((v) => v.reference === hit.reference)!;
    expect(hit).toEqual({ reference: verse.reference, document: verse.docShortName, chapter: verse.chapterTitle, text: verse.text });
    expect(hit.text).toContain('TG RERA P02200011109');
  });

  it('caps the results and handles empty or unknown queries', () => {
    expect(searchProjectDocuments('bhk', 2).results).toHaveLength(2);
    expect(searchProjectDocuments('bhk', 99).results.length).toBeLessThanOrEqual(DOC_RESULTS_MAX);
    expect(searchProjectDocuments('   ')).toEqual({ total: 0, results: [] });
    expect(searchProjectDocuments('zzz qqq').total).toBe(0);
  });
});

describe('search_project_documents tool', () => {
  it('is registered as a read tool with a declaration', () => {
    expect(READ_TOOL_NAMES).toContain('search_project_documents');
    expect(isReadTool('search_project_documents')).toBe(true);
    const decl = TOOL_DECLARATIONS.find((d) => d.name === 'search_project_documents')!;
    expect(decl.parameters?.required).toEqual(['query']);
    expect(Object.keys(decl.parameters?.properties || {})).toEqual(['query', 'max_results']);
  });

  it('returns passages and guidance through executeReadTool', () => {
    const r = executeReadTool('search_project_documents', { query: 'airport', max_results: 2 }, ctx) as any;
    expect(r.error).toBeUndefined();
    expect(r.results).toHaveLength(2);
    expect(r.results[0].reference).toBe('Brochure 2:4');
    expect(r.guidance).toMatch(/approved facts win/);
    expect(resultTable(r)).toBeNull(); // passages are not rendered as a lead table
  });

  it('explains an empty result and asks for a missing query', () => {
    const none = executeReadTool('search_project_documents', { query: 'zzz qqq' }, ctx) as any;
    expect(none.total).toBe(0);
    expect(none.results).toEqual([]);
    expect(none.guidance).toMatch(/approved price sheet or the commercial owner/);
    expect(executeReadTool('search_project_documents', {}, ctx).error).toMatch(/query is required/);
  });
});
