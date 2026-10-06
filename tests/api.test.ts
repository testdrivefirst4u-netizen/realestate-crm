/**
 * API client transport: same-origin `POST /api/rpc` with `{action, data}`, the JSON envelope on
 * success and on real HTTP error statuses, the auth-expiry callback and timeouts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, configureApi } from '../src/core/api';
import { AppError } from '../src/core/errors';

function mockFetch(body: string, status = 200, contentType = 'application/json') {
  const fn = vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': contentType } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function failure(p: Promise<unknown>): Promise<AppError> {
  try {
    await p;
  } catch (e) {
    return e as AppError;
  }
  throw new Error('expected the call to fail');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  configureApi({ onAuthExpired: () => {} });
});

describe('transport', () => {
  it('POSTs JSON {action, data} to /api/rpc, same-origin, without any token', async () => {
    const fn = mockFetch(JSON.stringify({ status: 'success', data: { ok: true } }));
    configureApi({ url: 'https://ignored.example/exec', token: 'ignored' });
    await api.leads.setStage('ENQ-0001', 'Hot');
    const [url, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/rpc');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toEqual({ action: 'setLeadStage', data: { id: 'ENQ-0001', stage: 'Hot' } });
  });

  it('ping / setupStatus are POSTs too (no GET mode)', async () => {
    const fn = mockFetch(JSON.stringify({ status: 'success', data: { hasUsers: true, version: '3.0.0', sheetsReady: true } }));
    await api.system.setupStatus();
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ action: 'setupStatus', data: {} });
  });

  it('a success envelope passes data through (null data included)', async () => {
    mockFetch(JSON.stringify({ status: 'success', data: { message: 'Amaya CRM backend online', serverTime: 'x', version: '3.0.0' } }));
    const ping = await api.system.ping();
    expect(ping.version).toBe('3.0.0');
    mockFetch(JSON.stringify({ status: 'success', data: null }));
    expect(await api.raw('logout')).toBeNull();
  });
});

describe('errors', () => {
  it('parses the envelope of a non-2xx response and maps its code', async () => {
    mockFetch(JSON.stringify({ status: 'error', code: 'FORBIDDEN', message: 'Not allowed' }), 403);
    const err = await failure(api.settings.users.list());
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe('FORBIDDEN');

    mockFetch(JSON.stringify({ status: 'error', code: 'NOT_FOUND', message: 'Unknown action: nope' }), 404);
    const nf = await failure(api.raw('nope'));
    expect(nf.code).toBe('NOT_FOUND');
    expect(nf.userMessage).toBe('Unknown action: nope');
  });

  it('AUTH_REQUIRED (401) calls onAuthExpired', async () => {
    const expired = vi.fn();
    configureApi({ onAuthExpired: expired });
    mockFetch(JSON.stringify({ status: 'error', code: 'AUTH_REQUIRED', message: 'Session expired', isAuthError: true }), 401);
    const err = await failure(api.auth.me());
    expect(err.code).toBe('AUTH_REQUIRED');
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('a failed sign-in is not a session expiry and keeps the server message', async () => {
    const expired = vi.fn();
    configureApi({ onAuthExpired: expired });
    mockFetch(JSON.stringify({ status: 'error', code: 'AUTH_FAILED', message: 'Invalid email or password' }), 401);
    const err = await failure(api.auth.login('a@b.com', 'wrong'));
    expect(err.code).toBe('SERVER');
    expect(err.userMessage).toBe('Invalid email or password');
    expect(expired).not.toHaveBeenCalled();
  });

  it('a non-JSON error page is classified by HTTP status', async () => {
    mockFetch('<!doctype html><title>502 Bad Gateway</title>', 502, 'text/html');
    const err = await failure(api.system.ping());
    expect(err.code).toBe('SERVER');

    const expired = vi.fn();
    configureApi({ onAuthExpired: expired });
    mockFetch('Unauthorized', 401, 'text/plain');
    const auth = await failure(api.auth.me());
    expect(auth.code).toBe('AUTH_REQUIRED');
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('a network failure maps to NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await failure(api.system.ping());
    expect(err.code).toBe('NETWORK');
  });

  it('aborts after the timeout → TIMEOUT', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
      }))
    );
    const p = failure(api.system.ping());
    await vi.advanceTimersByTimeAsync(16_000);
    const err = await p;
    expect(err.code).toBe('TIMEOUT');
  });
});
