/**
 * retry-safety.test.ts — retry only idempotent; never blindly retry effectful without stable key
 * Source: agent_studio_implementation_plan.md:665-672, 813-825
 */

import { describe, it, expect } from 'vitest';
import { ACTIVITY_OPTIONS, toTemporalActivityOptions } from '../src/activity-options.js';

describe('retry safety per Activity class', () => {
  it('finalization is idempotent and retried up to 5', () => {
    expect(ACTIVITY_OPTIONS.finalization.retry.maximumAttempts).toBe(5);
    expect(ACTIVITY_OPTIONS.finalization.retry.nonRetryableErrorTypes).toContain('TERMINAL_RUN');
  });

  it('toolEffectful is at-most-once (maxAttempts 1) unless UNKNOWN_OUTCOME reconciliation', () => {
    expect(ACTIVITY_OPTIONS.toolEffectful.retry.maximumAttempts).toBe(1);
    expect(ACTIVITY_OPTIONS.toolEffectful.retry.nonRetryableErrorTypes).toContain(
      'UNKNOWN_OUTCOME',
    );
  });

  it('mcp respects capability expiry terminal as non-retryable', () => {
    expect(ACTIVITY_OPTIONS.mcp.retry.nonRetryableErrorTypes).toContain('CAPABILITY_DENIED');
    expect(ACTIVITY_OPTIONS.mcp.retry.nonRetryableErrorTypes).toContain('TERMINAL_RUN');
  });

  it('no blanket retry — each class distinct', () => {
    const keys = Object.keys(ACTIVITY_OPTIONS) as Array<keyof typeof ACTIVITY_OPTIONS>;
    const attempts = keys.map((k) => ACTIVITY_OPTIONS[k].retry.maximumAttempts);
    // Not all same
    expect(new Set(attempts).size).toBeGreaterThan(1);
  });

  it('toTemporalActivityOptions preserves heartbeatTimeout for model/tool', () => {
    expect(toTemporalActivityOptions('model').heartbeatTimeout).toBe('20s');
    expect(toTemporalActivityOptions('toolEffectful').heartbeatTimeout).toBe('15s');
    expect(toTemporalActivityOptions('mcp').heartbeatTimeout).toBeUndefined();
  });

  it('model does not retry on auth / budget', () => {
    expect(ACTIVITY_OPTIONS.model.retry.nonRetryableErrorTypes).toContain('PROVIDER_AUTH_FAILED');
    expect(ACTIVITY_OPTIONS.model.retry.nonRetryableErrorTypes).toContain('BUDGET_EXHAUSTED');
  });
});
