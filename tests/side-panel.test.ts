/** The lead side panel's arrangement buttons (server render: the normal width, docked right, not kept open). */
import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Modal } from '../src/components/ui';

describe('side panel', () => {
  it('has resize, dock side, keep open, pop out as a window, full screen, minimise and close', () => {
    const html = renderToStaticMarkup(createElement(Modal, { open: true, side: true, onClose: () => {}, title: 'Meera Rao', panelKey: 'ENQ-0001', children: 'Lead details' }));
    for (const t of ['Drag to resize the panel', 'Move to the left side', 'Keep open while I work on the page', 'Pop out as a window you can move and size', 'Full screen', 'Minimise', 'Close', 'Lead details']) expect(html).toContain(t);
    expect(html).toContain('--side-w:640px'); // the normal width
    expect(html).toContain('backdrop-blur'); // not kept open: the page behind is dimmed
  });

  it('a centred dialog keeps its plain header', () => {
    const html = renderToStaticMarkup(createElement(Modal, { open: true, onClose: () => {}, title: 'New Enquiry', children: 'Form' }));
    expect(html).not.toContain('Move to the left side');
    expect(html).not.toContain('Drag to resize');
  });
});
