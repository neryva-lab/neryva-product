/**
 * recovery.ts — run-client recovery envelope for worker restarts.
 *
 * Wave 4 workstream 3 (GAP 2): the runtime-worker's per-run MCP clients live
 * only in an in-memory Map. When a worker is killed and Temporal replays the
 * workflow on a fresh worker, the completed admission activity
 * (`acquireOrRenewRunLease`) is NOT re-executed — so the retried later
 * activity finds no claimed client and fails with MCP_RUN_NOT_CLAIMED, and
 * the workflow's own `failRun` reconciliation fails the same way (leaving
 * the Engine row non-terminal while Temporal marks the workflow FAILED).
 *
 * The fix: the workflow attaches a small recovery envelope — run scope, the
 * Engine-issued dispatch capability, and the expected lease epoch — as an
 * OPTIONAL TRAILING argument to every MCP-dependent activity call. The
 * runtime-worker's activity registry strips the envelope before invoking the
 * real activity; when the run client is missing it reconstructs the client
 * from the dispatch capability and re-acquires/renews the Engine lease
 * BEFORE running the retried activity.
 *
 * Envelope contents are workflow input + deterministic workflow state only
 * (scope, capability relay, lease epoch from the admission result) — safe
 * for workflow replay. The `__neryvaRecovery` brand distinguishes the
 * envelope from real activity arguments.
 */

/** Run scope carried by the recovery envelope (mirrors the MCP RunScope). */
export interface RecoveryScope {
  organizationId: string;
  conversationId: string;
  runId: string;
  agentVersionId: string;
  actorId: string;
}

/**
 * Recovery material the workflow passes as the trailing argument of every
 * MCP-dependent activity invocation. All fields are plain JSON — Temporal
 * payload-safe.
 */
export interface RecoveryMaterial {
  /** Brand marker — distinguishes the envelope from real activity arguments. */
  __neryvaRecovery: true;
  /** Run scope the client must be reconstructed for. */
  scope: RecoveryScope;
  /** Engine-issued dispatch capability JWT (relayed through workflow input). */
  capabilityToken?: string;
  /** Engine request-context capability id (relayed through workflow input). */
  capabilityId?: string;
  /** Lease epoch from admission; omitted before admission completes. */
  expectedLeaseEpoch?: number;
}

/** Type guard for the trailing-argument envelope. */
export function isRecoveryMaterial(value: unknown): value is RecoveryMaterial {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v['__neryvaRecovery'] !== true) return false;
  const scope = v['scope'];
  if (typeof scope !== 'object' || scope === null) return false;
  const s = scope as Record<string, unknown>;
  return (
    typeof s['organizationId'] === 'string' &&
    typeof s['conversationId'] === 'string' &&
    typeof s['runId'] === 'string' &&
    typeof s['agentVersionId'] === 'string' &&
    typeof s['actorId'] === 'string'
  );
}

/**
 * Adds an optional trailing recovery envelope to every activity signature in
 * T, without changing the underlying activity package signatures. The
 * workflow uses `proxyActivities<WithRecovery<McpActivities>>` (etc.); the
 * runtime-worker registry strips the envelope before dispatch.
 *
 * Zero-argument activities become `(recovery?: RecoveryMaterial) => R`;
 * scalar-argument activities become `(arg, recovery?) => R`.
 */
export type WithRecovery<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: [...A, recovery?: RecoveryMaterial]) => R
    : T[K];
};

/** Error prefix thrown when run-client reconstruction fails. Never swallowed silently. */
export const RECOVERY_FAILED_PREFIX = 'RUN_RECOVERY_FAILED:';
