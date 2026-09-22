/**
 * Studio fake RuntimeControlService — deterministic WorkflowID, idempotent StartRun, no duplicate execution.
 * Reference: ledger 0.4 + neryva_mcp_implementation_plan.md:348
 *
 * WorkflowID = `wf-${runId}` — deterministic; repeated StartRun returns existing acceptance.
 */

import { Code, ConnectError } from "@connectrpc/connect";
import { validateRequestContext } from "../shared/validation.js";
import { authorizationError } from "../shared/errors.js";
import type { StartRunRequest, StartRunResponse } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/runtime/v1/runtime_pb.js";
import type { RuntimeControlService } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/runtime/v1/runtime_pb.js";
import { startWorkflow, signalWorkflow, cancelWorkflow, getExecutionByRunId, clearWorkflows } from "./workflow/worker.js";
import { assertTemporalArgsSafe } from "../shared/temporalGuard.js";

export interface WorkflowRecord {
  workflowId: string;
  runId: string;
  organizationId: string;
  conversationId: string;
  assistantVersionId: string;
  createdAt: Date;
  attempts: number;
}

const workflows = new Map<string, WorkflowRecord>(); // key = runId
const idempotency = new Map<string, WorkflowRecord>(); // key = `${runId}:${idempotencyKey}`

function workflowIdForRun(runId: string): string {
  return `wf-${runId}`;
}

function ctxFields(ctx: Record<string, unknown>) {
  return {
    organizationId: (ctx.organizationId ?? ctx.organization_id) as string,
    conversationId: (ctx.conversationId ?? ctx.conversation_id) as string,
    runId: (ctx.runId ?? ctx.run_id) as string,
    idempotencyKey: (ctx.idempotencyKey ?? ctx.idempotency_key) as string,
  };
}

export function createRuntimeControlHandlers() {
  return {
    startRun: async (req: never) => {
      const r = req as unknown as {
        ctx: Record<string, unknown>;
        assistantVersionId: string;
        assistant_version_id?: string;
        inputMessageId: string;
        input_message_id?: string;
        expectedConversationVersion: bigint;
        expected_conversation_version?: bigint;
        capabilityToken: string;
        capability_token?: string;
      };
      validateRequestContext(r.ctx);
      const { organizationId, conversationId, runId, idempotencyKey } = ctxFields(r.ctx as Record<string, unknown>);
      if (!runId) throw new ConnectError("run_id required", Code.InvalidArgument);
      const aVid = (r.assistantVersionId ?? r.assistant_version_id) as string | undefined;
      if (!aVid) throw new ConnectError("assistant_version_id required", Code.InvalidArgument);

      // Enforce bounded workflow history: inputs must be IDs/refs only, not large docs `640`
      assertTemporalArgsSafe(r);

      const key = `${runId}:${idempotencyKey}`;
      const existingByKey = idempotency.get(key);
      if (existingByKey) {
        return { workflowId: existingByKey.workflowId, alreadyStarted: true, runId };
      }
      const existingByRun = workflows.get(runId);
      if (existingByRun) {
        // Deterministic WorkflowID ensures no second workflow
        idempotency.set(key, existingByRun);
        return { workflowId: existingByRun.workflowId, alreadyStarted: true, runId };
      }

      const wfId = workflowIdForRun(runId);
      const rec: WorkflowRecord = {
        workflowId: wfId,
        runId,
        organizationId,
        conversationId,
        assistantVersionId: aVid,
        createdAt: new Date(),
        attempts: 1,
      };
      workflows.set(runId, rec);
      idempotency.set(key, rec);

      // Start deterministic workflow via worker `3.3` — only IDs/refs, not large values `640`
      const input = {
        runId,
        organizationId,
        conversationId,
        assistantVersionId: aVid,
        inputMessageId: (r.inputMessageId ?? r.input_message_id) as string,
        expectedConversationVersion: String(r.expectedConversationVersion ?? r.expected_conversation_version ?? 0n),
        capabilityToken: (r.capabilityToken ?? r.capability_token) as string,
      };
      // Validate workflow input is bounded
      assertTemporalArgsSafe(input);
      // Start workflow asynchronously (simulates Temporal worker)
      startWorkflow(input).catch(() => {});

      return { workflowId: wfId, alreadyStarted: false, runId };
    },

    cancelRun: async (req: never) => {
      const r = req as unknown as { ctx: Record<string, unknown>; reason?: string };
      validateRequestContext(r.ctx);
      const { runId } = ctxFields(r.ctx as Record<string, unknown>);
      const wf = workflows.get(runId);
      if (!wf) return { accepted: false, runId };
      // Propagate cancellation Engine → Studio → Temporal → provider `645`
      const wfId = workflowIdForRun(runId);
      try {
        cancelWorkflow(wfId);
      } catch {}
      return { accepted: true, runId };
    },

    deliverRunInput: async (req: never) => {
      const r = req as unknown as { ctx: Record<string, unknown>; inputId: string; input_id?: string; kind?: number; payload?: Uint8Array };
      validateRequestContext(r.ctx);
      const iid = (r.inputId ?? r.input_id) as string | undefined;
      if (!iid) throw new ConnectError("input_id required", Code.InvalidArgument);
      // Large payloads must use ArtifactRef, not inline `579`
      if (r.payload && (r.payload as Uint8Array).length > 64 * 1024) throw new ConnectError("payload too large, use ArtifactRef", Code.InvalidArgument);
      // Deliver as Temporal Signal (notify) `624-630` — durable, even during restart
      const { organizationId, conversationId, runId } = ctxFields(r.ctx as Record<string, unknown>);
      // Find workflow by deterministic ID
      const wfId = workflowIdForRun(runId);
      try {
        signalWorkflow(wfId, "DeliverRunInput", { inputId: iid, kind: r.kind, payload: r.payload, organizationId, conversationId, runId });
      } catch {
        // If workflow not yet started, queue signal for when it starts (Temporal would do this)
        // For spike, we just accept delivery
      }
      // Use proper Timestamp for acceptedAt
      const { create } = await import("@bufbuild/protobuf");
      const { TimestampSchema } = await import("@bufbuild/protobuf/wkt");
      return { delivered: true, acceptedAt: create(TimestampSchema, { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 }) };
    },

    getRuntimeStatus: async (req: never) => {
      const r = req as unknown as { ctx: Record<string, unknown> };
      validateRequestContext(r.ctx);
      const { runId } = ctxFields(r.ctx as Record<string, unknown>);
      const wf = workflows.get(runId);
      if (!wf) throw new ConnectError(`workflow for run ${runId} not found`, Code.NotFound);
      // Check workflow execution status for heartbeat details `1099`
      const exec = getExecutionByRunId(runId);
      const { create } = await import("@bufbuild/protobuf");
      const { TimestampSchema } = await import("@bufbuild/protobuf/wkt");
      return {
        runId: wf.runId,
        workflowId: wf.workflowId,
        state: exec?.status ?? "RUNNING",
        leaseExpiresAt: create(TimestampSchema, { seconds: BigInt(Math.floor(Date.now() / 1000) + 30), nanos: 0 }),
        isDraining: false,
      };
    },

    drainRuntime: async (req: never) => {
      const r = req as unknown as { ctx: Record<string, unknown> };
      validateRequestContext(r.ctx);
      return { draining: true };
    },
  };
}

export function clearRuntime() {
  workflows.clear();
  idempotency.clear();
  clearWorkflows();
}

export function getWorkflow(runId: string): WorkflowRecord | undefined {
  return workflows.get(runId);
}
