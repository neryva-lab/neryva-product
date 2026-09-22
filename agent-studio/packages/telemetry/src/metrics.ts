/**
 * metrics.ts — OTel metrics + low-cardinality enforcement
 * Source: agent_studio_implementation_plan.md:1137-1162 (emit metrics for workflow starts/completions, activity retries, provider latency/errors, tool denials, approval age, budget exhaustion, MCP errors, event lag, artifact failures 1160),
 * 1159 (avoid high-cardinality labels like raw user IDs), 1158 (usage from Engine ledger not span sums)
 */
import { metrics } from '@opentelemetry/api';
import { validateNoHighCardinality } from './attributes.js';

export type CounterName =
  | 'workflow_started_total'
  | 'workflow_completed_total'
  | 'workflow_failed_total'
  | 'activity_retries_total'
  | 'provider_latency_ms'
  | 'provider_errors_total'
  | 'tool_denials_total'
  | 'approval_age_ms'
  | 'budget_exhausted_total'
  | 'mcp_errors_total'
  | 'event_lag_ms'
  | 'artifact_failures_total'
  | 'run_events_appended_total'
  | 'model_route_fallback_total'
  | 'usage_recorded_total';

const counters = new Map<string, number>();
const histograms = new Map<string, number[]>();

export function incrementCounter(
  name: CounterName,
  labels: Record<string, string> = {},
  value = 1,
): void {
  validateNoHighCardinality(labels as Record<string, unknown>);
  const key = `${name}{${Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',')}}`;
  counters.set(key, (counters.get(key) ?? 0) + value);
  // Also record via OTel if meter available (best-effort)
  try {
    const meter = metrics.getMeter('neryva-agent-studio');
    const counter = meter.createCounter(name);
    counter.add(value, labels);
  } catch {
    // ignore in tests without exporter
  }
}

export function recordHistogram(
  name: CounterName,
  value: number,
  labels: Record<string, string> = {},
): void {
  validateNoHighCardinality(labels as Record<string, unknown>);
  const key = `${name}{${Object.entries(labels)
    .map(([k, v]) => `${k}="${v}"`)
    .join(',')}}`;
  const arr = histograms.get(key) ?? [];
  arr.push(value);
  histograms.set(key, arr);
  try {
    const meter = metrics.getMeter('neryva-agent-studio');
    const hist = meter.createHistogram(name);
    hist.record(value, labels);
  } catch {
    // ignore
  }
}

export function getMetricSnapshot(): {
  counters: Record<string, number>;
  histograms: Record<string, number[]>;
} {
  return {
    counters: Object.fromEntries(counters.entries()),
    histograms: Object.fromEntries(histograms.entries()),
  };
}

export function resetMetrics(): void {
  counters.clear();
  histograms.clear();
}
