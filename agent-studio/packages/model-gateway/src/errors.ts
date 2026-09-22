/**
 * errors.ts — gateway error normalization (provider → NeryvaProviderError)
 * Source: agent_studio_implementation_plan.md:877-886
 */

import { NeryvaProviderError } from '@neryva/contracts/provider/errors';

export function isProviderError(e: unknown): e is NeryvaProviderError {
  return e instanceof NeryvaProviderError;
}

export function normalizeUnknownError(e: unknown, providerId?: string): NeryvaProviderError {
  if (isProviderError(e)) return e;
  const msg = e instanceof Error ? e.message : String(e);
  // Heuristic classification based on message / status
  const lower = msg.toLowerCase();
  if (lower.includes('timeout') || lower.includes('deadline')) {
    return new NeryvaProviderError({ code: 'TIMEOUT', message: msg, retryable: true, providerId });
  }
  if (lower.includes('rate limit') || lower.includes('429')) {
    // Try to extract retry-after
    const m = msg.match(/retry[-\s]?after\s*(\d+)/i);
    const retryAfterMs = m?.[1] ? Number(m[1]) * 1000 : undefined;
    return new NeryvaProviderError({
      code: 'RATE_LIMITED',
      message: msg,
      retryable: true,
      retryAfterMs,
      providerId,
    });
  }
  if (
    lower.includes('unauthorized') ||
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('auth')
  ) {
    return new NeryvaProviderError({
      code: 'AUTH_FAILED',
      message: msg,
      retryable: false,
      providerId,
    });
  }
  if (
    lower.includes('context length') ||
    lower.includes('max_tokens') ||
    lower.includes('too long')
  ) {
    return new NeryvaProviderError({
      code: 'CONTEXT_LENGTH_EXCEEDED',
      message: msg,
      retryable: false,
      providerId,
    });
  }
  if (lower.includes('unsupported') || lower.includes('not supported')) {
    return new NeryvaProviderError({
      code: 'UNSUPPORTED_FEATURE',
      message: msg,
      retryable: false,
      providerId,
    });
  }
  if (msg.includes('CANCELLED') || lower.includes('aborted')) {
    return new NeryvaProviderError({
      code: 'CANCELLED',
      message: msg,
      retryable: false,
      providerId,
    });
  }
  return new NeryvaProviderError({ code: 'UNKNOWN', message: msg, retryable: false, providerId });
}

export function mapHttpStatusToCode(status: number): NeryvaProviderError['code'] {
  if (status === 400) return 'INVALID_REQUEST';
  if (status === 401 || status === 403) return 'AUTH_FAILED';
  if (status === 404) return 'NOT_FOUND';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'PROVIDER_UNAVAILABLE';
  return 'UNKNOWN';
}
