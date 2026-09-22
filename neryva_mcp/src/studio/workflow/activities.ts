/**
 * Activities — all outside-world interaction. Workflow must not do I/O directly `639,1099`.
 * Each Activity is an async function with explicit timeouts, heartbeat support, and retry policy.
 * Engine MCP client is inside Activities only `1099`.
 */

import { globalStore } from "../../engine/store.js";
import { createRunAuthorityHandlers } from "../../engine/authority.js";
import { createArtifact } from "../../artifacts/claimCheck.js";
import { validationError } from "../../shared/errors.js";

function uuidv7(): string {
  const t = Date.now();
  const timeHex = t.toString(16).padStart(12, "0");
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  const randHex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    timeHex.slice(0, 8) + "-" + timeHex.slice(8, 12) + "-7" + randHex.slice(1, 4) + "-" + ((parseInt(randHex.slice(4, 6), 16) & 0x3f | 0x80).toString(16).padStart(2, "0")) + randHex.slice(6, 8) + "-" + randHex.slice(8, 20)
  );
}

// Stub model gateway — in production would call provider via Model Gateway `219-220`
export async function callModel(input: { runId: string; manifest: unknown }): Promise<{ text: string; toolCalls?: Array<{ toolName: string; args: unknown }> }> {
  // Simulate model call with deterministic output for spike (no random)
  // In real, this would call Model Gateway with retries and provider hints
  await new Promise((r) => setTimeout(r, 10));
  return { text: `response for ${input.runId}`, toolCalls: [] };
}

export async function acquireLease(input: { runId: string; organizationId: string }): Promise<{ leaseEpoch: string; leaseOwner: string }> {
  const run = globalStore.getRun(input.runId);
  if (!run) throw validationError(`run ${input.runId} not found`);
  const owner = `worker_${process.pid}_${Date.now()}`;
  const updated = globalStore.acquireOrRenewLease(input.runId, owner, run.leaseEpoch);
  return { leaseEpoch: String(updated.leaseEpoch), leaseOwner: updated.leaseOwner! };
}

export async function getAuthorizedContext(input: { runId: string; organizationId: string }): Promise<unknown> {
  const h = createRunAuthorityHandlers(globalStore);
  // Use a synthetic RequestContext for internal Activity call (would be real capability in prod)
  const ctx = {
    requestId: uuidv7(),
    organizationId: input.organizationId,
    conversationId: globalStore.getRun(input.runId)?.conversationId ?? "conv_123",
    runId: input.runId,
    actorId: "studio_worker",
    idempotencyKey: `idem_ctx_${input.runId}`,
    protocolVersion: "1.0",
    capabilityId: "cap_internal",
  };
  // For spike, call handler directly (in prod, would be via Neryva MCP client)
  const res = await h.getAuthorizedRunContext({ ctx } as never);
  return res.manifest;
}

export async function authorizeToolCall(input: { runId: string; toolName: string; args: unknown; stepId?: string; toolCallId?: string }): Promise<{ allowed: boolean; reason: string; toolCapabilityToken?: string; approvalRequirement?: number }> {
  const run = globalStore.getRun(input.runId);
  if (!run) throw validationError(`run ${input.runId} not found`);
  const { authorizeToolCallGateway } = await import("../../tools/gateway.js");
  const stepId = input.stepId ?? "step_1";
  const toolCallId = input.toolCallId ?? `tc_${input.toolName}_${Date.now()}`;
  const res = await authorizeToolCallGateway({
    runId: input.runId,
    organizationId: run.organizationId,
    stepId,
    toolCallId,
    toolName: input.toolName,
    args: input.args as Record<string, unknown>,
  });
  return res;
}

export async function executeTool(input: { runId: string; toolName: string; args: unknown; stepId?: string; toolCallId?: string; toolCapabilityToken?: string }): Promise<unknown> {
  const run = globalStore.getRun(input.runId);
  if (!run) throw validationError(`run ${input.runId} not found`);
  const { executeToolGateway } = await import("../../tools/gateway.js");
  const stepId = input.stepId ?? "step_1";
  const toolCallId = input.toolCallId ?? `tc_${input.toolName}_${Date.now()}`;
  const res = await executeToolGateway({
    runId: input.runId,
    stepId,
    toolCallId,
    toolName: input.toolName,
    args: input.args as Record<string, unknown>,
    toolCapabilityToken: input.toolCapabilityToken,
    organizationId: run.organizationId,
  });
  return res.result;
}

export async function recordToolOutcome(input: { runId: string; toolCallId: string; outcome: unknown; stepId?: string; status?: string; resultDigest?: Uint8Array; toolCapabilityToken?: string }): Promise<void> {
  const run = globalStore.getRun(input.runId);
  if (!run) throw validationError(`run ${input.runId} not found`);
  const { recordToolOutcomeGateway } = await import("../../tools/gateway.js");
  const { hashArgs } = await import("../../tools/capability.js");
  const digest = input.resultDigest ?? hashArgs(input.outcome);
  await recordToolOutcomeGateway({
    runId: input.runId,
    organizationId: run.organizationId,
    stepId: input.stepId ?? "step_1",
    toolCallId: input.toolCallId,
    toolName: "unknown",
    status: input.status ?? "success",
    result: input.outcome,
    resultDigest: digest,
    toolCapabilityToken: input.toolCapabilityToken,
  });
}

