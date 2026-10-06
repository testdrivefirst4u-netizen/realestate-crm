/** Error with a code the browser understands (see src/core/errors.ts → ErrorCode). */
export type ApiErrorCode =
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'VALIDATION'
  | 'CONFLICT'
  | 'NOT_CONFIGURED'
  | 'RATE_LIMIT'
  /** An upstream service (Gemini, Chat360, a recording host) failed; the message is safe to show. */
  | 'SERVER'
  | 'INTERNAL';

export class ApiError extends Error {
  code: ApiErrorCode;
  details?: unknown;
  constructor(code: ApiErrorCode, message: string, details?: unknown) {
    super(message || code);
    this.code = code;
    this.details = details;
  }
}

/** Equivalent of the old U_fail — `throw fail('VALIDATION', 'Name is required')`. */
export function fail(code: ApiErrorCode, message: string, details?: unknown): ApiError {
  return new ApiError(code, message, details);
}

export function ok<T>(data: T) {
  return { status: 'success' as const, data: data === undefined ? null : data };
}

export function errEnvelope(code: string, message: string, details?: unknown) {
  const out: Record<string, unknown> = { status: 'error', code: code || 'INTERNAL', message: String(message || 'Error') };
  if (details !== undefined) out.details = details;
  if (code === 'AUTH_REQUIRED') out.isAuthError = true;
  return out;
}
