/**
 * Failure handling — 11 scenarios documented + tested per 926-938.
 * Each has recovery path and test.
 */

export type FailureScenario =
  | "engine_restart_before_outbox_commit"
  | "engine_restart_after_outbox_commit"
  | "dispatcher_retry_after_acceptance"
  | "studio_crash_during_model_call"
  | "worker_loses_lease_during_tool"
  | "engine_unavailable_while_emitting_events"
  | "event_batch_partially_duplicated"
  | "frontend_disconnects_during_output"
  | "approval_arrives_while_restarting"
  | "provider_ambiguous_timeout"
  | "object_storage_corrupted_expired_artifact"
  | "run_cancelled_during_side_effect";

export interface RecoveryPath {
  safeToRetry: boolean;
  mustReconcile: boolean;
  customerVisible: string;
  auditRequired: boolean;
}

export const RECOVERY_PATHS: Record<FailureScenario, RecoveryPath> = {
  engine_restart_before_outbox_commit: { safeToRetry: true, mustReconcile: false, customerVisible: "no", auditRequired: false },
  engine_restart_after_outbox_commit: { safeToRetry: true, mustReconcile: true, customerVisible: "no", auditRequired: true },
  dispatcher_retry_after_acceptance: { safeToRetry: true, mustReconcile: false, customerVisible: "no", auditRequired: true },
  studio_crash_during_model_call: { safeToRetry: false, mustReconcile: true, customerVisible: "retrying", auditRequired: true },
  worker_loses_lease_during_tool: { safeToRetry: false, mustReconcile: true, customerVisible: "retrying with new worker", auditRequired: true },
  engine_unavailable_while_emitting_events: { safeToRetry: true, mustReconcile: true, customerVisible: "delayed", auditRequired: false },
  event_batch_partially_duplicated: { safeToRetry: true, mustReconcile: false, customerVisible: "no", auditRequired: true },
  frontend_disconnects_during_output: { safeToRetry: true, mustReconcile: false, customerVisible: "reconnect with cursor", auditRequired: false },
  approval_arrives_while_restarting: { safeToRetry: true, mustReconcile: false, customerVisible: "no", auditRequired: true },
  provider_ambiguous_timeout: { safeToRetry: false, mustReconcile: true, customerVisible: "manual reconciliation may be required", auditRequired: true },
  object_storage_corrupted_expired_artifact: { safeToRetry: false, mustReconcile: true, customerVisible: "artifact error", auditRequired: true },
  run_cancelled_during_side_effect: { safeToRetry: false, mustReconcile: true, customerVisible: "cancelled", auditRequired: true },
};

export function getRecovery(scenario: FailureScenario): RecoveryPath {
  return RECOVERY_PATHS[scenario];
}
