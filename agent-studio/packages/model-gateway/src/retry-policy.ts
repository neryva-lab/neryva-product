/**
 * retry-policy.ts — gateway retry (respects Retry-After, never blindly retry effectful)
 * Source: agent_studio_implementation_plan.md:665-672, 877-886
 */

import { NeryvaProviderError } from '@neryva/contracts/provider/errors';

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffFactor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  initialDelayMs: 200,
  maxDelayMs: 2000,
  backoffFactor: 2,
};

export function isRetryable(e: unknown): boolean {
  if (e instanceof NeryvaProviderError) return e.retryable;
  return false;
}

export function getRetryAfterMs(e: unknown): number | undefined {
  if (e instanceof NeryvaProviderError) return e.retryAfterMs;
  return undefined;
}

export function computeDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  retryAfterMs?: number,
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxDelayMs);
  const base = policy.initialDelayMs * Math.pow(policy.backoffFactor, attempt - 1);
  return Math.min(base, policy.maxDelayMs);
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  shouldRetry: (e: unknown) => boolean = isRetryable,
): Promise<T> {
  let attempt = 1;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite retry loop with break
  while (true) {
    try {
      return await fn();
    } catch (e) {
      const retryAfter = getRetryAfterMs(e);
      if (attempt >= policy.maxAttempts || !shouldRetry(e)) throw e;
      const delay = computeDelayMs(attempt, policy, retryAfter);
      await new Promise((r) => setTimeout(r, delay));
      attempt++;
    }
  }
}