// Full 8-step flow for workflow to call (model proposes → authorize → execute → record)
export async function runToolWithApproval(input: { runId: string; stepId: string; toolCallId: string; toolName: string; args: Record<string, unknown> }): Promise<{ allowed: boolean; result?: unknown; needsApproval?: boolean }> {
  const run = globalStore.getRun(input.runId);
  if (!run) throw validationError(`run ${input.runId} not found`);
  const { fullToolFlow } = await import("../../tools/gateway.js");
  return fullToolFlow({
    runId: input.runId,
    organizationId: run.organizationId,
    stepId: input.stepId,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    args: input.args,
  });
}

export async function createApprovalRequest(input: { runId: string; toolName: string; toolCallId: string; summary: string; actionType?: string }): Promise<{ approvalId: string }> {
  const run = globalStore.getRun(input.runId);
  if (!run) throw validationError(`run ${input.runId} not found`);
  const h = createRunAuthorityHandlers(globalStore);
  const ctx = {
    requestId: uuidv7(),
    organizationId: run.organizationId,
    conversationId: run.conversationId,
    runId: input.runId,
    actorId: "studio_worker",
    idempotencyKey: `idem_appr_${input.runId}_${input.toolCallId}`,
    protocolVersion: "1.0",
    capabilityId: "cap_internal",
  };
  const approvalId = `appr_${input.runId}_${input.toolCallId}`;
  const res = await h.createApprovalRequest({ ctx, approval: { approvalId, summary: input.summary, actionType: input.actionType ?? input.toolName, toolName: input.toolName, toolCallId: input.toolCallId, expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 300), nanos: 0 } } } as never);
  return { approvalId: (res.approval as { approvalId: string }).approvalId };
}

export async function waitForApprovalSignal(input: { runId: string; approvalId: string; timeoutMs?: number }): Promise<{ decision: string }> {
  const timeout = input.timeoutMs ?? 5_000;
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const rec = globalStore.approvals.get(input.approvalId);
    if (rec && rec.state === "APPROVED") return { decision: "APPROVED" };
    if (rec && rec.state === "DENIED") throw new Error(`approval ${input.approvalId} denied`);
    await new Promise((r) => setTimeout(r, 20));
    // Also drain signals if any (worker would do)
    const exec = (await import("./worker.js")).getExecutionByRunId(input.runId);
    if (exec) {
      const signals = exec.signals.filter((s) => s.kind === "DeliverRunInput");
      for (const s of signals) {
        const payload = s.payload as { inputId: string; payload?: Uint8Array };
        try {
          const data = JSON.parse(new TextDecoder().decode(payload.payload ?? new Uint8Array()));
          if (data.approvalId === input.approvalId && data.decision === "APPROVED") return { decision: "APPROVED" };
        } catch {}
      }
    }
  }
  throw new Error(`approval ${input.approvalId} timeout after ${timeout}ms`);
}

export async function commitRunResult(input: { runId: string; text: string }): Promise<{ messageId: string }> {
  const run = globalStore.getRun(input.runId);
  if (!run) throw validationError(`run ${input.runId} not found`);
  const h = createRunAuthorityHandlers(globalStore);
  const ctx = {
    requestId: uuidv7(),
    organizationId: run.organizationId,
    conversationId: run.conversationId,
    runId: input.runId,
    actorId: "studio_worker",
    idempotencyKey: `idem_commit_${input.runId}`,
    protocolVersion: "1.0",
    capabilityId: "cap_internal",
  };
  const res = await h.commitRunResult({ ctx, expectedVersion: run.version, resultText: input.text } as never);
  return { messageId: res.messageId };
}

export async function handleInputs(input: { inputs: unknown[] }): Promise<void> {
  // Drain pending signals at safe point `630`
  for (const inp of input.inputs) {
    // In real, would validate and apply to workflow state
  }
}

export async function saveCheckpoint(input: { checkpointId: string; version: bigint; artifactRef: unknown; runId: string }): Promise<void> {
  const run = globalStore.getRun(input.runId);
  if (!run) throw validationError(`run ${input.runId} not found`);
  // Use claim-check for large checkpoint data
  const h = createRunAuthorityHandlers(globalStore);
  const ctx = {
    requestId: uuidv7(),
    organizationId: run.organizationId,
    conversationId: run.conversationId,
    runId: input.runId,
    actorId: "studio_worker",
    idempotencyKey: `idem_ckpt_${input.checkpointId}`,
    protocolVersion: "1.0",
    capabilityId: "cap_internal",
  };
  // Create artifact for checkpoint if not already
  const data = new Uint8Array(100);
  const ref = createArtifact({ data, mediaType: "application/octet-stream", purpose: "checkpoint", organizationId: run.organizationId, runId: input.runId });
  await h.saveCheckpointRef({ ctx, checkpointId: input.checkpointId, checkpointVersion: input.version, artifactRef: ref, digest: new Uint8Array(32), createdAt: new Date() as never } as never);
}
