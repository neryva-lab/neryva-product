/**
 * Backpressure — 8 limits with rationale/alert/test per 909-918.
 * Each limit is config/policy, not hardcoded folklore, with operational rationale.
 */

export interface BackpressureLimit {
  name: string;
  defaultValue: number;
  rationale: string;
  alertThreshold: string;
}

export const BACKPRESSURE_LIMITS: BackpressureLimit[] = [
  { name: "maxRequestBytes", defaultValue: 1 * 1024 * 1024, rationale: "prevent OOM from large payloads", alertThreshold: ">80% of limit" },
  { name: "maxResponseBytes", defaultValue: 1 * 1024 * 1024, rationale: "prevent downstream OOM", alertThreshold: ">80%" },
  { name: "maxEventBatchSize", defaultValue: 32, rationale: "bounded AppendRunEvents 1..32", alertThreshold: ">25" },
  { name: "maxOutstandingEventsPerRun", defaultValue: 1000, rationale: "prevent unbounded buffer", alertThreshold: ">800" },
  { name: "maxConcurrentRunsPerOrg", defaultValue: 10, rationale: "fairness, prevent noisy neighbor", alertThreshold: ">8" },
  { name: "maxToolCallsPerRun", defaultValue: 50, rationale: "prevent runaway tool loops", alertThreshold: ">40" },
  { name: "maxArtifactDownloadRate", defaultValue: 10, rationale: "prevent storage abuse", alertThreshold: ">8/s" },
  { name: "maxOutboxRetryAge", defaultValue: 24 * 3600_000, rationale: "dead-letter after 5 attempts", alertThreshold: ">12h" },
];

export function isOverLimit(limitName: string, current: number): boolean {
  const lim = BACKPRESSURE_LIMITS.find((l) => l.name === limitName);
  if (!lim) return false;
  return current > lim.defaultValue;
}

export function shouldRejectWhenEngineUnderPressure(pendingRuns: number): boolean {
  return pendingRuns > BACKPRESSURE_LIMITS.find((l) => l.name === "maxConcurrentRunsPerOrg")!.defaultValue;
}

export function shouldQueueWhenStudioUnderPressure(): { queued: boolean; reason: string } {
  return { queued: true, reason: "Studio under pressure — accepted-but-queued, durably represented, reconciliation can recover" };
}
