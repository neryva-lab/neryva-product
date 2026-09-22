/**
 * workflow-timeouts.ts — per-Activity class timeout/retry budgets
 * Source: agent_studio_implementation_plan.md:808-825, 813-825
 * No blanket retry. Each class has distinct schedule-to-start / start-to-close / heartbeat.
 * Retry ownership explicit: provider hints but workflow applies one bounded policy, never blindly retry effectful.
 */

/**
 * Timeout budgets — all durations in Temporal duration string format.
 * Chosen for testability and boundedness; not copied from folklore.
 */
export const ACTIVITY_TIMEOUTS = {
  // MCP — short, idempotent, retryable (except terminal/capability)
  mcp: {
    scheduleToStart: '10s',
    startToClose: '15s',
    heartbeatTimeout: undefined as string | undefined,
  },
  // Context compilation — pure Engine fetch via MCP, no provider
  context: {
    scheduleToStart: '10s',
    startToClose: '20s',
    heartbeatTimeout: undefined,
  },
  // Model provider — may be long, needs heartbeat for streaming
  model: {
    scheduleToStart: '10s',
    startToClose: '60s',
    heartbeatTimeout: '20s',
  },
  // Read-only tool — short, idempotent
  toolReadOnly: {
    scheduleToStart: '10s',
    startToClose: '30s',
    heartbeatTimeout: '15s',
  },
  // Effectful tool — longer, idempotent via stable key, heartbeat for progress
  toolEffectful: {
    scheduleToStart: '10s',
    startToClose: '45s',
    heartbeatTimeout: '15s',
  },
  // Approval — no timeout scheduled; workflow waits on Signal indefinitely (human)
  // Activity is only creation which is MCP-backed short
  approval: {
    scheduleToStart: '10s',
    startToClose: '15s',
    heartbeatTimeout: undefined,
  },
  // Artifact — S3 claim-check, may be large
  artifact: {
    scheduleToStart: '10s',
    startToClose: '30s',
    heartbeatTimeout: '15s',
  },
  // Memory/retrieval — hybrid lexical+vector, bounded
  memory: {
    scheduleToStart: '10s',
    startToClose: '20s',
    heartbeatTimeout: undefined,
  },
  // Usage/finalization — idempotent CommitRunResult, short but retried with stable key
  finalization: {
    scheduleToStart: '10s',
    startToClose: '15s',
    heartbeatTimeout: undefined,
  },
} as const;

export type ActivityClass = keyof typeof ACTIVITY_TIMEOUTS;

/**
 * Retry policies per class — explicit ownership (140).
 * Never blindly retry effectful tool or finalization without stable key; respect retry-after.
 */
export const RETRY_POLICIES = {
  mcp: {
    maximumAttempts: 3,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '2s',
    nonRetryableErrorTypes: [
      'SCOPE_MISMATCH',
      'CAPABILITY_DENIED',
      'TERMINAL_RUN',
      'PROTOCOL_MISMATCH',
    ],
  },
  context: {
    maximumAttempts: 2,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    nonRetryableErrorTypes: ['SCOPE_MISMATCH', 'CAPABILITY_EXPIRED', 'UNAUTHORIZED_CONTEXT'],
  },
  model: {
    maximumAttempts: 2,
    initialInterval: '500ms',
    backoffCoefficient: 2,
    maximumInterval: '2s',
    // Provider timeout/rate-limit may be retryable; auth/invalid not
    nonRetryableErrorTypes: [
      'PROVIDER_AUTH_FAILED',
      'INVALID_REQUEST',
      'UNSUPPORTED_FEATURE',
      'BUDGET_EXHAUSTED',
    ],
  },
  toolReadOnly: {
    maximumAttempts: 2,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    nonRetryableErrorTypes: ['TOOL_NOT_FOUND', 'SCHEMA_VALIDATION_FAILED', 'POLICY_DENIED'],
  },
  toolEffectful: {
    maximumAttempts: 1, // At-most-once unless downstream dedup confirms UNKNOWN_OUTCOME reconciliation
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    nonRetryableErrorTypes: [
      'TOOL_NOT_FOUND',
      'APPROVAL_DENIED',
      'POLICY_DENIED',
      'UNKNOWN_OUTCOME',
    ],
  },
  approval: {
    maximumAttempts: 2,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    nonRetryableErrorTypes: ['APPROVAL_ALREADY_DECIDED', 'SCOPE_MISMATCH'],
  },
  artifact: {
    maximumAttempts: 2,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    nonRetryableErrorTypes: ['ARTIFACT_NOT_FOUND', 'CHECKSUM_MISMATCH', 'ARTIFACT_EXPIRED'],
  },
  memory: {
    maximumAttempts: 2,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '1s',
    nonRetryableErrorTypes: ['SCOPE_MISMATCH', 'UNAUTHORIZED_RETRIEVAL'],
  },
  finalization: {
    // Idempotent CommitRunResult: safe to retry with same idempotency key (neryva_mcp_implementation_plan.md:448-449)
    maximumAttempts: 5,
    initialInterval: '200ms',
    backoffCoefficient: 2,
    maximumInterval: '2s',
    nonRetryableErrorTypes: ['SCOPE_MISMATCH', 'TERMINAL_RUN', 'ALREADY_COMMITTED'],
  },
} as const;

export function heartbeatRequired(activityClass: ActivityClass): boolean {
  return ACTIVITY_TIMEOUTS[activityClass].heartbeatTimeout !== undefined;
}
