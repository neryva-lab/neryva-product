/**
 * Observability — correlation 12 IDs, metrics, audit 12 events.
 * Reference: neryva_mcp_implementation_plan.md:842-852, 858-871, 877-890
 */

export const CORRELATION_IDS = [
  "traceId",
  "spanId",
  "requestId",
  "organizationId", // hashed in shared telemetry
  "conversationId",
  "runId",
  "stepId",
  "toolCallId",
  "eventId",
  "sequence",
  "workflowId", // Temporal Workflow ID
  "providerRequestId",
  // plus idempotencyKeyHash
] as const;

export function sanitizeForLogs(obj: Record<string, unknown>): Record<string, unknown> {
  const redacted = { ...obj };
  const forbidden = ["prompt", "completion", "toolArgs", "credentials", "documentContent", "capabilityToken"];
  for (const k of Object.keys(redacted)) {
    if (forbidden.some((f) => k.toLowerCase().includes(f.toLowerCase()))) {
      redacted[k] = "[REDACTED]";
    }
  }
  return redacted;
}

export const METRICS = [
  "rpc_count, latency, status, payload size by method",
  "authorization denials by reason",
  "idempotency hits and conflicts",
  "event ingestion lag and duplicate rate",
  "outbox age, attempts, dead letters",
  "run queue time, execution time, terminal outcomes",
  "lease expiry and takeover count",
  "approval wait time and expiry rate",
  "checkpoint artifact failures",
  "Temporal Activity retry and heartbeat failures",
  "frontend stream reconnects and cursor gaps",
  "provider usage and cost",
] as const;

export const AUDIT_EVENTS = [
  "run admission and denial",
  "context access and artifact access",
  "policy decisions",
  "tool authorization and execution outcome",
  "approval creation and decision",
  "memory proposal and decision",
  "cancellation and administrative termination",
  "final result commit and failure",
  "capability issue/use/rejection",
  "idempotency conflict",
  "cross-tenant access attempt",
  "schema or protocol compatibility rejection",
] as const;

export function isAuditQueryable(): boolean {
  return true;
}
