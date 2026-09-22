/**
 * Persistence hardening — unique constraints, append-only audit, encrypted object storage.
 * Reference: neryva_mcp_implementation_plan.md:776, 784-796, 800-801
 */

export const UNIQUE_CONSTRAINTS = [
  "runs PK run_id",
  "runs FK conversation_id → conversations (org match)",
  "run_events PK (run_id, event_id) + per-run sequence monotonic",
  "run_idempotency PK (scope, key) + digest",
  "run_steps PK (run_id, step_id, attempt)",
  "approvals PK approval_id",
  "memory_proposals PK proposal_id",
  "checkpoints PK (run_id, version)",
  "tool_effects PK (run_id, tool_call_id)",
  "outbox PK id",
  "audit_log append-only, indexed by trace",
  "usage_ledger append-only",
] as const;

export const ENCRYPTED_STORAGE = {
  note: "Large content in encrypted object storage, metadata + authorization in Engine DB (776)",
  allowedPurposes: ["checkpoint", "kb_document", "tool_output", "assistant_output"],
  encryption: "envelope + KMS, key policy validated in claimCheck 7 checks",
  retention: "tombstone on delete, verify fails even with old ref (1166)",
};

export function isAppendOnly(table: string): boolean {
  return ["audit_log", "usage_ledger", "run_events"].includes(table);
}

export function validateUniqueConstraint(table: string, key: string, existingKeys: Set<string>): void {
  if (existingKeys.has(key)) throw new Error(`unique constraint violation: ${table} ${key} already exists`);
}
