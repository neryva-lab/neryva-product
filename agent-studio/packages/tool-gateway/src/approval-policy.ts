/**
 * approval-policy.ts — human approval bridge policy
 * Source: agent_studio_architecture.md:328-336, agent_studio_implementation_plan.md:1102-1117
 * Approval is durable, auditable, idempotent, scoped to org/run/tool_call/approval_id/policy_version.
 */

export interface ApprovalRequest {
  approvalId: string;
  organizationId: string;
  runId: string;
  toolCallId: string;
  stepId: string;
  toolId: string;
  toolVersion: string;
  effectClass: string;
  policyVersion: string;
  requestedAt: string; // ISO
  expiresAt?: string | undefined;
  argsDigest?: string | undefined; // hash of args for audit
}

export interface ApprovalDecision {
  approvalId: string;
  toolCallId: string;
  stepId: string;
  decision: 'APPROVED' | 'DENIED';
  decidedBy: string;
  decidedAt: string;
  reason?: string | undefined;
  correlationId: string; // one-time ID, idempotent
}

export function createApprovalId(runId: string, stepId: string, toolCallId: string): string {
  return `aprv_${runId.slice(0, 8)}_${stepId.slice(0, 8)}_${toolCallId.slice(0, 8)}`;
}

export function isApprovalExpired(request: ApprovalRequest, now: Date = new Date()): boolean {
  if (!request.expiresAt) return false;
  return new Date(request.expiresAt) <= now;
}

export function validateApprovalDecision(
  request: ApprovalRequest,
  decision: ApprovalDecision,
): { ok: true } | { ok: false; reason: string } {
  if (request.approvalId !== decision.approvalId)
    return { ok: false, reason: 'approvalId mismatch' };
  if (request.toolCallId !== decision.toolCallId)
    return { ok: false, reason: 'toolCallId mismatch' };
  if (request.stepId !== decision.stepId) return { ok: false, reason: 'stepId mismatch' };
  if (isApprovalExpired(request)) return { ok: false, reason: 'approval expired' };
  return { ok: true };
}
