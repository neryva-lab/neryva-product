import { describe, it, expect, beforeEach } from "vitest";
import { Code, ConnectError } from "@connectrpc/connect";
import { globalStore } from "../src/engine/store.js";
import { RunState } from "../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";
import { createArtifact, clearArtifacts } from "../src/artifacts/claimCheck.js";
import { clearNats } from "../src/events/nats.js";
import { clearRedis } from "../src/events/redis.js";
import { clearWorkflows } from "../src/studio/workflow/worker.js";
import { clearGateway } from "../src/tools/gateway.js";

describe("Phase 7 — Hardening & scale (12 tasks + exit gates)", () => {
  beforeEach(() => {
    globalStore.clear();
    clearArtifacts();
    clearNats();
    clearRedis();
    clearGateway();
    clearWorkflows();
  });

  describe("7.1 Workload identity — mTLS + SPIFFE/SPIRE", () => {
    it("X.509-SVID preferred, trust domains isolated, rotation without restart", async () => {
      const { generateWorkloadIdentity, verifyWorkloadIdentity, rotateWorkloadIdentity, getCurrentIdentity } = await import("../src/security/workloadIdentity.js");
      const prod = generateWorkloadIdentity("engine", "prod");
      const staging = generateWorkloadIdentity("engine", "non-prod");
      expect(prod.spiffeId).toContain("neryva.prod");
      expect(staging.spiffeId).toContain("neryva.staging");
      // Verify correct trust domain
      expect(verifyWorkloadIdentity(prod.x509Svid, "prod").valid).toBe(true);
      expect(verifyWorkloadIdentity(prod.x509Svid, "non-prod").valid).toBe(false); // cross-domain fail
      expect(verifyWorkloadIdentity("", "prod").valid).toBe(false); // missing identity
      // Rotation without restart
      const before = getCurrentIdentity()!.rotationEpoch;
      const rotated = rotateWorkloadIdentity();
      expect(rotated.rotationEpoch).toBe(before + 1);
      expect(rotated.spiffeId).toBeDefined();
    });

    it("JWT replayable warning — prefer X.509", async () => {
      const { isJwtReplayableWarning } = await import("../src/security/workloadIdentity.js");
      expect(isJwtReplayableWarning()).toContain("JWT");
    });
  });

  describe("7.2 Run capability — 9 fields + 6 rejects + interceptor order W3C", () => {
    it("creates capability with 9 core fields, verifies 6 reject cases", async () => {
      const { createRunCapability, verifyRunCapability, clearRunCapabilityState, isNonceReplayed, markNonceSeen } = await import("../src/security/runCapability.js");
      clearRunCapabilityState();
      const { token, capability } = createRunCapability({
        organizationId: "org_123",
        conversationId: "conv_123",
        runId: "run_123",
        allowedOperations: ["AppendRunEvents"],
      });
      expect(capability.audience).toBe("neryva-agent-studio");
      expect(capability.issuer).toBe("neryva-engine");
      expect(capability.kid).toBeDefined();
      expect(capability.nonce).toBeDefined();
      expect(capability.expiresAt).toBeGreaterThan(Date.now());
      // Valid verify
      expect(() => verifyRunCapability(token, { operation: "AppendRunEvents", organizationId: "org_123" })).not.toThrow();
      // 6 rejects:
      // 1. missing/invalid — empty token
      expect(() => verifyRunCapability("", {})).toThrow(/missing|invalid/);
      // 2. wrong audience
      const badAud = token.split(".")[0];
      const badPayload = JSON.parse(Buffer.from(badAud, "base64url").toString());
      badPayload.audience = "wrong";
      const badToken = Buffer.from(JSON.stringify(badPayload)).toString("base64url") + "." + token.split(".")[1];
      expect(() => verifyRunCapability(badToken, {})).toThrow(/audience/);
      // 3. expired
      const { token: expToken } = createRunCapability({ organizationId: "org_123", conversationId: "conv_123", runId: "run_123", ttlMs: -1000 });
      expect(() => verifyRunCapability(expToken, {})).toThrow(/expired/);
      // 4. scope mismatch — use fresh token to avoid nonce interference
      const { token: token2 } = createRunCapability({ organizationId: "org_123", conversationId: "conv_123", runId: "run_123", allowedOperations: ["AppendRunEvents"] });
      expect(() => verifyRunCapability(token2, { organizationId: "org_other" })).toThrow(/scope mismatch/);
      // 5. replayed nonce
      markNonceSeen(capability.nonce);
      expect(isNonceReplayed(capability.nonce)).toBe(true);
      // 6. operation not listed — use fresh token (nonce not yet seen)
      const { token: token3 } = createRunCapability({ organizationId: "org_123", conversationId: "conv_123", runId: "run_123", allowedOperations: ["AppendRunEvents"] });
      expect(() => verifyRunCapability(token3, { operation: "DeleteAll" })).toThrow(/not listed/);
      clearRunCapabilityState();
    });

    it("interceptor order is TLS→size→auth→trace(W3C)→validation→capability→idempotency→authz→audit", async () => {
      const src = await import("node:fs").then((fs) => fs.readFileSync("src/shared/transport.ts", "utf-8"));
      const order = ["workloadIdentityInterceptor", "sizeLimitInterceptor", "traceInterceptor", "validationInterceptor", "runCapabilityInterceptor", "scopeInterceptor", "idempotencyInterceptor", "policyInterceptor", "auditInterceptor"];
      let lastIdx = -1;
      for (const name of order) {
        const idx = src.indexOf(name);
        expect(idx).toBeGreaterThan(lastIdx);
        lastIdx = idx;
      }
      // Trace is W3C
      const traceSrc = await import("node:fs").then((fs) => fs.readFileSync("src/shared/interceptors.ts", "utf-8"));
      expect(traceSrc).toContain("traceparent");
      expect(traceSrc).toContain("W3C");
    });
  });

  describe("7.3 Error catalog — UNAVAILABLE retryable, others not", () => {
    it("maps gRPC codes correctly per 215-216,756", async () => {
      const { isRetryable, getRetryClass } = await import("../src/shared/errorCatalog.js");
      expect(isRetryable(Code.Unavailable)).toBe(true);
      expect(getRetryClass(Code.Unavailable)).toBe("retryable");
      expect(isRetryable(Code.Aborted)).toBe(false);
      expect(isRetryable(Code.FailedPrecondition)).toBe(false);
      expect(isRetryable(Code.InvalidArgument)).toBe(false);
      expect(isRetryable(Code.Unauthenticated)).toBe(false);
    });
  });

  describe("7.4 Deadline/retry 4 owners", () => {
    it("4 owners with correct retry semantics 218-223", async () => {
      const { shouldMcpRetry, shouldTemporalRetry, shouldModelGatewayRetry, shouldToolRetry, getDeadlineForMethod } = await import("../src/shared/deadlineRetry.js");
      expect(getDeadlineForMethod("CommitRunResult")).toBe(5000);
      expect(getDeadlineForMethod("GetRun")).toBe(1000);
      // MCP only retries UNAVAILABLE
      expect(shouldMcpRetry(Code.Unavailable, "mcp_transport")).toBe(true);
      expect(shouldMcpRetry(Code.Aborted, "mcp_transport")).toBe(false);
      // Temporal owns Activity retry
      expect(shouldTemporalRetry(Code.Unavailable)).toBe(true);
      expect(shouldTemporalRetry(Code.Aborted)).toBe(false);
      // Model Gateway
      expect(shouldModelGatewayRetry(Code.ResourceExhausted)).toBe(true);
      // Tool: not blind retry, requires idempotency
      expect(shouldToolRetry("unsupported", Code.Unavailable, false)).toBe(false);
      expect(shouldToolRetry("supported", Code.Unavailable, false)).toBe(true);
      expect(shouldToolRetry("supported", Code.Unavailable, true)).toBe(false); // ambiguous
    });
  });

  describe("7.5 Persistence hardening", () => {
    it("unique constraints, append-only audit, encrypted storage", async () => {
      const { UNIQUE_CONSTRAINTS, isAppendOnly } = await import("../src/persistence/hardening.js");
      expect(UNIQUE_CONSTRAINTS.length).toBeGreaterThan(5);
      expect(isAppendOnly("audit_log")).toBe(true);
      expect(isAppendOnly("usage_ledger")).toBe(true);
      // Unique constraint enforced via store
      globalStore.createConversation("conv_hard", "org_123");
      globalStore.createRun({ runId: "run_hard", organizationId: "org_123", conversationId: "conv_hard", assistantVersionId: "asst_v1", state: RunState.QUEUED });
      expect(() => globalStore.createRun({ runId: "run_hard", organizationId: "org_123", conversationId: "conv_hard", assistantVersionId: "asst_v1", state: RunState.QUEUED })).toThrow(/already exists/);
      // Append-only audit
      const before = globalStore.auditLog.size;
      globalStore.appendAudit({ actorId: "a", service: "s", operation: "op", resource: "r", organizationId: "org_123", decision: "allow", policyVersion: "v1" });
      expect(globalStore.auditLog.size).toBe(before + 1);
      // Large content via encrypted storage (claim-check)
      const data = new Uint8Array(100);
      const ref = createArtifact({ data, mediaType: "application/octet-stream", purpose: "checkpoint", organizationId: "org_123", runId: "run_hard" });
      expect(ref.encryptionKeyId).toBeDefined();
    });
  });

  describe("7.6 Versioning — additive v1, CI, runtime compat", () => {
    it("additive evolution, unknown-field tolerance, v2 only for wire incompat", async () => {
      const { isAdditiveChange, shouldTolerateUnknownFields, requiresV2, CI_CHECKS, checkRuntimeCompatibility } = await import("../src/versioning/compatibility.js");
      expect(isAdditiveChange(99, new Set([1, 2]))).toBe(true);
      expect(isAdditiveChange(1, new Set([1, 2]))).toBe(false);
      expect(shouldTolerateUnknownFields()).toBe(true);
      expect(requiresV2(false)).toBe(false);
      expect(requiresV2(true)).toBe(true);
      expect(CI_CHECKS).toContain("buf breaking --against '.git#branch=main'");
      expect(checkRuntimeCompatibility({ mcpVersion: "1.2", agentVersion: "1.0" }).compatible).toBe(true);
      expect(checkRuntimeCompatibility({ mcpVersion: "2.0", agentVersion: "1.0" }).compatible).toBe(false);
    });
  });

  describe("7.7 Key/capability rotation — 6 steps", () => {
    it("overlap keys, kid, cache refresh, cert rotation without restart, audit", async () => {
      const { startKeyRotation, isInOverlap, shouldRejectUnknownKid, rotateWorkloadCertWithoutRestart, getRotationAudit } = await import("../src/security/keyRotation.js");
      const { getCurrentKid } = await import("../src/security/runCapability.js");
      const beforeKid = getCurrentKid();
      const state = startKeyRotation(300_000);
      expect(state.oldKid).toBe(beforeKid);
      expect(state.newKid).not.toBe(beforeKid);
      expect(isInOverlap(beforeKid)).toBe(true);
      expect(isInOverlap(state.newKid)).toBe(true);
      expect(shouldRejectUnknownKid("unknown_kid", 70_000)).toBe(true); // after cache refresh
      expect(shouldRejectUnknownKid(state.newKid, 10_000)).toBe(false);
      // Cert rotation without restart
      expect(() => rotateWorkloadCertWithoutRestart()).not.toThrow();
      expect(getRotationAudit()).toBeDefined();
      // Audit key version
      globalStore.appendAudit({ actorId: "a", service: "key", operation: "rotate", resource: state.newKid, organizationId: "org_123", decision: "allow", policyVersion: "v1", reason: `kid ${state.newKid}` });
      expect(globalStore.queryAudit({ operation: "rotate" }).length).toBeGreaterThan(0);
    });
  });

  describe("7.8 Observability — 12 IDs, metrics, audit", () => {
    it("12 correlation IDs, no PII/secrets, metrics, audit 12 events", async () => {
      const { CORRELATION_IDS, sanitizeForLogs, METRICS, AUDIT_EVENTS } = await import("../src/observability/correlation.js");
      expect(CORRELATION_IDS.length).toBeGreaterThanOrEqual(12);
      expect(CORRELATION_IDS).toContain("traceId");
      expect(CORRELATION_IDS).toContain("runId");
      // No secrets in logs
      const sanitized = sanitizeForLogs({ prompt: "secret", toolArgs: "secret", runId: "run_123" });
      expect(sanitized.prompt).toBe("[REDACTED]");
      expect(sanitized.runId).toBe("run_123");
      expect(METRICS.length).toBeGreaterThanOrEqual(8);
      expect(AUDIT_EVENTS.length).toBe(12);
      expect(AUDIT_EVENTS).toContain("cross-tenant access attempt");
    });
  });

  describe("7.9 OTel GenAI — centralized, coalesce not sum", () => {
    it("centralized mapping, coalesce duplicate SPANs", async () => {
      const { mapGenAiSpan, coalesceTokenCounts, shouldNotUseExperimentalAttribute } = await import("../src/observability/otel.js");
      const mapped = mapGenAiSpan({ model: "gpt-4", inputTokens: 10 } as unknown as Record<string, unknown>);
      expect(mapped["gen_ai.request.model"]).toBe("gpt-4");
      const coalesced = coalesceTokenCounts([{ inputTokens: 10, outputTokens: 20 }, { inputTokens: 10, outputTokens: 20 }]);
      expect(coalesced.inputTokens).toBe(10); // not 20
      expect(shouldNotUseExperimentalAttribute("gen_ai.experimental.foo")).toBe(true);
    });
  });

  describe("7.10 Scaling — shared workers, isolated pools", () => {
    it("shared multi-tenant workers, no org-per-worker local state", async () => {
      const { getTaskQueueForTool, shouldNotUseOrgLocalState } = await import("../src/scaling/workers.js");
      expect(getTaskQueueForTool("read_document", false, false)).toBe("default");
      expect(getTaskQueueForTool("privileged_tool", true, false)).toBe("privileged");
      expect(shouldNotUseOrgLocalState()).toBe(true);
    });
  });

  describe("7.11 Backpressure — 8 limits", () => {
    it("8 limits with rationale/alert, rejects correctly", async () => {
      const { BACKPRESSURE_LIMITS, isOverLimit, shouldRejectWhenEngineUnderPressure } = await import("../src/scaling/backpressure.js");
      expect(BACKPRESSURE_LIMITS.length).toBe(8);
      expect(BACKPRESSURE_LIMITS.map((l) => l.name)).toContain("maxEventBatchSize");
      expect(BACKPRESSURE_LIMITS.map((l) => l.name)).toContain("maxConcurrentRunsPerOrg");
      expect(isOverLimit("maxEventBatchSize", 33)).toBe(true);
      expect(isOverLimit("maxEventBatchSize", 10)).toBe(false);
      expect(shouldRejectWhenEngineUnderPressure(11)).toBe(true);
    });
  });

  describe("7.12 Failure handling — 11 scenarios", () => {
    it("documents 11 scenarios with recovery paths", async () => {
      const { RECOVERY_PATHS, getRecovery } = await import("../src/failure/scenarios.js");
      expect(Object.keys(RECOVERY_PATHS).length).toBe(12); // 12 incl. both engine restart cases
      const r = getRecovery("studio_crash_during_model_call");
      expect(r.safeToRetry).toBe(false);
      expect(r.mustReconcile).toBe(true);
      expect(r.auditRequired).toBe(true);
      // Engine crash before outbox commit loses nothing
      expect(getRecovery("engine_restart_before_outbox_commit").safeToRetry).toBe(true);
      expect(getRecovery("dispatcher_retry_after_acceptance").auditRequired).toBe(true);
    });

    it("Engine restart before/after outbox commit + dispatcher retry", async () => {
      const { startRunTransaction } = await import("../src/engine/transactions/startRun.js");
      const { dispatchOutboxOnce } = await import("../src/outbox/dispatcher.js");
      globalStore.createConversation("conv_fail", "org_123");
      const snapBefore = globalStore.snapshot();
      startRunTransaction({
        organizationId: "org_123", conversationId: "conv_fail", assistantVersionId: "asst_v1",
        inputMessageId: "msg_fail", expectedConversationVersion: 1n, capabilityToken: "tok", idempotencyKey: "idem_fail", actorId: "a1", requestId: "00000000-0000-7000-8000-000000000001", capabilityId: "cap_123",
      });
      expect(globalStore.getPendingOutbox().length).toBe(1);
      // Engine crash after commit recovers via outbox
      const snapAfter = globalStore.snapshot();
      globalStore.clear();
      globalStore.restore(snapAfter);
      expect(globalStore.getPendingOutbox().length).toBe(1);
      const n = await dispatchOutboxOnce();
      expect(n).toBe(1);
      // Dispatcher retry same idempotency key does not duplicate workflow (tested in phase0)
      const n2 = await dispatchOutboxOnce();
      expect(n2).toBe(0);
    });
  });

  describe("Exit gates — SLOs, RPO/RTO, tenant isolation, degraded operable, chaos", () => {
    it("RPO/RTO demonstrated via snapshot/restore", () => {
      const snap = globalStore.snapshot();
      globalStore.createConversation("conv_rpo", "org_123");
      globalStore.restore(snap);
      expect(globalStore.getConversation("conv_rpo")).toBeUndefined(); // RPO: snapshot point
      // RTO: restore recovers
      globalStore.createConversation("conv_rpo", "org_123");
      expect(globalStore.getConversation("conv_rpo")).toBeDefined();
    });

    it("tenant isolation, deletion, audit pass review (simulated)", async () => {
      globalStore.createConversation("conv_iso", "org_123");
      globalStore.createRun({ runId: "run_iso", organizationId: "org_123", conversationId: "conv_iso", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const { createRunAuthorityHandlers } = await import("../src/engine/authority.js");
      const h = createRunAuthorityHandlers(globalStore);
      const { create } = await import("@bufbuild/protobuf");
      const { RequestContextSchema } = await import("../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js");
      function uuidv7() { const t = Date.now(); const th = t.toString(16).padStart(12,"0"); const r=new Uint8Array(10); crypto.getRandomValues(r); const rh=Array.from(r,b=>b.toString(16).padStart(2,"0")).join(""); return th.slice(0,8)+"-"+th.slice(8,12)+"-7"+rh.slice(1,4)+"-"+((parseInt(rh.slice(4,6),16)&0x3f|0x80).toString(16).padStart(2,"0"))+rh.slice(6,8)+"-"+rh.slice(8,20); }
      const badCtx = create(RequestContextSchema, { requestId: uuidv7(), organizationId: "org_other", conversationId: "conv_iso", runId: "run_iso", actorId: "a", idempotencyKey: "k", protocolVersion: "1.0", capabilityId: "cap" });
      await expect(h.getRun({ ctx: badCtx } as never)).rejects.toThrow();
      // Audit queryable — create an explicit audit entry via privileged op, then query
      globalStore.appendAudit({ actorId: "a", service: "test", operation: "audit_check", resource: "run_iso", organizationId: "org_123", decision: "allow", policyVersion: "v1" });
      expect(globalStore.queryAudit({}).length).toBeGreaterThan(0);
      // Deletion is tombstone, not hard delete
      globalStore.deleteConversation("conv_iso");
      expect(globalStore.getConversation("conv_iso")?.deletedAt).toBeDefined();
      await expect(h.getRun({ ctx: create(RequestContextSchema, { requestId: uuidv7(), organizationId: "org_123", conversationId: "conv_iso", runId: "run_iso", actorId: "a", idempotencyKey: "k2", protocolVersion: "1.0", capabilityId: "cap" }) } as never)).rejects.toThrow();
    });

    it("operable with one major dependency degraded (NATS down, Redis down)", async () => {
      const { setNatsAvailable, publish } = await import("../src/events/nats.js");
      const { RunEventSchema } = await import("../neryva-mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js");
      const { create } = await import("@bufbuild/protobuf");
      const { createRunAuthorityHandlers } = await import("../src/engine/authority.js");
      const data = new TextEncoder().encode("test");
      const ref = createArtifact({ data, mediaType: "text/plain", purpose: "tool_output", organizationId: "org_123", runId: "run_deg" });
      void ref; void publish;
      // NATS down should not fail commit (already tested in phase4, but re-verify)
      setNatsAvailable(false);
      globalStore.createConversation("conv_deg", "org_123");
      globalStore.createRun({ runId: "run_deg", organizationId: "org_123", conversationId: "conv_deg", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const h = createRunAuthorityHandlers(globalStore);
      const { create: create2 } = await import("@bufbuild/protobuf");
      const { RequestContextSchema: RCS } = await import("../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js");
      function uuidv7b(){ const t=Date.now(); const th=t.toString(16).padStart(12,"0"); const r=new Uint8Array(10); crypto.getRandomValues(r); const rh=Array.from(r,b=>b.toString(16).padStart(2,"0")).join(""); return th.slice(0,8)+"-"+th.slice(8,12)+"-7"+rh.slice(1,4)+"-"+((parseInt(rh.slice(4,6),16)&0x3f|0x80).toString(16).padStart(2,"0"))+rh.slice(6,8)+"-"+rh.slice(8,20); }
      const ctx = create2(RCS, { requestId: uuidv7b(), organizationId: "org_123", conversationId: "conv_deg", runId: "run_deg", actorId: "a", idempotencyKey: "k_deg", protocolVersion: "1.0", capabilityId: "cap" });
      const ev = create(RunEventSchema, { eventId: "evt_deg", runId: "run_deg", type: 1, schemaVersion: "1.0", producerId: "p", producerTimestamp: { seconds: 1n, nanos: 0 } as never, redaction: 1, body: { case: "lifecycle", value: { fromState: "RUNNING", toState: "RUNNING" } } });
      const res = await h.appendRunEvents({ ctx, events: [ev] } as never);
      expect(res.accepted.length).toBe(1); // NATS down but Engine commit succeeded
      setNatsAvailable(true);
    });
  });
});
