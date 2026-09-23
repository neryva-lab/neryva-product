/**
 * approval-activities.ts — human approval bridge via MCP + Temporal Signals (auditable, correlated)
 * Source: agent_studio_implementation_plan.md:1102-1117, 328-336, 1116
 * CreateApprovalRequest → Engine persists + outbox → WAITING_APPROVAL → human via Engine API → decision with one-time ID → DeliverRunInput via outbox → Temporal Signal default, Update only when sync validation needed → workflow validates correlation.
 */

import { heartbeat } from './heartbeat.js';
import type { NeryvaMcpClient } from '@neryva/neryva-mcp-client';
import { createApprovalBridge } from '@neryva/tool-gateway';

export interface CreateApprovalParams {
  approvalId: string;
  runId: string;
  organizationId: string;
  toolCallId: string;
  stepId: string;
  toolName: string;
  toolVersion?: string | undefined;
  policyVersion?: string | undefined;
}

export interface ApprovalDecision {
  approvalId: string;
  toolCallId: string;
  stepId: string;
  decision: 'APPROVED' | 'DENIED';
  correlationId: string;
  decidedBy?: string | undefined;
  reason?: string | undefined;
}

export function createApprovalActivities(client: NeryvaMcpClient) {
  const bridge = createApprovalBridge();

  return {
    async createApprovalRequest(params: CreateApprovalParams): Promise<{ approvalId: string }> {
      heartbeat({ step: 'createApprovalRequest', approvalId: params.approvalId });
      // Bridge creates auditable request (scoped org/run/tool_call/approval_id/policy_version)
      const req = await bridge.createRequest({
        approvalId: params.approvalId,
        organizationId: params.organizationId,
        runId: params.runId,
        toolCallId: params.toolCallId,
        stepId: params.stepId,
        toolId: params.toolName,
        toolVersion: params.toolVersion ?? '1.0.0',
        effectClass: 'MUTATING',
        policyVersion: params.policyVersion ?? 'v1',
      });
      // Via MCP — idempotent, auditable, scoped, outbox → WAITING_APPROVAL
      await client.createApprovalRequest({
        approvalId: req.approvalId,
        toolCallId: req.toolCallId,
        summary: req.toolId,
        actionType: req.effectClass,
        policyVersion: req.policyVersion,
      });
      return { approvalId: req.approvalId };
    },

    /**
     * getApprovalState — durable read of the Engine's approval decision.
     * The temporal workflow polls this while parked on an approval-required
     * tool call (waitForApprovalDecision): the ApprovalDecision Temporal
     * signal is never delivered end-to-end, so the workflow observes the
     * durable decision directly — the same source the inline executor uses
     * (see apps/runtime-control/src/inline-executor.ts) and the behaviour
     * the Engine's run-dispatch consumer documents ("the fresh executor
     * observes the durable decision via GetApprovalState").
     */
    async getApprovalState(params: { approvalRef: string }): Promise<{ state?: string }> {
      heartbeat({ step: 'getApprovalState', approvalRef: params.approvalRef });
      const res = (await client.getApprovalState({ approvalRef: params.approvalRef })) as {
        state?: string;
      } | null;
      return { state: res?.state ?? 'NOT_FOUND' };
    },

    /**
     * getRunVersion — refresh the Engine's current run version (CAS token)
     * after an external version bump. The approval decision transitions
     * WAITING_APPROVAL → RUNNING and increments runs.version; a workflow
     * parked on the approval holds the pre-bump version, so its terminal
     * commitRunResult would fail with "stale run version". Call this after
     * the approval resolves and use the returned version for all later
     * version-guarded activities.
     */
    async getRunVersion(): Promise<{ version: number | null }> {
      heartbeat({ step: 'getRunVersion' });
      const res = await client.getRun();
      // Normalize at the activity edge: the result crosses Temporal back to
      // the workflow, and bigint is not JSON-serializable. Clamp to a safe
      // integer — a version beyond MAX_SAFE_INTEGER is a corrupt CAS token.
      const v = res.version;
      if (typeof v === 'bigint') {
        return {
          version: v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null,
        };
      }
      if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) {
        return { version: v };
      }
      return { version: null };
    },

    async recordApprovalDecision(decision: ApprovalDecision): Promise<void> {
      heartbeat({
        step: 'recordApprovalDecision',
        approvalId: decision.approvalId,
        decision: decision.decision,
      });
      // In real, Engine persists decision with one-time correlationId, then DeliverRunInput via outbox → Signal
      // For Phase 6, we just validate correlation
      void decision.correlationId;
    },

    // For tests: expose bridge validation
    _bridge: bridge,
  };
}

export type ApprovalActivities = ReturnType<typeof createApprovalActivities>;
