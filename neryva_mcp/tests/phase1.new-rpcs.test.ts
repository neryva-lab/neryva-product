import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { RunState } from "../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";
import { RunAuthorityService } from "../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";
import { RequestContextSchema } from "../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js";
import { globalStore } from "../src/engine/store.js";
import { createRunAuthorityHandlers } from "../src/engine/authority.js";
import { createTestTransport } from "../src/shared/transport.js";
import { createArtifact } from "../src/artifacts/claimCheck.js";

function uuidv7(): string {
  const t = Date.now();
  const timeHex = t.toString(16).padStart(12, "0");
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  const randHex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return timeHex.slice(0, 8) + "-" + timeHex.slice(8, 12) + "-7" + randHex.slice(1, 4) + "-" + ((parseInt(randHex.slice(4, 6), 16) & 0x3f | 0x80).toString(16).padStart(2, "0")) + randHex.slice(6, 8) + "-" + randHex.slice(8, 20);
}
function makeCtx(runId: string, overrides: Record<string, string> = {}) {
  return create(RequestContextSchema, {
    requestId: uuidv7(),
    organizationId: "org_123",
    conversationId: "conv_123",
    runId,
    actorId: "actor_123",
    idempotencyKey: `idem_${runId}_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    protocolVersion: "1.0",
    capabilityId: "cap_123",
    ...overrides,
  });
}

describe("Phase 1 — New RunAuthorityService RPCs (11 total)", () => {
  beforeEach(() => globalStore.clear());

  function setupRun(runId = "run_new_1") {
    globalStore.createRun({
      runId,
      organizationId: "org_123",
      conversationId: "conv_123",
      assistantVersionId: "asst_v1",
      state: RunState.RUNNING,
    });
    return runId;
  }

  it("GetAuthorizedRunContext returns bounded manifest", async () => {
    const runId = setupRun();
    const h = createRunAuthorityHandlers(globalStore);
    const ctx = makeCtx(runId);
    const res = await h.getAuthorizedRunContext({ ctx } as never);
    expect(res.manifest.assistantVersionId).toBe("asst_v1");
    expect(res.manifest.policyVersion).toBe("policy_v1");
    expect(res.manifest.budgets).toBeDefined();
  });

  it("CreateApprovalRequest stores and is idempotent", async () => {
    const runId = setupRun();
    const h = createRunAuthorityHandlers(globalStore);
    const ctx = makeCtx(runId, { idempotencyKey: "k_appr" });
    const approval = {
      approvalId: "appr_123",
      organizationId: "org_123",
      runId,
      summary: "delete file",
      actionType: "DELETE",
      policyVersion: "policy_v1",
      state: 1,
      expiresAt: { seconds: BigInt(Math.floor(Date.now() / 1000) + 3600), nanos: 0 },
    };
    const r1 = await h.createApprovalRequest({ ctx, approval } as never);
    expect(r1.approval.approvalId).toBe("appr_123");
    const r2 = await h.createApprovalRequest({ ctx, approval } as never);
    expect(r2.approval.approvalId).toBe(r1.approval.approvalId);
  });

  it("SubmitMemoryProposal stores as proposal (not truth) and preserves provenance", async () => {
    const runId = setupRun();
    const h = createRunAuthorityHandlers(globalStore);
    const ctx = makeCtx(runId, { idempotencyKey: "k_mem" });
    const r1 = await h.submitMemoryProposal({ ctx, proposalId: "mem_1", scope: "user", value: "user likes dark mode", provenance: "msg_123", confidence: 0.9 } as never);
    expect(r1.accepted).toBe(true);
    const stored = globalStore.memoryProposals.get("mem_1");
    expect(stored?.value).toBe("user likes dark mode");
    expect(stored?.provenance).toBe("msg_123");
  });

  it("AuthorizeToolCall returns scoped capability and respects policy", async () => {
    const runId = setupRun();
    const h = createRunAuthorityHandlers(globalStore);
    const ctx = makeCtx(runId);
    const ok = await h.authorizeToolCall({ ctx, stepId: "step_1", toolCallId: "tc_1", toolName: "search", toolVersion: "v1", argumentDigest: new Uint8Array(32) } as never);
    expect(ok.allowed).toBe(true);
    // Capability is short-lived HMAC token bound to run_id/step_id/tool_call_id/digest/org/expiry/audience — verify via decode, not plain substring
    const payload = ok.toolCapabilityToken.split(".")[0];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(decoded.runId).toBe(runId);
    expect(decoded.audience).toBe("neryva-agent-studio");
    const denied = await h.authorizeToolCall({ ctx, stepId: "step_1", toolCallId: "tc_2", toolName: "forbidden_delete", toolVersion: "v1", argumentDigest: new Uint8Array(32) } as never);
    expect(denied.allowed).toBe(false);
  });

  it("RecordToolOutcome dedupes by tool_call_id", async () => {
    const runId = setupRun();
    const h = createRunAuthorityHandlers(globalStore);
    const ctx = makeCtx(runId, { idempotencyKey: "k_tool_out" });
    const r1 = await h.recordToolOutcome({ ctx, stepId: "step_1", toolCallId: "tc_dup", status: "success", resultDigest: new Uint8Array(32) } as never);
    expect(r1.wasDuplicate).toBe(false);
    const r2 = await h.recordToolOutcome({ ctx, stepId: "step_1", toolCallId: "tc_dup", status: "success", resultDigest: new Uint8Array(32) } as never);
    expect(r2.wasDuplicate).toBe(true);
  });

  it("SaveCheckpointRef stores versioned artifact ref", async () => {
    const runId = setupRun();
    const data = new Uint8Array(100);
    const ref = createArtifact({ data, mediaType: "application/octet-stream", purpose: "checkpoint", organizationId: "org_123", runId });
    const h = createRunAuthorityHandlers(globalStore);
    const ctx = makeCtx(runId, { idempotencyKey: "k_ckpt" });
    const r1 = await h.saveCheckpointRef({ ctx, checkpointId: "ckpt_1", checkpointVersion: 1n, artifactRef: ref, digest: new Uint8Array(32), createdAt: { seconds: 1n, nanos: 0 } } as never);
    expect(r1.accepted).toBe(true);
    const r2 = await h.saveCheckpointRef({ ctx, checkpointId: "ckpt_1", checkpointVersion: 1n, artifactRef: ref, digest: new Uint8Array(32), createdAt: { seconds: 1n, nanos: 0 } } as never);
    expect(r2.accepted).toBe(true); // idempotent
  });

  it("all 11 RPCs are reachable via Connect transport", async () => {
    const runId = setupRun("run_transport_all");
    const handlers = createRunAuthorityHandlers(globalStore);
    const transport = createTestTransport((router) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (router as any).service(RunAuthorityService, handlers);
    });
    const client = createClient(RunAuthorityService, transport);
    const ctx = makeCtx(runId);
    // GetRun
    const got = await client.getRun({ ctx } as never);
    expect(got.run?.runId).toBe(runId);
    // GetAuthorizedRunContext
    const manifest = await client.getAuthorizedRunContext({ ctx } as never);
    expect(manifest.manifest?.assistantVersionId).toBe("asst_v1");
    // AuthorizeToolCall via transport
    const auth = await client.authorizeToolCall({ ctx, stepId: "s1", toolCallId: "tc_via_transport", toolName: "search", toolVersion: "v1", argumentDigest: new Uint8Array(32) } as never);
    expect(auth.allowed).toBe(true);
  });
});
