/**
 * Copilot resilience — one retry after ~1.5 s, then a calm fallback. Raw errors, HTTP codes and
 * model names must never reach the chat.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  COPILOT_BUSY_FOOTER,
  COPILOT_BUSY_TEXT,
  COPILOT_RETRY_DELAY_MS,
  COPILOT_UNAVAILABLE_FOOTER,
  COPILOT_UNAVAILABLE_TEXT,
  copilotFailureKind,
  copilotFallback,
  retryOnce,
  type ToolContext,
} from '../src/modules/ai/copilotTools';
import { AppError } from '../src/core/errors';
import { F, STAGES, SITE_VISIT } from '../src/core/config';
import type { Lead } from '../src/types/crm';

const lead: Lead = {
  [F.ID]: 'ENQ-0001',
  [F.ENQUIRY_DATE]: '2026-09-05 10:00',
  [F.NAME]: 'Narayana Rao',
  [F.PHONE]: '+91 98490 12345',
  Email: '',
  [F.STAGE]: STAGES.HOT,
  [F.SOURCE]: 'WhatsApp',
  [F.UNIT_TYPE]: '2 BHK',
  [F.PURCHASE_OR_RENT]: 'Purchase',
  [F.SITE_VISIT_STATUS]: SITE_VISIT.PROSPECT,
  [F.NEXT_FOLLOWUP]: '2026-10-01 16:00',
  [F.NOTES]: '',
  [F.RM]: 'Rahul',
  [F.BROCHURE]: 'No',
  [F.RELATIONSHIP]: 'Self',
  [F.ENQUIRED_FOR]: 'Self',
};
const ctx: ToolContext = { leads: [lead], tasks: [], inventory: [], now: new Date('2026-10-01T18:00:00Z'), currentUser: 'Rahul' };
const busyError = () => new AppError('SERVER', 'Gemini is busy right now (HTTP 503). This model is currently experiencing high demand.');

describe('copilotFailureKind', () => {
  it('treats set-up, permission and session problems as unavailable; everything else as busy', () => {
    for (const code of ['NOT_CONFIGURED', 'FORBIDDEN', 'AUTH_REQUIRED']) expect(copilotFailureKind(code)).toBe('unavailable');
    for (const code of ['SERVER', 'RATE_LIMIT', 'TIMEOUT', 'NETWORK', 'UNKNOWN', undefined]) expect(copilotFailureKind(code)).toBe('busy');
  });
});

describe('copilotFallback', () => {
  it('shows live quick-search results with a short calm footer for a CRM question', () => {
    const f = copilotFallback('show me all hot leads', ctx);
    expect(f.status).toBeUndefined();
    expect(f.table?.rows[0].ID).toBe('ENQ-0001');
    expect(f.content).toContain('**1 Hot lead**');
    expect(f.content.endsWith(`\n\n${COPILOT_BUSY_FOOTER}`)).toBe(true);
  });

  it('otherwise says the assistant is busy, with error status', () => {
    expect(copilotFallback('What is 15% of 2 crore?', ctx)).toEqual({ content: COPILOT_BUSY_TEXT, status: 'error' });
    expect(COPILOT_BUSY_TEXT).toBe('The assistant is busy right now — please try again in a few seconds.');
  });

  it('never answers a drafting request with a CRM list', () => {
    // quickIntent alone would read "follow-up" / "WhatsApp" and list leads.
    expect(copilotFallback('Suggest a WhatsApp follow-up', ctx)).toEqual({ content: COPILOT_BUSY_TEXT, status: 'error' });
    expect(copilotFallback('Summarise this enquiry', ctx).status).toBe('error');
  });

  it('uses the "not available" wording for set-up problems', () => {
    expect(copilotFallback('show me all hot leads', ctx, 'unavailable').content.endsWith(COPILOT_UNAVAILABLE_FOOTER)).toBe(true);
    expect(copilotFallback('Why Amaya? (3 lines)', ctx, 'unavailable')).toEqual({ content: COPILOT_UNAVAILABLE_TEXT, status: 'error' });
  });

  it('never leaks technical detail into the chat', () => {
    const texts = [
      COPILOT_BUSY_TEXT,
      COPILOT_BUSY_FOOTER,
      COPILOT_UNAVAILABLE_TEXT,
      COPILOT_UNAVAILABLE_FOOTER,
      copilotFallback('show me all hot leads', ctx).content,
      copilotFallback('anything at all', ctx, 'unavailable').content,
    ];
    for (const t of texts) expect(t).not.toMatch(/gemini|http|\b[45]\d\d\b|error|model|flash/i);
  });
});

describe('retryOnce', () => {
  it('does not retry a success', async () => {
    const run = vi.fn().mockResolvedValue('ok');
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(retryOnce(run, { sleep })).resolves.toBe('ok');
    expect(run).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a failure once after the delay', async () => {
    const run = vi.fn().mockRejectedValueOnce(busyError()).mockResolvedValueOnce('second try');
    const sleep = vi.fn().mockResolvedValue(undefined);
    const onRetry = vi.fn();
    await expect(retryOnce(run, { sleep, onRetry })).resolves.toBe('second try');
    expect(run).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(COPILOT_RETRY_DELAY_MS);
    expect(COPILOT_RETRY_DELAY_MS).toBe(1500);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('retries only once, then rethrows the last error', async () => {
    const second = new AppError('RATE_LIMIT', 'still busy');
    const run = vi.fn().mockRejectedValueOnce(busyError()).mockRejectedValueOnce(second).mockResolvedValue('never');
    await expect(retryOnce(run, { sleep: async () => {} })).rejects.toBe(second);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('skips the retry for set-up problems and when the drawer closed meanwhile', async () => {
    const config = new AppError('NOT_CONFIGURED', 'Gemini rejected the API key.');
    const run = vi.fn().mockRejectedValue(config);
    const shouldRetry = (e: unknown) => copilotFailureKind((e as AppError).code) === 'busy';
    await expect(retryOnce(run, { sleep: async () => {}, shouldRetry })).rejects.toBe(config);
    expect(run).toHaveBeenCalledTimes(1);

    let open = true;
    const run2 = vi.fn().mockRejectedValue(busyError());
    await expect(retryOnce(run2, { sleep: async () => void (open = false), isActive: () => open })).rejects.toBeInstanceOf(AppError);
    expect(run2).toHaveBeenCalledTimes(1);
  });

  it('waits about 1.5 s by default', async () => {
    vi.useFakeTimers();
    try {
      const run = vi.fn().mockRejectedValueOnce(busyError()).mockResolvedValueOnce('later');
      const pending = retryOnce(run);
      await vi.advanceTimersByTimeAsync(COPILOT_RETRY_DELAY_MS - 1);
      expect(run).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe('later');
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
