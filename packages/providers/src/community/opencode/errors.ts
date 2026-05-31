const RATE_LIMIT_PATTERNS = ['rate limit', 'too many requests', '429', 'overloaded'];
const AUTH_PATTERNS = ['unauthorized', 'authentication', 'invalid token', '401', '403', 'api key'];
const CRASH_PATTERNS = [
  'server disconnected',
  'disposed',
  'econnreset',
  'socket hang up',
  'connection terminated',
  'process terminated',
];
const AGENT_NOT_FOUND_PATTERNS = [
  'agent not found',
  'unknown agent',
  'invalid agent',
  'no agent named',
];

export type OpencodeErrorClass =
  | 'account_limit'
  | 'rate_limit'
  | 'auth'
  | 'crash'
  | 'agent_not_found'
  | 'unknown'
  | 'aborted';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error)) {
    if (typeof error.message === 'string') return error.message;
    if (isRecord(error.data) && typeof error.data.message === 'string') return error.data.message;
  }
  return String(error);
}

export function statusError(status: unknown): Error | undefined {
  if (!isRecord(status)) return undefined;
  if (status.type !== 'retry') return undefined;

  const action = isRecord(status.action) ? status.action : undefined;
  const reason = typeof action?.reason === 'string' ? action.reason : undefined;
  if (reason !== 'account_rate_limit') return undefined;

  const message =
    typeof status.message === 'string' && status.message.length > 0
      ? status.message
      : 'OpenCode account rate limit reached';
  const err = new Error(message);
  err.name = 'OpenCodeAccountLimitError';
  err.cause = status;
  return err;
}

export function classifyOpencodeError(error: unknown, aborted: boolean): OpencodeErrorClass {
  if (aborted) return 'aborted';

  const parts: string[] = [];
  if (error instanceof Error) {
    parts.push(error.name, error.message);
  }
  if (isRecord(error)) {
    if (typeof error.name === 'string') parts.push(error.name);
    if (typeof error.message === 'string') parts.push(error.message);
    if (typeof error.statusCode === 'number') parts.push(String(error.statusCode));
    if (isRecord(error.data)) {
      if (typeof error.data.message === 'string') parts.push(error.data.message);
      if (typeof error.data.statusCode === 'number') parts.push(String(error.data.statusCode));
      if (typeof error.data.responseBody === 'string') parts.push(error.data.responseBody);
    }
  }

  const combined = parts.join(' ').toLowerCase();
  if (error instanceof Error && error.name === 'OpenCodeAccountLimitError') {
    return 'account_limit';
  }
  if (combined.includes('account_rate_limit')) return 'account_limit';
  if (RATE_LIMIT_PATTERNS.some(pattern => combined.includes(pattern))) return 'rate_limit';
  if (AUTH_PATTERNS.some(pattern => combined.includes(pattern))) return 'auth';
  if (CRASH_PATTERNS.some(pattern => combined.includes(pattern))) return 'crash';
  if (AGENT_NOT_FOUND_PATTERNS.some(pattern => combined.includes(pattern)))
    return 'agent_not_found';
  return 'unknown';
}

export function enrichOpencodeError(error: unknown, errorClass: OpencodeErrorClass): Error {
  if (errorClass === 'aborted') {
    return new Error('OpenCode query aborted');
  }

  const err = new Error(`OpenCode ${errorClass}: ${errorMessage(error)}`);
  if (error instanceof Error) err.cause = error;
  return err;
}
