/**
 * retry.ts — retry policy for Neryva MCP client
 * Source: agent_studio_implementation_plan.md:663-671, neryva_mcp_implementation_plan.md:218-223
 * Retry only idempotent methods (callers wrap only idempotent RPCs); never blindly retry
 * tool effects/finalization without a stable idempotency key. Respect deadlines and
 * Retry-After; bound attempts; capability expiry/stale-run/authorization denial are
 * terminal (non-retryable).
 */

import { StudioError } from '@neryva/agent-kernel';
import { Code, ConnectError } from '@connectrpc/connect';

export interface RetryOptions {
  maxAttempts: number;
  maxElapsedMs: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryableCodes: Set<number>;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxAttempts: 3,
  maxElapsedMs: 10_000,
  baseDelayMs: 100,
  maxDelayMs: 2_000,
  retryableCodes: new Set([Code.Unavailable, Code.DeadlineExceeded, Code.Canceled]),
};

/** Errors that are always terminal regardless of configured retryable codes. */
const NON_RETRYABLE_CODES = new Set([
  Code.InvalidArgument,
  Code.Unauthenticated,
  Code.PermissionDenied,
  Code.NotFound,
  Code.AlreadyExists,
  Code.FailedPrecondition,
  Code.Aborted,
  Code.Unimplemented,
  Code.Internal,
  Code.DataLoss,
]);

/** Parse a Retry-After header (seconds or HTTP-date) into ms; undefined when absent/invalid. */
export function parseRetryAfterMs(value: string | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) return asSeconds * 1000;
  const asDate = Date.parse(value);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - now);
  return undefined;
}

/**
 * Extract a Retry-After hint from a Connect error (metadata may carry `retry-after`
 * for ResourceExhausted / rate-limited responses).
 */
export function retryAfterMsFromError(err: unknown): number | undefined {
  if (err instanceof ConnectError) {
    const raw = err.metadata.get('retry-after') ?? err.metadata.get('Retry-After');
    if (typeof raw === 'string') return parseRetryAfterMs(raw);
  }
  return undefined;
}

export function isRetryableError(
  error: unknown,
  retryableCodes: Set<number> = DEFAULT_RETRY_OPTIONS.retryableCodes,
): boolean {
  if (error instanceof StudioError) {
    return error.retryable === 'retryable';
  }
  if (!(error instanceof ConnectError)) return false;
  const code = error.code;
  if (NON_RETRYABLE_CODES.has(code)) return false;
  // ResourceExhausted (rate limit) is retryable only when the server supplied Retry-After
  if (code === Code.ResourceExhausted) {
    return retryAfterMsFromError(error) !== undefined;
  }
  return retryableCodes.has(code);
}

/**
 * Exponential backoff with full jitter, capped, honoring server Retry-After when present.
 * Deterministic in ordering; wall-clock use is safe here (activities only, never workflows).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const options: RetryOptions = { ...DEFAULT_RETRY_OPTIONS, ...opts };
  const start = Date.now();
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (err instanceof StudioError && err.code === 'CAPABILITY_DENIED') throw err;
      const retryable = isRetryableError(err, options.retryableCodes);
      const elapsed = Date.now() - start;
      if (!retryable || attempt === options.maxAttempts || elapsed >= options.maxElapsedMs) {
        throw err;
      }
      const serverHint = retryAfterMsFromError(err);
      const exponential = Math.min(
        options.maxDelayMs,
        options.baseDelayMs * Math.pow(2, attempt - 1),
      );
      // Full jitter over the smaller of exponential backoff and server hint window
      const ceiling = serverHint !== undefined ? Math.max(1, Math.min(serverHint, 30_000)) : exponential;
      const delay = Math.floor(Math.random() * ceiling);
      if (opts.onRetry) opts.onRetry(attempt, err, delay);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
