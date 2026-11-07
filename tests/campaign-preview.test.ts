/** The campaign preview: what it shows, and that its rules match sending. */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { fillValue } from '../server/modules/whatsappCampaigns';
import { readTemplate } from '../server/modules/whatsappDirect';
import { fillPreviewValue, peopleMissingValues, previewBody } from '../src/modules/campaigns/campaignAudience';
import { TemplatePreview } from '../src/modules/campaigns/TemplatePreview';

const P = (name: string, rm = '', unit = '') => ({ label: name, name, rm, unit });

describe('filling values', () => {
  it('gives the same answer as sending, for every kind of person', () => {
    for (const person of [P('Meera Rao', 'Asha', '3 BHK'), P(''), P('WhatsApp +919876510000'), P('919876510000'), P('Unknown'), P('Ravi', '', '2 BHK')]) {
      for (const spec of ['{first_name}', '{name}', '{rm}', '{unit}', '{company}', 'Hello {first_name} at {company}', 'plain', '{nothing}']) {
        expect(fillPreviewValue(spec, person, 'Amaya'), `${spec} for ${person.name}`).toBe(fillValue(spec, person, 'Amaya'));
      }
    }
  });
  it('counts who would not get it, ignoring values not filled in yet', () => {
    const people = [P('A', 'Asha'), P('B'), P('C')];
    expect(peopleMissingValues(['{rm}'], people, 'X')).toBe(2);
    expect(peopleMissingValues(['{first_name}'], people, 'X')).toBe(0);
    expect(peopleMissingValues([''], people, 'X')).toBe(0);
  });
});

describe('the message in pieces', () => {
  it('fills in what it has, and marks what it does not', () => {
    expect(previewBody('Hi {{1}}, see {{2}}.', ['1', '2'], ['Meera', ''])).toEqual([{ text: 'Hi ', empty: false }, { text: 'Meera', empty: false }, { text: ', see ', empty: false }, { text: '{{2}}', empty: true }, { text: '.', empty: false }]);
    expect(previewBody('No values', [], [])).toEqual([{ text: 'No values', empty: false }]);
    expect(previewBody('', [], [])).toEqual([]);
    expect(previewBody('{{ first_name }}!', ['first_name'], ['Meera'])[0]).toEqual({ text: 'Meera', empty: false });
  });
  it('a value that looks like markup stays text', () => {
    const html = renderToStaticMarkup(React.createElement(TemplatePreview, { template: { body: 'Hi {{1}}', paramNames: ['1'] }, values: ['<script>x</script>'] }));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the phone', () => {
  const draw = (over: Record<string, unknown> = {}) => renderToStaticMarkup(React.createElement(TemplatePreview, { template: { body: 'Hello {{1}}', paramNames: ['1'], ...over } as any, values: ['Meera'], business: 'Amaya' }));
  it('shows the business, the words, footer and buttons', () => {
    const html = draw({ footer: 'Reply STOP to opt out', headerText: 'Diwali offer', buttons: [{ type: 'QUICK_REPLY', text: 'Book a visit' }] });
    for (const t of ['Amaya', 'Hello ', 'Meera', 'Reply STOP to opt out', 'Diwali offer', 'Book a visit']) expect(html).toContain(t);
  });
  it('holds a place for a file not chosen yet, and shows one that is', () => {
    expect(draw({ headerMedia: 'image' })).toContain('Your image goes here');
    expect(renderToStaticMarkup(React.createElement(TemplatePreview, { template: { body: 'x', paramNames: [], headerMedia: 'image' } as any, mediaUrl: '/api/files/1' }))).toContain('/api/files/1');
    expect(renderToStaticMarkup(React.createElement(TemplatePreview, { template: { body: 'x', paramNames: [], headerMedia: 'document' } as any, mediaName: 'plan.pdf' }))).toContain('plan.pdf');
  });
  it('asks for a template when there is none', () => {
    expect(renderToStaticMarkup(React.createElement(TemplatePreview, {}))).toContain('Choose a template');
  });
});

describe('reading a template from Meta', () => {
  it('keeps what the preview needs', () => {
    expect(readTemplate({ name: 'a', components: [{ type: 'HEADER', format: 'TEXT', text: 'Top' }, { type: 'BODY', text: 'Hi' }, { type: 'FOOTER', text: 'Foot' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Visit', url: 'https://x' }, { type: 'QUICK_REPLY', text: 'Yes' }] }] })).toMatchObject({ headerText: 'Top', footer: 'Foot', buttons: [{ type: 'URL', text: 'Visit' }, { type: 'QUICK_REPLY', text: 'Yes' }], sendable: true });
  });
});
