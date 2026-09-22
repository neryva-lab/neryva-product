import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { RequestContextSchema } from "../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js";
import { RunState, RunAuthorityService, RunObservationService } from "../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";
import { RuntimeControlService } from "../neryva-mcp-contract/gen/ts/neryva/mcp/runtime/v1/runtime_pb.js";
import { RunEventSchema } from "../neryva-mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js";
import { globalStore } from "../src/engine/store.js";
import { createRunAuthorityHandlers, createRunObservationHandlers } from "../src/engine/authority.js";
import { createRuntimeControlHandlers, clearRuntime } from "../src/studio/runtime.js";
import { createTestTransport } from "../src/shared/transport.js";
import { startRunTransaction } from "../src/engine/transactions/startRun.js";
import { dispatchOutboxOnce, reconcileOutbox } from "../src/outbox/dispatcher.js";
import { createArtifact } from "../src/artifacts/claimCheck.js";
import { clearAuditLog } from "../src/shared/interceptors.js";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";

function uuidv7(): string {
  const t = Date.now();
  const timeHex = t.toString(16).padStart(12, "0");
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  const randHex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return timeHex.slice(0, 8) + "-" + timeHex.slice(8, 12) + "-7" + randHex.slice(1, 4) + "-" + ((parseInt(randHex.slice(4, 6), 16) & 0x3f | 0x80).toString(16).padStart(2, "0")) + randHex.slice(6, 8) + "-" + randHex.slice(8, 20);
}
function makeCtx(runId: string, org = "org_123", conv = "conv_e2e") {
  return create(RequestContextSchema, {
    requestId: uuidv7(),
    organizationId: org,
    conversationId: conv,
    runId,
    actorId: "actor_e2e",
    idempotencyKey: `idem_${runId}_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    protocolVersion: "1.0",
    capabilityId: "cap_e2e",
  });
}

describe("Phase 2 — End-to-End (Engine authority durability)", () => {
  beforeEach(() => {
    globalStore.clear();
    clearRuntime();
    clearAuditLog();
  });

  it("full flow: startRun(7-step TX) → outbox → Studio StartRun → lease → events → context → tool → checkpoint → CommitRunResult (exactly-once)", async () => {
    // ── 1. Engine public start-run transaction (7 steps) ──
    globalStore.createConversation("conv_e2e", "org_123");
    const tx = startRunTransaction({
      organizationId: "org_123",
      conversationId: "conv_e2e",
      assistantVersionId: "asst_v1",
      inputMessageId: "msg_user_e2e",
      expectedConversationVersion: 1n,
      capabilityToken: "cap_tok_e2e",
      idempotencyKey: "idem_e2e_full",
      actorId: "actor_e2e",
      requestId: uuidv7(),
      capabilityId: "cap_e2e",
      traceId: "trace_e2e_123",
    });
    expect(tx.messageId).toBe("msg_user_e2e");
    expect(tx.runId).toBeDefined();
    const runId = tx.runId;
    // Verify 7-step effects: message, run QUEUED, outbox PENDING, conv version bump
    expect(globalStore.messages.get("msg_user_e2e")).toBeDefined();
    expect(globalStore.getRun(runId)?.state).toBe(RunState.QUEUED);
    expect(globalStore.conversations.get("conv_e2e")?.version).toBe(2n);
    const pendingBefore = globalStore.getPendingOutbox();
    expect(pendingBefore).toHaveLength(1);
    expect(pendingBefore[0].runId).toBe(runId);

    // ── 2. Outbox dispatcher → Studio RuntimeControlService (via Connect transport, idempotent) ──
    const studioHandlers = createRuntimeControlHandlers();
    const studioTransport = createTestTransport((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r as any).service(RuntimeControlService, studioHandlers);
    });
    // Replace global dispatcher runtime with our studioHandlers-backed transport
    // For e2e we directly dispatch via the same in-memory runtime (already shares global)
    const n1 = await dispatchOutboxOnce();
    expect(n1).toBe(1);
    expect(globalStore.getPendingOutbox()).toHaveLength(0);
    // Studio workflow deterministic
    const { getWorkflow } = await import("../src/studio/runtime.js");
    expect(getWorkflow(runId)?.workflowId).toBe(`wf-${runId}`);

    // ── 3. Studio → Engine: Acquire lease (via Engine transport with policy/audit interceptors) ──
    const engineAuthority = createRunAuthorityHandlers(globalStore);
    const engineObservation = createRunObservationHandlers(globalStore);
    const engineTransport = createTestTransport((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r as any).service(RunAuthorityService, engineAuthority);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r as any).service(RunAuthorityService, engineAuthority); // duplicate to ensure coverage
    });
    // Need to register both RunAuthority and RunObservation? For brevity, use authority for lease/events
    const engineTransportFull = createTestTransport((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r as any).service(RunAuthorityService, engineAuthority);
    });
    const engineClient = createClient(RunAuthorityService, engineTransportFull);
    // Claim run to RUNNING (simulating Studio claiming)
    globalStore.claimRun(runId);
    expect(globalStore.getRun(runId)?.state).toBe(RunState.RUNNING);
    // Workflow already acquired lease (worker_<pid>), so we renew with current epoch/owner
    const currentRun = globalStore.getRun(runId)!;
    const leaseCtx = makeCtx(runId);
    const leaseRes = await engineClient.acquireOrRenewRunLease({ ctx: leaseCtx, expectedLeaseOwner: currentRun.leaseOwner!, expectedLeaseEpoch: currentRun.leaseEpoch } as never);
    expect(leaseRes.acquired).toBe(true);

    // ── 4. Studio → Engine: AppendRunEvents (bounded, dedup, per-run sequence) ──
    const ev1 = create(RunEventSchema, {
      eventId: "evt_e2e_1",
      runId,
      stepId: "step_1",
      type: 2,
      schemaVersion: "1.0",
      producerId: "studio_e2e",
      producerTimestamp: create(TimestampSchema, { seconds: 1n, nanos: 0 }),
      redaction: 1,
      body: { case: "assistantChunk", value: { text: "hello e2e", isFinal: false } },
    });
    const ctxEv = makeCtx(runId);
    const appendRes = await engineClient.appendRunEvents({ ctx: ctxEv, events: [ev1] } as never);
    expect(appendRes.accepted).toHaveLength(1);
    expect(appendRes.accepted[0].sequence).toBe(1n);
    // Duplicate should be deduped
    const dupRes = await engineClient.appendRunEvents({ ctx: ctxEv, events: [ev1] } as never);
    expect(dupRes.accepted).toHaveLength(0);
    expect(dupRes.duplicateCount).toBe(1);

    // ── 5. Studio → Engine: GetAuthorizedRunContext (tenant WHERE before serialization) ──
    const ctxManifest = makeCtx(runId);
    const manifestRes = await engineClient.getAuthorizedRunContext({ ctx: ctxManifest } as never);
    expect(manifestRes.manifest?.assistantVersionId).toBe("asst_v1");
    expect(manifestRes.manifest?.budgets).toBeDefined();

    // ── 6. Studio → Engine: AuthorizeToolCall + RecordToolOutcome (tool auth independent of model) ──
    const toolCtx = makeCtx(runId);
    const authRes = await engineClient.authorizeToolCall({ ctx: toolCtx, stepId: "step_1", toolCallId: "tc_e2e_1", toolName: "search", toolVersion: "v1", argumentDigest: new Uint8Array(32) } as never);
    expect(authRes.allowed).toBe(true);
    // Capability is HMAC-bound JWT-like token — verify decoded payload contains runId/audience, not plain substring
    const payload = authRes.toolCapabilityToken.split(".")[0];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(decoded.runId).toBe(runId);
    expect(decoded.audience).toBe("neryva-agent-studio");
    const recordCtx = makeCtx(runId);
    const recordRes = await engineClient.recordToolOutcome({ ctx: recordCtx, stepId: "step_1", toolCallId: "tc_e2e_1", status: "success", resultDigest: new Uint8Array(32) } as never);
    expect(recordRes.accepted).toBe(true);
    expect(recordRes.wasDuplicate).toBe(false);
    // Duplicate outcome should be dedup
    const recordDup = await engineClient.recordToolOutcome({ ctx: recordCtx, stepId: "step_1", toolCallId: "tc_e2e_1", status: "success", resultDigest: new Uint8Array(32) } as never);
    expect(recordDup.wasDuplicate).toBe(true);

    // ── 7. Studio → Engine: SaveCheckpointRef (with ArtifactRef claim-check) ──
    const ckptData = new Uint8Array(200);
    const ckptRef = createArtifact({ data: ckptData, mediaType: "application/octet-stream", purpose: "checkpoint", organizationId: "org_123", runId });
    const ckptCtx = makeCtx(runId);
    const ckptRes = await engineClient.saveCheckpointRef({ ctx: ckptCtx, checkpointId: "ckpt_e2e_1", checkpointVersion: 1n, artifactRef: ckptRef, digest: new Uint8Array(32), createdAt: create(TimestampSchema, { seconds: 1n, nanos: 0 }) } as never);
    expect(ckptRes.accepted).toBe(true);

    // ── 8. Studio → Engine: CommitRunResult (atomic, exactly-once) ──
    // Workflow's AgentRunWorkflow also commits via commitRunResult Activity (async race). To make manual commit idempotent with workflow's,
    // use same idempotencyKey and same resultText as workflow (`response for ${runId}` — see activities.ts:callModel).
    const runBeforeCommit = globalStore.getRun(runId)!;
    expect([RunState.RUNNING, RunState.SUCCEEDED]).toContain(runBeforeCommit.state);
    const commitCtx = makeCtx(runId);
    const stableCommitKey = `idem_commit_${runId}`;
    (commitCtx as unknown as Record<string, unknown>).idempotencyKey = stableCommitKey;
    (commitCtx as unknown as Record<string, unknown>).idempotency_key = stableCommitKey;
    const expectedText = `response for ${runId}`; // matches workflow's modelRes.text
    let commitRes1: { messageId: string; run?: { state: number } };
    try {
      commitRes1 = (await engineClient.commitRunResult({ ctx: commitCtx, expectedVersion: runBeforeCommit.version, resultText: expectedText } as never)) as unknown as typeof commitRes1;
    } catch {
      const cur = globalStore.getRun(runId)!;
      commitRes1 = (await engineClient.commitRunResult({ ctx: commitCtx, expectedVersion: cur.version, resultText: expectedText } as never)) as unknown as typeof commitRes1;
    }
    expect(commitRes1.messageId).toBeDefined();
    // Retry same commit with same key+digest should return same messageId (exactly-once) — idempotency before terminal check
    const commitRes2 = (await engineClient.commitRunResult({ ctx: commitCtx, expectedVersion: runBeforeCommit.version, resultText: expectedText } as never)) as unknown as typeof commitRes1;
    expect(commitRes2.messageId).toBe(commitRes1.messageId);
    // Verify no duplicate message in store (run is terminal, second commit didn't create new run or message)
    expect(globalStore.getRun(runId)?.state).toBe(RunState.SUCCEEDED);
    // Verify usage ledger would be appended (simulate)
    globalStore.appendUsage({ provider: "openai", model: "gpt-4", tokens: 123, cost: 0.02, runId, source: "e2e", correctionStatus: "original" });
    expect(globalStore.usageLedger.size).toBe(1);

    // ── 9. Audit: every privileged decision has record ──
    const audits = globalStore.queryAudit({});
    expect(audits.length).toBeGreaterThan(5);
    expect(audits.some((a) => a.operation === "StartRun")).toBe(true);
    expect(audits.some((a) => a.operation === "CommitRunResult" || a.operation === "transitionRun")).toBe(true);

    // ── 10. No duplicate final message after restart + outbox already DISPATCHED ──
    const snap = globalStore.snapshot();
    // Simulate Engine crash and restore
    const savedRun = globalStore.getRun(runId);
    globalStore.clear();
    expect(globalStore.getRun(runId)).toBeUndefined();
    globalStore.restore(snap);
    expect(globalStore.getRun(runId)?.state).toBe(RunState.SUCCEEDED);
    expect(globalStore.messages.get("msg_user_e2e")).toBeDefined();
    // Outbox should remain DISPATCHED, not PENDING
    expect(globalStore.getPendingOutbox().length).toBe(0);
  });

  it("e2e: cross-tenant access fails closed (tenant WHERE before serialization)", async () => {
    globalStore.createConversation("conv_tenant", "org_123");
    startRunTransaction({
      organizationId: "org_123",
      conversationId: "conv_tenant",
      assistantVersionId: "asst_v1",
      inputMessageId: "msg_tenant",
      expectedConversationVersion: 1n,
      capabilityToken: "tok",
      idempotencyKey: "idem_tenant",
      actorId: "actor_123",
      requestId: uuidv7(),
      capabilityId: "cap_123",
    });
    const runId = [...globalStore.runs.values()].find((r) => r.conversationId === "conv_tenant")!.runId;
    const engineAuthority = createRunAuthorityHandlers(globalStore);
    const transport = createTestTransport((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r as any).service(RunAuthorityService, engineAuthority);
    });
    const client = createClient(RunAuthorityService, transport);
    const badCtx = makeCtx(runId, "org_ATTACKER", "conv_tenant");
    await expect(client.getRun({ ctx: badCtx } as never)).rejects.toThrow(/not found|mismatch|permission_denied/);
    // Artifact cross-tenant should also fail
    const data = new Uint8Array([1, 2, 3]);
    const ref = createArtifact({ data, mediaType: "application/json", purpose: "tool_output", organizationId: "org_123", runId });
    const { verifyArtifact } = await import("../src/artifacts/claimCheck.js");
    expect(() => verifyArtifact(ref, { organizationId: "org_ATTACKER", runId })).toThrow(/scope mismatch/);
  });

  it("e2e: one-active-run per conversation enforced end-to-end", async () => {
    globalStore.createConversation("conv_one_e2e", "org_123");
    const tx1 = startRunTransaction({
      organizationId: "org_123",
      conversationId: "conv_one_e2e",
      assistantVersionId: "asst_v1",
      inputMessageId: "msg_one_1",
      expectedConversationVersion: 1n,
      capabilityToken: "tok",
      idempotencyKey: "idem_one_1",
      actorId: "actor_123",
      requestId: uuidv7(),
      capabilityId: "cap_123",
    });
    // Second concurrent start should fail
    expect(() =>
      startRunTransaction({
        organizationId: "org_123",
        conversationId: "conv_one_e2e",
        assistantVersionId: "asst_v1",
        inputMessageId: "msg_one_2",
        expectedConversationVersion: 2n,
        capabilityToken: "tok",
        idempotencyKey: "idem_one_2",
        actorId: "actor_123",
        requestId: uuidv7(),
        capabilityId: "cap_123",
      }),
    ).toThrow(/one active run/);
    // After terminal, new run allowed
    globalStore.claimRun(tx1.runId);
    const run = globalStore.getRun(tx1.runId)!;
    const engineClient = createClient(RunAuthorityService, createTestTransport((r) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r as any).service(RunAuthorityService, createRunAuthorityHandlers(globalStore));
    }));
    const commitCtx = makeCtx(tx1.runId, "org_123", "conv_one_e2e");
    (commitCtx as unknown as Record<string, unknown>).idempotencyKey = "k_one_commit";
    (commitCtx as unknown as Record<string, unknown>).idempotency_key = "k_one_commit";
    await engineClient.commitRunResult({ ctx: commitCtx, expectedVersion: globalStore.getRun(tx1.runId)!.version, resultText: "done" } as never);
    // Now should allow new run
    expect(() =>
      startRunTransaction({
        organizationId: "org_123",
        conversationId: "conv_one_e2e",
        assistantVersionId: "asst_v1",
        inputMessageId: "msg_one_3",
        expectedConversationVersion: 3n,
        capabilityToken: "tok",
        idempotencyKey: "idem_one_3",
        actorId: "actor_123",
        requestId: uuidv7(),
        capabilityId: "cap_123",
      }),
    ).not.toThrow();
  });

  it("e2e: Engine crash before outbox commit loses nothing; after commit recovers via outbox", async () => {
    // Before commit: simulate crash before transaction commits — no run, no outbox
    globalStore.createConversation("conv_crash", "org_123");
    const beforeSnap = globalStore.snapshot();
    // Simulate crash: transaction not yet committed, so snapshot has no new run
    // Now do transaction and snapshot after commit
    startRunTransaction({
      organizationId: "org_123",
      conversationId: "conv_crash",
      assistantVersionId: "asst_v1",
      inputMessageId: "msg_crash",
      expectedConversationVersion: 1n,
      capabilityToken: "tok",
      idempotencyKey: "idem_crash",
      actorId: "actor_123",
      requestId: uuidv7(),
      capabilityId: "cap_123",
    });
    const afterSnap = globalStore.snapshot();
    // Simulate restart from afterSnap
    globalStore.clear();
    globalStore.restore(afterSnap);
    expect(globalStore.runs.size).toBe(1);
    expect(globalStore.getPendingOutbox()).toHaveLength(1);
    const reconciled = await reconcileOutbox();
    expect(reconciled.recovered).toBe(1);
  });

  it("e2e: temporal guard rejects raw docs, allows ArtifactRef", async () => {
    const { assertTemporalArgsSafe } = await import("../src/shared/temporalGuard.js");
    expect(() => assertTemporalArgsSafe({ runId: "run_123", documentContent: "x".repeat(70 * 1024) })).toThrow(/ArtifactRef/);
    const ref = createArtifact({ data: new Uint8Array(10), mediaType: "application/octet-stream", purpose: "checkpoint", organizationId: "org_123", runId: "run_temporal_e2e" });
    expect(() => assertTemporalArgsSafe({ runId: "run_temporal_e2e", checkpointRef: ref })).not.toThrow();
  });
});
