/**
 * recovery-material.ts — workflow-side half of the run-client recovery envelope.
 *
 * Wave 4 workstream 3 (GAP 2): the runtime-worker's per-run MCP clients live
 * only in an in-memory Map. When a worker is killed and Temporal replays the
 * workflow on a fresh worker, the completed admission activity is NOT
 * re-executed — so the retried later activity finds no claimed client and
 * fails with MCP_RUN_NOT_CLAIMED.
 *
 * The workflow attaches this envelope as a REQUIRED TRAILING argument to
 * every MCP-dependent activity call (enforced by the `WithRecovery` type —
 * forgetting it fails `tsc`). The runtime-worker's activity registry
 * strips it before invoking the real activity; when the run client is
 * missing it reconstructs the client from the dispatch capability and
 * re-acquires/renews the Engine lease BEFORE running the retried activity.
 *
 * The shape mirrors `@neryva/activities` recovery.ts (the registry side).
 * It is duplicated here rather than imported because the workflow bundle
 * cannot take a runtime dependency on @neryva/activities (deterministic
 * bundle rule) — the workflow already hand-defines its local activity
 * interfaces for the same reason. Types are structural; only the brand
 * marker, field names, and RECOVERY_FAILED_PREFIX must match exactly.
 *
 * All fields are workflow input or deterministic workflow state — safe for
 * replay. Everything is plain JSON (Temporal payload-safe).
 */

/** Run scope carried by the recovery envelope. */
export interface RecoveryMaterial {
  /** Brand marker — distinguishes the envelope from real activity arguments. */
  __neryvaRecovery: true;
  scope: {
    organizationId: string;
    conversationId: string;
    runId: string;
    agentVersionId: string;
    actorId: string;
  };
  /** Engine-issued dispatch capability JWT (relayed through workflow input). */
  capabilityToken?: string;
  /** Engine request-context capability id (relayed through workflow input). */
  capabilityId?: string;
  /** Lease epoch from admission; omitted before admission completes. */
  expectedLeaseEpoch?: number;
}

/**
 * Adds a REQUIRED trailing recovery envelope to every activity signature in
 * T, without changing the underlying activity signatures. The workflow uses
 * `proxyActivities<WithRecovery<McpActivities>>` (etc.).
 *
 * The envelope is mandatory at the type level: any new MCP-dependent call
 * site that forgets it fails `tsc`, which is what prevents a regression of
 * the Wave 4 worker-kill divergence (Temporal FAILED while the Engine row
 * stayed non-terminal because failRun itself could not run on a fresh
 * worker). Activities that are not MCP-dependent (admission bootstrap
 * `acquireOrRenewRunLease`, local guardrail `moderateContent`) are NOT
 * wrapped with this type and keep their original signatures.
 */
export type WithRecovery<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: [...A, recovery: RecoveryMaterial]) => R
    : T[K];
};

/**
 * Error prefix the registry's recovery wrapper throws when run-client
 * reconstruction fails. The workflow treats this as a loud reconciliation
 * failure (never silently swallowed).
 */
export const RECOVERY_FAILED_PREFIX = 'RUN_RECOVERY_FAILED:';
