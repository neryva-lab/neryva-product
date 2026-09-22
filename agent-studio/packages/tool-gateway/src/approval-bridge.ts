/**
 * approval-bridge.ts — human approval bridge (auditable, correlated, Signal/Update)
 * Source: agent_studio_implementation_plan.md:1102-1117, agent_studio_architecture.md:328-336
 * CreateApprovalRequest → Engine persists + outbox → WAITING_APPROVAL → human via Engine API → decision with one-time ID → DeliverRunInput via outbox → Temporal Signal default, Update only when sync validation needed → workflow validates correlation.
 */

import {
  createApprovalId,
  type ApprovalRequest,
  type ApprovalDecision,
} from './approval-policy.js';

export interface ApprovalBridge {
  createRequest(
    params: Omit<ApprovalRequest, 'requestedAt' | 'approvalId'> & {
      approvalId?: string | undefined;
    },
  ): Promise<ApprovalRequest>;
  decide(
    request: ApprovalRequest,
    decision: {
      decidedBy: string;
      decision: 'APPROVED' | 'DENIED';
      reason?: string | undefined;
      correlationId?: string | undefined;
    },
  ): Promise<ApprovalDecision>;
  // For workflow: validate that decision matches request and is not expired, and correlate to step
  validate(
    request: ApprovalRequest,
    decision: ApprovalDecision,
  ): { ok: true } | { ok: false; reason: string };
}

export function createApprovalBridge(): ApprovalBridge {
  const store = new Map<string, ApprovalRequest>();

  return {
    async createRequest(params) {
      const approvalId =
        params.approvalId ?? createApprovalId(params.runId, params.stepId, params.toolCallId);
      const req: ApprovalRequest = {
        approvalId,
        organizationId: params.organizationId,
        runId: params.runId,
        toolCallId: params.toolCallId,
        stepId: params.stepId,
        toolId: params.toolId,
        toolVersion: params.toolVersion,
        effectClass: params.effectClass,
        policyVersion: params.policyVersion,
        requestedAt: new Date().toISOString(),
        expiresAt: params.expiresAt,
        argsDigest: params.argsDigest,
      };
      store.set(approvalId, req);
      // In production, this would call Engine's CreateApprovalRequest via MCP (audited, outbox)
      return req;
    },

    async decide(request, decision) {
      const correlationId = decision.correlationId ?? `corr_${request.approvalId}_${Date.now()}`;
      const dec: ApprovalDecision = {
        approvalId: request.approvalId,
        toolCallId: request.toolCallId,
        stepId: request.stepId,
        decision: decision.decision,
        decidedBy: decision.decidedBy,
        decidedAt: new Date().toISOString(),
        reason: decision.reason,
        correlationId,
      };
      // In production, Engine persists decision with one-time ID, idempotent, scoped
      return dec;
    },

    validate(request, decision) {
      if (request.approvalId !== decision.approvalId)
        return { ok: false, reason: 'approvalId mismatch' };
      if (request.toolCallId !== decision.toolCallId)
        return { ok: false, reason: 'toolCallId mismatch' };
      if (request.stepId !== decision.stepId) return { ok: false, reason: 'stepId mismatch' };
      if (request.expiresAt && new Date(request.expiresAt) <= new Date())
        return { ok: false, reason: 'approval expired' };
      return { ok: true };
    },
  };
}
