/**
 * Centralised error handling.
 *  - `reportError()` logs, keeps a ring buffer of recent errors and
 *    forwards (throttled) to the backend error log when a reporter is set.
 *  - `AppError` carries a machine-readable code + user-facing message.
 *  - Secrets are scrubbed before anything leaves the browser.
 */

export type ErrorCode =
  | 'NETWORK'
  | 'TIMEOUT'
  | 'AUTH_REQUIRED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'NOT_CONFIGURED'
  | 'RATE_LIMIT'
  | 'SERVER'
  | 'UNKNOWN';

export class AppError extends Error {
  code: ErrorCode;
  details?: any;
  userMessage: string;
  constructor(code: ErrorCode, message: string, details?: any, userMessage?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.userMessage = userMessage || defaultUserMessage(code, message);
  }
}

function defaultUserMessage(code: ErrorCode, message: string): string {
  switch (code) {
    case 'NETWORK':
      return 'Cannot reach the CRM backend. Check your internet connection and try again.';
    case 'TIMEOUT':
      return 'The backend took too long to respond. Please try again.';
    case 'AUTH_REQUIRED':
      // A suspended company ends every session with an explanation worth showing as is.
      return /suspend/i.test(message || '') ? message : 'Your session has expired. Please sign in again.';
    case 'FORBIDDEN':
      // The server explains refusals in plain words (role, plan feature, suspended company…).
      return message && message !== 'Backend error' ? message : 'You do not have permission to do that.';
    case 'NOT_FOUND':
      return message || 'The record was not found.';
    case 'VALIDATION':
      return message || 'Some of the information entered is not valid.';
    case 'CONFLICT':
      return message || 'This record was changed elsewhere. Please review and retry.';
    case 'NOT_CONFIGURED':
      return message || 'This feature is not configured yet. Ask an administrator to set it up in Settings.';
    case 'RATE_LIMIT':
      return 'Too many requests. Please wait a moment and try again.';
    default:
      return message || 'Something went wrong. The error has been logged.';
  }
}

export function toAppError(err: unknown, fallbackCode: ErrorCode = 'UNKNOWN'): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return new AppError('TIMEOUT', err.message);
    if (/failed to fetch|networkerror|load failed/i.test(err.message)) return new AppError('NETWORK', err.message);
    return new AppError(fallbackCode, err.message);
  }
  return new AppError(fallbackCode, String(err));
}

export interface ErrorRecord {
  id: string;
  at: string;
  scope: string;
  code: string;
  message: string;
  stack?: string;
  context?: any;
}

type Reporter = (rec: ErrorRecord) => void;

const buffer: ErrorRecord[] = [];
let remoteReporter: Reporter | null = null;
let lastRemoteAt = 0;
const REMOTE_MIN_GAP_MS = 5_000;

const SECRET_RE = /(api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?[^"',\s]+/gi;
export function scrub(s: string): string {
  return String(s || '').replace(SECRET_RE, (m) => m.replace(/[:=]\s*["']?[^"',\s]+$/, ': [redacted]'));
}

export function setErrorReporter(fn: Reporter | null) {
  remoteReporter = fn;
}

export function reportError(scope: string, err: unknown, context?: any): AppError {
  const e = toAppError(err);
  const rec: ErrorRecord = {
    id: `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    at: new Date().toISOString(),
    scope,
    code: e.code,
    message: scrub(e.message),
    stack: e.stack ? scrub(e.stack).split('\n').slice(0, 6).join('\n') : undefined,
    context: context ? safeContext(context) : undefined,
  };
  buffer.unshift(rec);
  if (buffer.length > 100) buffer.pop();
  // eslint-disable-next-line no-console
  console.error(`[CRM][${scope}]`, e.code, e.message, context || '');
  if (remoteReporter && Date.now() - lastRemoteAt > REMOTE_MIN_GAP_MS && e.code !== 'NETWORK' && e.code !== 'AUTH_REQUIRED') {
    lastRemoteAt = Date.now();
    try {
      remoteReporter(rec);
    } catch {
      /* never throw from the reporter */
    }
  }
  return e;
}

function safeContext(ctx: any) {
  try {
    const s = JSON.stringify(ctx);
    return JSON.parse(scrub(s.length > 2000 ? s.slice(0, 2000) : s));
  } catch {
    return String(ctx).slice(0, 500);
  }
}

export function getErrorBuffer(): ErrorRecord[] {
  return [...buffer];
}

export function clearErrorBuffer() {
  buffer.length = 0;
}
