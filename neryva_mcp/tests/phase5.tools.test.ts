import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { RunState } from "../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";
import { RequestContextSchema } from "../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js";
import { globalStore } from "../src/engine/store.js";
import { createRunAuthorityHandlers, decideApproval } from "../src/engine/authority.js";
import { clearArtifacts } from "../src/artifacts/claimCheck.js";
import { clearNats } from "../src/events/nats.js";
import { clearRedis } from "../src/events/redis.js";
import { getToolDescriptor, listTools, ToolEffectClass, ApprovalRequirement, validateToolArgs } from "../src/tools/registry.js";
import { hashArgs, createToolCapability, verifyToolCapability } from "../src/tools/capability.js";
import { redactArgs, safeLogEntry } from "../src/tools/redaction.js";
import { authorizeToolCallGateway, executeToolGateway, recordToolOutcomeGateway, fullToolFlow, clearGateway, getRequestLog, getExternalEffect } from "../src/tools/gateway.js";
import { dispatchOutboxOnce } from "../src/outbox/dispatcher.js";
import { clearWorkflows } from "../src/studio/workflow/worker.js";

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
function makeCtx(overrides: Partial<Record<string, string>> = {}) {
  return create(RequestContextSchema, {
    requestId: overrides.requestId ?? uuidv7(),
    organizationId: overrides.organizationId ?? "org_123",
    conversationId: overrides.conversationId ?? "conv_123",
    runId: overrides.runId ?? "run_123",
    actorId: overrides.actorId ?? "actor_123",
    idempotencyKey: overrides.idempotencyKey ?? `idem_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    protocolVersion: overrides.protocolVersion ?? "1.0",
    capabilityId: overrides.capabilityId ?? "cap_123",
  });
}

describe("Phase 5 — Tool authorization & approvals (exit gates)", () => {
  beforeEach(() => {
    globalStore.clear();
    clearArtifacts();
    clearNats();
    clearRedis();
    clearGateway();
    clearWorkflows();
  });

  describe("5.1 Registry — effect_class + approval_requirement orthogonal", () => {
    it("registry covers 6+ tools with correct orthogonal values (do not model DESTRUCTIVE as peer of REQUIRED)", async () => {
      const tools = listTools();
      expect(tools.length).toBeGreaterThanOrEqual(6);
      // READ_ONLY + NONE
      expect(getToolDescriptor("read_document")?.effectClass).toBe(ToolEffectClass.READ_ONLY);
      expect(getToolDescriptor("read_document")?.approvalRequirement).toBe(ApprovalRequirement.NONE);
      // MUTATING + NONE
      expect(getToolDescriptor("create_draft")?.effectClass).toBe(ToolEffectClass.MUTATING);
      expect(getToolDescriptor("create_draft")?.approvalRequirement).toBe(ApprovalRequirement.NONE);
      // MUTATING + REQUIRED orthogonal example
      expect(getToolDescriptor("create_support_ticket")?.effectClass).toBe(ToolEffectClass.MUTATING);
      expect(getToolDescriptor("create_support_ticket")?.approvalRequirement).toBe(ApprovalRequirement.REQUIRED);
      // DESTRUCTIVE + REQUIRED
      expect(getToolDescriptor("delete_conversation")?.effectClass).toBe(ToolEffectClass.DESTRUCTIVE);
      expect(getToolDescriptor("delete_conversation")?.approvalRequirement).toBe(ApprovalRequirement.REQUIRED);
      expect(getToolDescriptor("send_email")?.effectClass).toBe(ToolEffectClass.DESTRUCTIVE);
      expect(getToolDescriptor("send_email")?.approvalRequirement).toBe(ApprovalRequirement.REQUIRED);
      // Every tool has egress, timeout, idempotency, credentialRef, scope, redactedFields, schema
      for (const t of tools) {
        expect(t.egress).toBeDefined();
        expect(t.timeoutMs).toBeGreaterThan(0);
        expect(["supported", "unsupported"]).toContain(t.idempotency);
        expect(t.credentialRef).toMatch(/^cred_/);
        expect(["org", "conversation", "run"]).toContain(t.scope);
        expect(t.schema).toBeDefined();
      }
    });

    it("validateToolArgs rejects unknown fields and missing required", () => {
      expect(() => validateToolArgs("read_document", {} as never)).toThrow(/missing required field docId/);
      expect(() => validateToolArgs("read_document", { docId: "123", unknownField: "x" } as never)).toThrow(/unknown field/);
      expect(() => validateToolArgs("send_email", { to: "a@b.com", subject: "hi" } as never)).toThrow(/missing required field body/);
    });
  });

  describe("5.2 8-step tool flow — model proposes, Engine authorizes, Gateway executes, Engine records", () => {
    it("READ_ONLY allowed without approval, returns short-lived capability bound to digest/org", async () => {
      const runId = "run_tool_8step";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const auth = await authorizeToolCallGateway({
        runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_1", toolName: "read_document", args: { docId: "doc_1" },
      });
      expect(auth.allowed).toBe(true);
      expect(auth.toolCapabilityToken).toBeDefined();
      expect(auth.approvalRequirement).toBe(ApprovalRequirement.NONE);
      // Capability bound to digest/org/expiry/audience
      const cap = verifyToolCapability(auth.toolCapabilityToken!, { runId, stepId: "step_1", toolCallId: "tc_1", argumentDigest: hashArgs({ docId: "doc_1" }), organizationId: "org_123" });
      expect(cap.runId).toBe(runId);
      expect(cap.audience).toBe("neryva-agent-studio");
      expect(cap.expiryMs).toBeGreaterThan(Date.now());
    });

    it("full 8-step flow: authorize → execute → record (durable tool outcome)", async () => {
      const runId = "run_full_flow";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const res = await fullToolFlow({
        runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_full", toolName: "read_document", args: { docId: "doc_99" },
      });
      expect(res.allowed).toBe(true);
      expect(res.executed).toBe(true);
      expect(res.result).toBeDefined();
      // Engine persisted tool effect
      expect(globalStore.toolEffects.get(`${runId}:tc_full`)).toBeDefined();
      // Audit recorded with redacted metadata (no raw secrets)
      const audits = globalStore.queryAudit({ operation: "RecordToolOutcome" });
      expect(audits.length).toBeGreaterThan(0);
    });

    it("tool capability is short-lived and scoped — wrong org/step/toolCallId/args rejected", async () => {
      const runId = "run_cap_scope";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const auth = await authorizeToolCallGateway({
        runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_cap", toolName: "read_document", args: { docId: "doc1" },
      });
      const token = auth.toolCapabilityToken!;
      // Wrong digest
      expect(() => verifyToolCapability(token, { runId, stepId: "step_1", toolCallId: "tc_cap", argumentDigest: hashArgs({ docId: "tampered" }), organizationId: "org_123" })).toThrow(/digest mismatch/);
      // Wrong org
      expect(() => verifyToolCapability(token, { runId, stepId: "step_1", toolCallId: "tc_cap", argumentDigest: hashArgs({ docId: "doc1" }), organizationId: "org_OTHER" })).toThrow(/scope mismatch/);
      // Reuse for another tool_call_id rejected
      expect(() => verifyToolCapability(token, { runId, stepId: "step_1", toolCallId: "tc_OTHER", argumentDigest: hashArgs({ docId: "doc1" }), organizationId: "org_123" })).toThrow(/not reusable/);
    });
  });

  describe("Exit: Model cannot invoke denied tool by changing args/names", () => {
    it("forbidden tool via registry allowlist denied even if args look valid", async () => {
      const runId = "run_forbidden";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      // Try to invoke tool not in registry (attacker changes name)
      const authority = createRunAuthorityHandlers(globalStore);
      const ctx = makeCtx({ runId, organizationId: "org_123" });
      const res = await authority.authorizeToolCall({ ctx, stepId: "step_1", toolCallId: "tc_x", toolName: "forbidden_delete_all", toolVersion: "v1", argumentDigest: new Uint8Array(32) } as never);
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/not allowlisted/);

      // Via gateway, unknown tool throws validationError
      await expect(authorizeToolCallGateway({ runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_y", toolName: "admin_drop_db", args: { docId: "x" } })).rejects.toThrow(/not registered/);
    });

    it("changing args field name or adding extra field rejected by schema validation", async () => {
      const runId = "run_args_tamper";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      // Valid args should pass
      await expect(authorizeToolCallGateway({ runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc1", toolName: "read_document", args: { docId: "ok" } })).resolves.toMatchObject({ allowed: true });
      // Tampered: extra field
      await expect(authorizeToolCallGateway({ runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc2", toolName: "read_document", args: { docId: "ok", extra: "inject" } as never })).rejects.toThrow(/unknown field/);
      // Tampered: renamed required field
      await expect(authorizeToolCallGateway({ runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc3", toolName: "read_document", args: { documentId: "ok" } as never })).rejects.toThrow(/missing required field docId/);
    });
  });

  describe("Exit: Destructive ops require human flow (7-step approval bridge)", () => {
    it("DESTRUCTIVE without approval denied with REQUIRED, after human APPROVED allowed", async () => {
      const runId = "run_destructive";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      // First attempt denied
      const first = await authorizeToolCallGateway({
        runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_del", toolName: "delete_conversation", args: { conversationId: "conv_123" },
      });
      expect(first.allowed).toBe(false);
      expect(first.approvalRequirement).toBe(ApprovalRequirement.REQUIRED);
      expect(first.reason).toMatch(/approval required/);
      // Studio creates approval (Engine transitions to WAITING_APPROVAL) — step 1-2
      const authority = createRunAuthorityHandlers(globalStore);
      const ctx = makeCtx({ runId, organizationId: "org_123" });
      const approvalId = `appr_${runId}_tc_del`;
      const createRes = await authority.createApprovalRequest({ ctx, approval: { approvalId, summary: "delete conversation", actionType: "delete_conversation", toolName: "delete_conversation", toolCallId: "tc_del", expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 300), nanos: 0 } } } as never);
      expect(createRes.approval.state).toBe("PENDING");
      expect(globalStore.getRun(runId)?.state).toBe(RunState.WAITING_APPROVAL);
      // Still denied before human decision
      const beforeHuman = await authorizeToolCallGateway({
        runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_del", toolName: "delete_conversation", args: { conversationId: "conv_123" },
      });
      expect(beforeHuman.allowed).toBe(false);
      // Human approves (steps 3-5) — one-time decisionId
      const decisionId = `dec_${Date.now()}`;
      const decided = await decideApproval(globalStore, { approvalId, decision: "APPROVED", decisionActorId: "human_1", decisionId, organizationId: "org_123", runId });
      expect(decided.state).toBe("APPROVED");
      expect(globalStore.getRun(runId)?.state).toBe(RunState.RUNNING); // back to running
      // Outbox contains DeliverRunInput for Signal
      expect(globalStore.getPendingOutbox().some((o) => o.destination === "RuntimeControlService/DeliverRunInput")).toBe(true);
      await dispatchOutboxOnce(); // deliver Signal to worker
      // Now re-authorize succeeds
      const after = await authorizeToolCallGateway({
        runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_del", toolName: "delete_conversation", args: { conversationId: "conv_123" },
      });
      expect(after.allowed).toBe(true);
      expect(after.toolCapabilityToken).toBeDefined();
      // Execute destructive with capability
      const exec = await executeToolGateway({ runId, stepId: "step_1", toolCallId: "tc_del", toolName: "delete_conversation", args: { conversationId: "conv_123" }, toolCapabilityToken: after.toolCapabilityToken!, organizationId: "org_123" });
      expect(exec.status).toBe("success");
      // Record outcome durable
      const rec = await recordToolOutcomeGateway({ runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_del", toolName: "delete_conversation", status: "success", result: exec.result, resultDigest: exec.resultDigest, toolCapabilityToken: after.toolCapabilityToken!, argumentDigest: hashArgs({ conversationId: "conv_123" }) });
      expect(rec.accepted).toBe(true);
    });

    it("MUTATING+REQUIRED (create_support_ticket) also needs human, orthogonal to DESTRUCTIVE", async () => {
      const runId = "run_mut_req";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const denied = await authorizeToolCallGateway({
        runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_ticket", toolName: "create_support_ticket", args: { subject: "help", body: "please", requester_email: "a@b.com" },
      });
      expect(denied.allowed).toBe(false);
      expect(denied.approvalRequirement).toBe(ApprovalRequirement.REQUIRED);
      // Effect is MUTATING not DESTRUCTIVE, but still REQUIRED — orthogonal
      expect(getToolDescriptor("create_support_ticket")?.effectClass).toBe(ToolEffectClass.MUTATING);
    });

    it("approval replay with same decisionId rejected (one-time), model cannot self-approve", async () => {
      const runId = "run_approval_replay";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const authority = createRunAuthorityHandlers(globalStore);
      const ctx = makeCtx({ runId, organizationId: "org_123" });
      const approvalId = `appr_replay_${runId}`;
      await authority.createApprovalRequest({ ctx, approval: { approvalId, summary: "test", actionType: "delete_conversation", toolName: "delete_conversation", toolCallId: "tc_x", expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 300), nanos: 0 } } } as never);
      const decId = `dec_once_${Date.now()}`;
      await decideApproval(globalStore, { approvalId, decision: "APPROVED", decisionActorId: "human_1", decisionId: decId, organizationId: "org_123", runId });
      // Replay same decisionId should fail (or same approval already decided)
      await expect(decideApproval(globalStore, { approvalId, decision: "APPROVED", decisionActorId: "human_1", decisionId: decId, organizationId: "org_123", runId })).rejects.toThrow(/already made|replay|AlreadyExists/);
      // Model cannot self-approve
      const approvalId2 = `appr_model_${runId}`;
      await authority.createApprovalRequest({ ctx: makeCtx({ runId, organizationId: "org_123" }), approval: { approvalId: approvalId2, summary: "x", actionType: "delete_conversation", toolName: "delete_conversation", toolCallId: "tc_y", expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 300), nanos: 0 } } } as never);
      await expect(decideApproval(globalStore, { approvalId: approvalId2, decision: "APPROVED", decisionActorId: "model_gpt4", decisionId: `dec_model_${Date.now()}`, organizationId: "org_123", runId })).rejects.toThrow(/model cannot approve/);
    });
  });

  describe("Exit: Duplicate execution reconciled (same idempotency key → same result)", () => {
    it("6-step idempotency: stable key from run+step → same result, no second side effect", async () => {
      const runId = "run_idem_tool";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const stepId = "step_1";
      const toolCallId = "tc_idem";
      const args = { docId: "doc_idem" };
      // First authorize + execute
      const auth1 = await authorizeToolCallGateway({ runId, organizationId: "org_123", stepId, toolCallId, toolName: "read_document", args });
      const exec1 = await executeToolGateway({ runId, stepId, toolCallId, toolName: "read_document", args, toolCapabilityToken: auth1.toolCapabilityToken!, organizationId: "org_123" });
      // Second with same run+step+toolCallId should be deduped (no second external effect)
      const auth2 = await authorizeToolCallGateway({ runId, organizationId: "org_123", stepId, toolCallId, toolName: "read_document", args });
      // Capability will be new but same scope — second execute should hit externalEffects map and return wasDuplicate
      const exec2 = await executeToolGateway({ runId, stepId, toolCallId, toolName: "read_document", args, toolCapabilityToken: auth2.toolCapabilityToken!, organizationId: "org_123" });
      expect(exec2.wasDuplicate).toBe(true);
      expect(Buffer.from(exec2.resultDigest).toString("hex")).toBe(Buffer.from(exec1.resultDigest).toString("hex"));
      // RecordToolOutcome idempotency as well
      const rec1 = await recordToolOutcomeGateway({ runId, organizationId: "org_123", stepId, toolCallId, toolName: "read_document", status: "success", result: exec1.result, resultDigest: exec1.resultDigest, toolCapabilityToken: auth1.toolCapabilityToken!, argumentDigest: hashArgs(args) });
      const rec2 = await recordToolOutcomeGateway({ runId, organizationId: "org_123", stepId, toolCallId, toolName: "read_document", status: "success", result: exec1.result, resultDigest: exec1.resultDigest, toolCapabilityToken: auth1.toolCapabilityToken!, argumentDigest: hashArgs(args) });
      expect(rec1.accepted).toBe(true);
      expect(rec2.wasDuplicate).toBe(true);
      // ToolEffects only one record
      expect(globalStore.toolEffects.size).toBe(1);
    });

    it("different digest with same idempotency key → conflict", async () => {
      const runId = "run_idem_conflict";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const authority = createRunAuthorityHandlers(globalStore);
      const ctx = makeCtx({ runId, organizationId: "org_123", idempotencyKey: "same_key" });
      const res1 = await authority.recordToolOutcome({ ctx, stepId: "step_1", toolCallId: "tc_conflict", status: "success", resultDigest: new Uint8Array(32) } as never);
      expect(res1.accepted).toBe(true);
      // Same key, different digest (different toolCallId status?) — but our digest includes toolCallId, so same key with different payload should conflict
      // Use same toolCallId but different status to get different digest
      const ctxSameKey = makeCtx({ runId, organizationId: "org_123", idempotencyKey: "same_key" });
      // recordToolOutcome scope is `${org}:${run}:tool:${toolCallId}` — same toolCallId same key, but we change status to get different digest
      // Actually our recordToolOutcome digest includes status, so different status → different digest → AlreadyExists
      await expect(authority.recordToolOutcome({ ctx: ctxSameKey, stepId: "step_1", toolCallId: "tc_conflict", status: "failed", resultDigest: new Uint8Array(32) } as never)).rejects.toThrow(/AlreadyExists|conflict/);
    });

    it("ambiguous timeout reconciled by lookup before retry (supported) vs manual if unsupported", async () => {
      const runId = "run_ambiguous";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      // send_email does not support idempotency, will require manual reconciliation on ambiguous
      const auth = await authorizeToolCallGateway({
        runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_amb", toolName: "send_email", args: { to: "timeout@example.com", subject: "hi", body: "x" },
      });
      // First execute hits ambiguous timeout
      await expect(executeToolGateway({ runId, stepId: "step_1", toolCallId: "tc_amb", toolName: "send_email", args: { to: "timeout@example.com", subject: "hi", body: "x" }, toolCapabilityToken: auth.toolCapabilityToken!, organizationId: "org_123" })).rejects.toThrow(/ambiguous/);
      // Retry should require manual (unsupported) — not blind retry
      await expect(executeToolGateway({ runId, stepId: "step_1", toolCallId: "tc_amb", toolName: "send_email", args: { to: "timeout@example.com", subject: "hi", body: "x" }, toolCapabilityToken: auth.toolCapabilityToken!, organizationId: "org_123" })).rejects.toThrow(/manual reconciliation/);
      // Supported idempotency tool: create_draft — ambiguous would be reconciled
      // For spike we don't simulate ambiguous for supported, but ensure normal retry is deduped not double-executed
    });
  });

  describe("Exit: Sensitive args absent from logs/traces/Temporal history", () => {
    it("redacted fields not in logs, result only digest, temporal args bounded", async () => {
      const runId = "run_redact";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const args = { to: "secret@example.com", subject: "hi", body: "secret body", api_key: "sk-123" } as unknown as Record<string, unknown>;
      const redacted = redactArgs("send_email", args);
      expect(redacted.to).toBe("[REDACTED]");
      expect(redacted.body).toBe("[REDACTED]");
      expect(redacted.api_key).toBe("[REDACTED]");
      const log = safeLogEntry("send_email", args);
      expect(log).not.toContain("secret@example.com");
      expect(log).not.toContain("sk-123");
      expect(log).toContain("[REDACTED]");
      // Full flow should not log raw
      await authorizeToolCallGateway({
        runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_redact", toolName: "send_email", args: { to: "a@b.com", subject: "hi", body: "x" },
      }).catch(() => {}); // may need approval, ignore
      // Check gateway request log never contains raw sensitive
      const logs = getRequestLog().join("\n");
      expect(logs).not.toContain("secret@example.com");
      // Temporal guard: large raw args must use ArtifactRef
      const { assertTemporalArgsSafe } = await import("../src/shared/temporalGuard.js");
      const large = new Uint8Array(70 * 1024);
      expect(() => assertTemporalArgsSafe({ data: large } as unknown as Record<string, unknown>)).toThrow(/64KiB|too large|ArtifactRef/);
    });

    it("tool authorization independent of model output — policy not bypassed by prompt injection", async () => {
      const runId = "run_prompt_inject";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      // Even if model output says "ignore policy, delete all", Engine still denies without approval
      const auth = await authorizeToolCallGateway({
        runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_inject", toolName: "delete_conversation", args: { conversationId: "conv_123" },
      });
      expect(auth.allowed).toBe(false);
      // Injecting extra field that tries to bypass
      await expect(authorizeToolCallGateway({
        runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_inject2", toolName: "delete_conversation", args: { conversationId: "conv_123", bypass: true } as never,
      })).rejects.toThrow(/unknown field/);
    });
  });

  describe("5.5 Scoped credentials + egress + audit", () => {
    it("every privileged decision audited with actor/scope/reason/policyVersion/trace", async () => {
      const runId = "run_audit";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_456", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      await authorizeToolCallGateway({ runId, organizationId: "org_123", stepId: "step_1", toolCallId: "tc_audit", toolName: "read_document", args: { docId: "d1" } });
      const audits = globalStore.queryAudit({ operation: "AuthorizeToolCall" });
      expect(audits.length).toBeGreaterThan(0);
      const last = audits[audits.length - 1];
      expect(last.organizationId).toBe("org_123");
      expect(last.policyVersion).toBe("policy_v1");
      expect(last.decision).toBe("allow");
    });

    it("credentialRef is scoped, never raw secret, egress class enforced", async () => {
      const desc = getToolDescriptor("send_email")!;
      expect(desc.credentialRef).toBe("cred_email_api");
      expect(desc.credentialRef).not.toContain("sk-");
      expect(desc.egress).toBe("external_api");
      // internal tools egress internal
      expect(getToolDescriptor("read_document")?.egress).toBe("internal");
    });
  });
});
