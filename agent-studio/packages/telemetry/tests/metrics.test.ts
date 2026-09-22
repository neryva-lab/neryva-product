import { describe, it, expect, beforeEach } from 'vitest';
import {
  incrementCounter,
  recordHistogram,
  getMetricSnapshot,
  resetMetrics,
} from '../src/metrics.js';

describe('metrics (1160 low-cardinality, 1159 no high-cardinality, 1158 usage not from spans)', () => {
  beforeEach(() => resetMetrics());

  it('increments counters with low-cardinality labels', () => {
    incrementCounter('workflow_started_total', {
      service: 'runtime-worker',
      task_queue: 'agent-run-default',
    });
    incrementCounter('workflow_started_total', {
      service: 'runtime-worker',
      task_queue: 'agent-run-default',
    });
    const snap = getMetricSnapshot();
    const key = Object.keys(snap.counters).find((k) => k.includes('workflow_started_total'));
    expect(key).toBeDefined();
    if (!key) throw new Error('missing key');
    expect(snap.counters[key]).toBe(2);
  });

  it('rejects high-cardinality labels (raw user IDs, message text)', () => {
    expect(() =>
      incrementCounter('provider_errors_total', { user_id: 'user_123' } as unknown as Record<
        string,
        string
      >),
    ).toThrow(/high-cardinality/);
    expect(() =>
      incrementCounter('provider_errors_total', {
        message_text: 'hello world',
      } as unknown as Record<string, string>),
    ).toThrow();
    expect(() =>
      incrementCounter('provider_errors_total', { tool_args: '{"secret":1}' } as unknown as Record<
        string,
        string
      >),
    ).toThrow();
  });

  it('records histograms for provider latency', () => {
    recordHistogram('provider_latency_ms', 123, { provider: 'openai', model: 'gpt-4' });
    recordHistogram('provider_latency_ms', 456, { provider: 'openai', model: 'gpt-4' });
    const snap = getMetricSnapshot();
    const key = Object.keys(snap.histograms).find((k) => k.includes('provider_latency_ms'));
    if (!key) throw new Error('missing key');
    expect(snap.histograms[key]).toEqual([123, 456]);
  });

  it('run_events_appended_total tracks durable appends', () => {
    incrementCounter('run_events_appended_total', { type: 'RunStarted', outcome: 'success' });
    incrementCounter('run_events_appended_total', {
      type: 'ModelCallCompleted',
      outcome: 'success',
    });
    incrementCounter('run_events_appended_total', { type: 'RunFailed', outcome: 'error' });
    const snap = getMetricSnapshot();
    expect(
      Object.keys(snap.counters).filter((k) => k.includes('run_events_appended_total')).length,
    ).toBe(3);
  });

  it('tool_denials, approval_age, budget_exhausted, mcp_errors, event_lag, artifact_failures', () => {
    incrementCounter('tool_denials_total', { tool: 'create_ticket', reason: 'policy' });
    recordHistogram('approval_age_ms', 5000, { outcome: 'approved' });
    incrementCounter('budget_exhausted_total', { budget: 'token' });
    incrementCounter('mcp_errors_total', { method: 'AppendRunEvents', code: 'UNAVAILABLE' });
    recordHistogram('event_lag_ms', 200, { lag: 'p95' });
    incrementCounter('artifact_failures_total', {
      purpose: 'TOOL_RESULT',
      reason: 'checksum_mismatch',
    });
    const snap = getMetricSnapshot();
    expect(snap.counters['tool_denials_total{tool="create_ticket",reason="policy"}']).toBe(1);
    const hist = snap.histograms['approval_age_ms{outcome="approved"}'];
    expect(hist).toEqual([5000]);
  });

  it('reset clears', () => {
    incrementCounter('workflow_started_total');
    resetMetrics();
    expect(Object.keys(getMetricSnapshot().counters).length).toBe(0);
  });
});
