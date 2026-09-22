/**
 * retry.test.ts — retry only idempotent, respects non-retryable
 * Source: ledger.md:2.5
 */

import { describe, it, expect, vi } from 'vitest';
import { Code, ConnectError } from '@connectrpc/connect';
import { withRetry } from '../src/retry.js';

describe('retry', () => {
  it('retries on UNAVAILABLE (idempotent)', async () => {
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new ConnectError('unavailable', Code.Unavailable);
      return 'ok';
    });
    const res = await withRetry(fn, { maxAttempts: 3, maxElapsedMs: 5000 });
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does not retry on ABORTED (non-retryable)', async () => {
    const fn = vi.fn(async () => {
      throw new ConnectError('aborted', Code.Aborted);
    });
    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not retry capability expiry (StudioError non-retryable)', async () => {
    const { StudioError } = await import('@neryva/agent-kernel');
    const fn = vi.fn(async () => {
      throw new StudioError({
        code: 'CAPABILITY_DENIED',
        message: 'expired',
        retryable: 'non-retryable',
      });
    });
    await expect(withRetry(fn)).rejects.toThrow(/expired/);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
