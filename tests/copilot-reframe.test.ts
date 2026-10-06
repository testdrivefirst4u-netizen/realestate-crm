/**
 * "Reframe with AI" (SmartTextarea): the polished text replaces the user's text only when they have
 * not typed meanwhile; the box never locks while the request runs.
 */
import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { REFRAME_DEBOUNCE_MS, SmartTextarea, reframeOutcome } from '../src/modules/leads/shared';

describe('reframeOutcome', () => {
  const sent = 'spoke to son, wants 2bhk, call monday';
  const polished = 'Spoke to the son — they are keen on a 2 BHK. Calling back on Monday.';

  it('replaces the text when the user has not typed meanwhile', () => {
    expect(reframeOutcome(sent, sent, polished)).toBe('replace');
    expect(reframeOutcome(sent, `${sent}  `, polished)).toBe('replace'); // whitespace-only changes do not count
  });

  it('offers the polished version when the user kept typing', () => {
    expect(reframeOutcome(sent, `${sent} after 4pm`, polished)).toBe('offer');
  });

  it('reports nothing to change, a failure, or a box that was cleared', () => {
    expect(reframeOutcome(sent, sent, ` ${sent} `)).toBe('unchanged');
    expect(reframeOutcome(sent, sent, '')).toBe('failed');
    expect(reframeOutcome(sent, sent, undefined)).toBe('failed');
    expect(reframeOutcome(sent, '', polished)).toBe('stale'); // e.g. the remark was saved meanwhile
  });

  it('debounces double clicks', () => {
    expect(REFRAME_DEBOUNCE_MS).toBeGreaterThanOrEqual(300);
  });
});

describe('SmartTextarea', () => {
  const render = (props: Partial<Parameters<typeof SmartTextarea>[0]> = {}) =>
    renderToStaticMarkup(createElement(SmartTextarea, { value: 'spoke to son', onChange: () => {}, ...props }));

  it('keeps its props API and renders an editable box with the reframe action', () => {
    const html = render({ aiEnabled: true, placeholder: 'What was discussed?' });
    expect(html).toContain('Reframe (AI)');
    expect(html).toContain('placeholder="What was discussed?"');
    expect(html).not.toMatch(/<textarea[^>]*\sdisabled=""/); // the attribute, not Tailwind's disabled: variants
    expect(render({ disabled: true })).toMatch(/<textarea[^>]*\sdisabled=""/); // the parent's own disabled still works
  });

  it('hides the reframe action when AI is not configured', () => {
    expect(render({ aiEnabled: false })).not.toContain('Reframe');
  });
});
