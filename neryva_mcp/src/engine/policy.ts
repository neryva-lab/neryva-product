/**
 * Policy service — re-authorizes every operation (service identity alone insufficient).
 * Reference: neryva_mcp_implementation_plan.md:97,1064, 124, 566
 *
 * For Phase 2 spike: simple in-memory policy checks.
 * Production: DB-backed policy with versioning, RBAC, org membership, etc.
 */

import { authorizationError } from "../shared/errors.js";
import { globalStore } from "./store.js";

export interface PolicyContext {
  organizationId: string;
  conversationId?: string;
  runId?: string;
  actorId: string;
  capabilityId: string;
  operation: string;
  traceId?: string;
}

export function authorize(ctx: PolicyContext, opts: { policyVersion?: string } = {}): { allowed: boolean; reason: string; policyVersion: string } {
  // 1. Check organization membership (stub: actor must be non-empty, org must exist)
  if (!ctx.organizationId || !ctx.actorId) throw authorizationError("missing organization or actor");
  // 2. Check conversation ownership if provided
  if (ctx.conversationId) {
    const conv = globalStore.getConversation(ctx.conversationId);
    if (conv && conv.organizationId !== ctx.organizationId) throw authorizationError(`conversation ${ctx.conversationId} not owned by org ${ctx.organizationId}`);
    if (conv?.deletedAt) throw authorizationError(`conversation ${ctx.conversationId} is deleted`);
  }
  // 3. Check run ownership if provided
  if (ctx.runId) {
    const run = globalStore.getRun(ctx.runId);
    if (run && run.organizationId !== ctx.organizationId) throw authorizationError(`run ${ctx.runId} not owned by org ${ctx.organizationId}`);
    if (ctx.conversationId && run && run.conversationId !== ctx.conversationId) throw authorizationError(`run ${ctx.runId} not owned by conv ${ctx.conversationId}`);
  }
  // 4. Capability scope check (stub: capabilityId must be non-empty, not widen scope)
  if (!ctx.capabilityId) throw authorizationError("capability required");
  // 5. Operation allowlist (stub: all operations allowed for spike, but would check policyVersion)
  const policyVersion = opts.policyVersion ?? "policy_v1";
  // Audit log for every privileged decision
  globalStore.appendAudit({
    actorId: ctx.actorId,
    service: "PolicyService",
    operation: ctx.operation,
    resource: ctx.runId ?? ctx.conversationId ?? ctx.organizationId,
    organizationId: ctx.organizationId,
    decision: "allow",
    policyVersion,
    traceId: ctx.traceId,
    reason: "policy allow",
  });
  return { allowed: true, reason: "policy allow", policyVersion };
}

export function isPrivilegedOperation(op: string): boolean {
  const privileged = new Set([
    "StartRun",
    "AcquireOrRenewRunLease",
    "CommitRunResult",
    "FailRun",
    "CreateApprovalRequest",
    "AuthorizeToolCall",
    "GetAuthorizedRunContext",
    "GetRunArtifact",
    "AppendRunEvents",
  ]);
  return privileged.has(op);
}
