/** Loading skeletons: every CRM screen has one, it is announced once to screen readers, and it renders the same on server and browser. */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatSkeleton, ListSkeleton, PageSkeleton, TableSkeleton, VIEW_SKELETON } from '../src/components/Skeletons';
import { VIEW_IDS } from '../src/core/views';

const html = (el: any) => renderToStaticMarkup(el);

describe('skeletons', () => {
  it('cover every CRM screen', () => {
    for (const v of VIEW_IDS) {
      const out = html(createElement(PageSkeleton, { variant: VIEW_SKELETON[v], label: `Loading ${v}` }));
      expect(out).toContain('role="status"');
      expect(out).toContain('aria-busy="true"');
      expect(out).toContain(`Loading ${v}`);
    }
  });

  it('announce once and hide the shapes from screen readers', () => {
    const out = html(createElement(TableSkeleton, { rows: 3, cols: 4, label: 'Loading the audit log…' }));
    expect(out.match(/role="status"/g)).toHaveLength(1);
    expect(out).toContain('<span class="sr-only">Loading the audit log…</span>');
    expect(out).toContain('aria-hidden="true"');
  });

  it('pulse only when motion is allowed, and draw the same every time', () => {
    const a = html(createElement(PageSkeleton, { variant: 'dashboard' }));
    expect(a).toContain('motion-safe:animate-pulse');
    expect(a).not.toMatch(/(^|\s|")animate-pulse/);
    expect(html(createElement(PageSkeleton, { variant: 'dashboard' }))).toBe(a);
  });

  it('list and chat sizes follow their props', () => {
    expect(html(createElement(ListSkeleton, { rows: 4 })).match(/rounded-full flex-none"/g)).toHaveLength(4);
    expect(html(createElement(ChatSkeleton, {}))).toContain('Loading conversation…');
  });
});
