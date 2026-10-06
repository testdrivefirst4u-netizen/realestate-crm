import { describe, it, expect } from 'vitest';
import {
  KEY_PLACEHOLDER,
  buildSnippets,
  canRetry,
  defaultConfig,
  endpointFor,
  normalizeOrigin,
  normalizeOrigins,
  parseSamplePayload,
  rowsToFieldMap,
  fieldMapToRows,
  usableStages,
} from '../src/modules/settings/leadSources/leadSourceUtils';
import { emptyFormState, formToRequest } from '../src/modules/settings/leadSources/SourceForm';

const ENDPOINT = endpointFor('https://crm.example.org/');

describe('lead sources — origins', () => {
  it('accepts https origins and canonicalises them', () => {
    expect(normalizeOrigin('https://www.Example.com/contact?x=1')).toEqual({ ok: true, origin: 'https://www.example.com', error: '' });
    expect(normalizeOrigin('  https://example.com:8443 ').origin).toBe('https://example.com:8443');
    expect(normalizeOrigin('http://localhost:3000').ok).toBe(true);
  });
  it('rejects missing scheme, plain http, bare hosts and junk', () => {
    expect(normalizeOrigin('www.example.com').ok).toBe(false);
    expect(normalizeOrigin('http://www.example.com').ok).toBe(false);
    expect(normalizeOrigin('https://intranet').ok).toBe(false);
    expect(normalizeOrigin('https://user:pw@example.com').ok).toBe(false);
    expect(normalizeOrigin('').ok).toBe(false);
    expect(normalizeOrigin('https://exa mple.com').ok).toBe(false);
  });
  it('de-duplicates a list, skips blanks and reports bad lines', () => {
    const r = normalizeOrigins(['https://a.com', '', 'https://A.com/', 'ftp://x.com']);
    expect(r.origins).toEqual(['https://a.com']);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].index).toBe(3);
  });
});

describe('lead sources — field map & form', () => {
  it('converts rows ↔ map and flags incomplete rows', () => {
    expect(rowsToFieldMap([{ from: 'your-phone', to: 'Phone Number' }, { from: '', to: '' }]).map).toEqual({ 'your-phone': 'Phone Number' });
    expect(rowsToFieldMap([{ from: 'x', to: '' }]).errors).toHaveLength(1);
    expect(rowsToFieldMap([{ from: 'a', to: 'Email' }, { from: 'a', to: 'Email' }]).errors).toHaveLength(1);
    expect(fieldMapToRows({ a: 'Email' })).toEqual([{ from: 'a', to: 'Email' }]);
  });
  it('builds a create request with defaults and validates assignment', () => {
    const f = { ...emptyFormState('webhook'), name: ' Zapier ', origins: ['https://www.example.com/'] };
    const r = formToRequest(f);
    expect(r.errors).toEqual([]);
    expect(r.name).toBe('Zapier');
    expect(r.config).toEqual({ ...defaultConfig('webhook'), allowedOrigins: ['https://www.example.com'] });
    expect(formToRequest({ ...f, assignmentMode: 'fixed' }).errors.length).toBe(1);
    expect(formToRequest({ ...f, assignmentMode: 'round_robin', rms: ['Priya'] }).config.assignment).toEqual({ mode: 'round_robin', rm: '', rms: ['Priya'] });
    expect(formToRequest({ ...f, name: '' }).errors.length).toBe(1);
  });
  it('drops recycle-bin stages', () => {
    expect(usableStages(['New', 'Warm', 'Trash', 'Permanently Deleted'])).toEqual(['New', 'Warm']);
  });
  it('retries only failed / rejected', () => {
    expect(canRetry('failed')).toBe(true);
    expect(canRetry('rejected')).toBe(true);
    expect(canRetry('created')).toBe(false);
  });
});

describe('lead sources — sample payload', () => {
  it('parses objects and rejects arrays / bad JSON', () => {
    expect(parseSamplePayload('{"name":"A"}').payload).toEqual({ name: 'A' });
    expect(parseSamplePayload('[1]').ok).toBe(false);
    expect(parseSamplePayload('{oops').ok).toBe(false);
    expect(parseSamplePayload('  ').ok).toBe(false);
  });
});

describe('lead sources — integration snippets', () => {
  it('uses the endpoint path', () => {
    expect(ENDPOINT).toBe('https://crm.example.org/api/inbound/leads');
  });
  it('HTML form posts with hidden _key, _redirect and a CSS-hidden honeypot', () => {
    const code = buildSnippets('html', { endpoint: ENDPOINT, apiKey: 'crm_live_abc"<' })[0].code;
    expect(code).toContain(`action="${ENDPOINT}" method="POST"`);
    expect(code).toContain('name="_key" value="crm_live_abc&quot;&lt;"');
    expect(code).toContain('name="_redirect"');
    expect(code).toMatch(/name="_gotcha"[^>]*style="position:absolute;left:-9999px"/);
    for (const f of ['name', 'phone', 'email', 'message']) expect(code).toContain(`name="${f}"`);
  });
  it('JS / cURL / Zapier send a Bearer header', () => {
    expect(buildSnippets('js', { endpoint: ENDPOINT, apiKey: 'k1' })[0].code).toContain("'Authorization': 'Bearer k1'");
    expect(buildSnippets('curl', { endpoint: ENDPOINT, apiKey: 'k1' })[0].code).toContain("-H 'Authorization: Bearer k1'");
    const z = buildSnippets('zapier', { endpoint: ENDPOINT, apiKey: 'k1' });
    expect(z.map((b) => b.code)).toContain('Authorization: Bearer k1');
  });
  it('WordPress uses the ?_key= URL, and the placeholder when no key is known', () => {
    expect(buildSnippets('wordpress', { endpoint: ENDPOINT, apiKey: 'crm_live_x' })[0].code).toBe(`${ENDPOINT}?_key=crm_live_x`);
    expect(buildSnippets('wordpress', { endpoint: ENDPOINT })[0].code).toBe(`${ENDPOINT}?_key=${KEY_PLACEHOLDER}`);
  });
});
