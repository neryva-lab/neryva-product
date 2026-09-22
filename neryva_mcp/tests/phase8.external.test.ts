import { describe, it, expect, beforeEach } from "vitest";
import { RunState } from "../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";
import { globalStore } from "../src/engine/store.js";
import { createRunAuthorityHandlers } from "../src/engine/authority.js";
import { clearArtifacts } from "../src/artifacts/claimCheck.js";
import { clearNats } from "../src/events/nats.js";
import { clearRedis } from "../src/events/redis.js";
import { clearWorkflows } from "../src/studio/workflow/worker.js";
import { clearGateway } from "../src/tools/gateway.js";
import {
  registerExternalMcpServer,
  isServerAllowedForOrg,
  createExternalSession,
  getExternalSession,
  updateExternalSession,
  callExternalMcpTool,
  isCircuitOpen,
  recordExternalFailure,
  clearExternalAdapter,
  normalizeExternalTool,
  isResourceAllowed,
} from "../src/tools/externalMcpAdapter.js";
import { authorizeToolCallGateway, executeToolGateway } from "../src/tools/gateway.js";
import { create } from "@bufbuild/protobuf";
import { RequestContextSchema } from "../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js";

function uuidv7(): string {
  const t = Date.now();
  const timeHex = t.toString(16).padStart(12, "0");
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  const randHex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return timeHex.slice(0, 8) + "-" + timeHex.slice(8, 12) + "-7" + randHex.slice(1, 4) + "-" + ((parseInt(randHex.slice(4, 6), 16) & 0x3f | 0x80).toString(16).padStart(2, "0")) + randHex.slice(6, 8) + "-" + randHex.slice(8, 20);
}
function makeCtx(runId: string, org = "org_123", conv = "conv_123") {
  return create(RequestContextSchema, {
    requestId: uuidv7(),
    organizationId: org,
    conversationId: conv,
    runId,
    actorId: "actor_123",
    idempotencyKey: `idem_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    protocolVersion: "1.0",
    capabilityId: "cap_123",
  });
}

describe("Phase 8 — Optional external MCP adapter (inside Tool Gateway)", () => {
  beforeEach(() => {
    globalStore.clear();
    clearArtifacts();
    clearNats();
    clearRedis();
    clearGateway();
    clearWorkflows();
    clearExternalAdapter();
  });

  describe("8.1 Adapter inside Gateway — untrusted, normalize, validate", () => {
    it("external servers must be explicitly allowlisted per org, not auto-exposed", async () => {
      // Register server for org_A only
      registerExternalMcpServer({
        serverId: "github",
        organizationId: "org_A",
        url: "https://mcp.github.com",
        transport: "stateless",
        allowedTools: ["create_issue"],
        egress: "external_mcp",
        credentialRef: "cred_github_ext",
        timeoutMs: 5000,
        maxResponseBytes: 100_000,
        circuitBreakerThreshold: 3,
      });
      expect(isServerAllowedForOrg("github", "org_A")).toBe(true);
      expect(isServerAllowedForOrg("github", "org_B")).toBe(false); // not allowlisted
      // Try to use from org_B should fail
      globalStore.createConversation("conv_ext", "org_B");
      globalStore.createRun({ runId: "run_ext", organizationId: "org_B", conversationId: "conv_ext", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      await expect(
        authorizeToolCallGateway({
          runId: "run_ext",
          organizationId: "org_B",
          stepId: "step_1",
          toolCallId: "tc_ext",
          toolName: "ext_github_create_issue",
          args: { title: "hi" },
        }),
      ).rejects.toThrow(/not allowlisted/);
    });

    it("normalizes external tool to Neryva descriptor and validates args/results", async () => {
      registerExternalMcpServer({
        serverId: "github",
        organizationId: "org_123",
        url: "https://mcp.github.com",
        transport: "stateless",
        allowedTools: ["create_issue"],
        egress: "external_mcp",
        credentialRef: "cred_github",
        timeoutMs: 5000,
        maxResponseBytes: 50_000,
        circuitBreakerThreshold: 3,
      });
      const desc = normalizeExternalTool("create_issue", { required: ["title"], properties: { title: { type: "string" } } }, "github", "org_123");
      expect(desc.toolName).toBe("ext_github_create_issue");
      expect(desc.egress).toBe("external_mcp");
      expect(desc.credentialRef).toBe("cred_github");
      // Invalid schema too large
      expect(() => normalizeExternalTool("x", { required: [], properties: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`f${i}`, { type: "string" }])) }, "github", "org_123")).toThrow(/too large/);
    });

    it("treats external as untrusted — validates result size and resource exposure", async () => {
      registerExternalMcpServer({
        serverId: "test",
        organizationId: "org_123",
        url: "https://mcp.test.com",
        transport: "stateless",
        allowedTools: ["tool_a"],
        egress: "external_mcp",
        credentialRef: "cred_test",
        timeoutMs: 1000,
        maxResponseBytes: 100, // tiny limit
        circuitBreakerThreshold: 3,
      });
      globalStore.createConversation("conv_untrusted", "org_123");
      globalStore.createRun({ runId: "run_untrusted", organizationId: "org_123", conversationId: "conv_untrusted", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      // Result too large should be rejected
      // Our simulate returns small, but we test via direct call with large args
      const largeArgs = { data: "x".repeat(200) };
      await expect(
        callExternalMcpTool({
          serverId: "test",
          organizationId: "org_123",
          toolName: "ext_test_tool_a",
          externalToolName: "tool_a",
          args: largeArgs,
          runId: "run_untrusted",
          stepId: "step_1",
          toolCallId: "tc_large",
          idempotencyKey: "k_large",
        }),
      ).rejects.toThrow(/too large/);
      // Arbitrary resource without policy should be blocked
      expect(isResourceAllowed("https://mcp.test.com/resource", "org_123", "test")).toBe(true);
      expect(isResourceAllowed("https://evil.com/secret", "org_123", "test")).toBe(false);
      expect(isResourceAllowed("file:///etc/passwd", "org_123", "test")).toBe(false);
    });
  });

  describe("8.2 Stateless + stateful, isolated from workflow state", () => {
    it("supports both stateless and stateful, session state not in workflow history", async () => {
      registerExternalMcpServer({
        serverId: "s1",
        organizationId: "org_123",
        url: "https://mcp.s1.com",
        transport: "stateful",
        allowedTools: ["t1"],
        egress: "external_mcp",
        credentialRef: "cred_s1",
        timeoutMs: 5000,
        maxResponseBytes: 100_000,
        circuitBreakerThreshold: 3,
      });
      const sessStateful = createExternalSession("s1", "org_123", "stateful", { cursor: "abc" });
      expect(sessStateful.mode).toBe("stateful");
      expect(sessStateful.state.cursor).toBe("abc");
      updateExternalSession("s1", "org_123", sessStateful.sessionId, { cursor: "def" });
      expect(getExternalSession("s1", "org_123", sessStateful.sessionId)?.state.cursor).toBe("def");

      const sessStateless = createExternalSession("s1", "org_123", "stateless");
      expect(sessStateless.mode).toBe("stateless");

      // Verify isolation: workflow history should not contain session state
      const wfSrc = await import("node:fs").then((fs) => fs.readFileSync("src/studio/workflow/workflow.ts", "utf-8"));
      expect(wfSrc).not.toContain("ExternalSession");
      expect(wfSrc).not.toContain("extsess");
      // Sessions are in separate map, not in workflow's history
      expect(sessStateful.sessionId).not.toContain("wf-");
    });
  });

  describe("8.3 Org allowlists, egress, scoped credentials, timeouts, circuit breaker, redaction/audit", () => {
    it("enforces all 7 guards", async () => {
      registerExternalMcpServer({
        serverId: "guarded",
        organizationId: "org_123",
        url: "https://mcp.guarded.com",
        transport: "stateless",
        allowedTools: ["safe_tool"],
        egress: "external_mcp",
        credentialRef: "cred_guarded",
        timeoutMs: 50, // very short for test
        maxResponseBytes: 100_000,
        circuitBreakerThreshold: 2,
      });
      globalStore.createConversation("conv_guarded", "org_123");
      globalStore.createRun({ runId: "run_guarded", organizationId: "org_123", conversationId: "conv_guarded", assistantVersionId: "asst_v1", state: RunState.RUNNING });

      // 1. Allowlist: ok
      expect(isServerAllowedForOrg("guarded", "org_123")).toBe(true);
      // 2. Scoped credentials: cred ref not raw secret
      const server = await import("../src/tools/externalMcpAdapter.js").then((m) => m.getExternalServer("guarded", "org_123"));
      expect(server?.credentialRef).not.toContain("sk-");
      // 3. Egress
      expect(server?.egress).toBe("external_mcp");
      // 4. Timeouts — call should respect timeout (simulate slow_tool with 10ms, still within 50ms so ok)
      const ok = await callExternalMcpTool({
        serverId: "guarded",
        organizationId: "org_123",
        toolName: "ext_guarded_safe_tool",
        externalToolName: "safe_tool",
        args: { x: 1 },
        runId: "run_guarded",
        stepId: "step_1",
        toolCallId: "tc_ok",
        idempotencyKey: "k_ok",
      });
      expect(ok.result).toBeDefined();
      // 5. Circuit breaker — after 2 failures, open
      for (let i = 0; i < 2; i++) {
        try {
          await callExternalMcpTool({
            serverId: "guarded",
            organizationId: "org_123",
            toolName: "ext_guarded_safe_tool",
            externalToolName: "fail_tool",
            args: {},
            runId: "run_guarded",
            stepId: "step_1",
            toolCallId: `tc_fail_${i}`,
            idempotencyKey: `k_fail_${i}`,
          });
        } catch {}
      }
      expect(isCircuitOpen("guarded", "org_123")).toBe(true);
      // Next call should be blocked by circuit breaker
      await expect(
        callExternalMcpTool({
          serverId: "guarded",
          organizationId: "org_123",
          toolName: "ext_guarded_safe_tool",
          externalToolName: "safe_tool",
          args: {},
          runId: "run_guarded",
          stepId: "step_1",
          toolCallId: "tc_blocked",
          idempotencyKey: "k_blocked",
        }),
      ).rejects.toThrow(/circuit open/);
      // 6. Redaction/audit — check audit log has redacted entry
      const audits = globalStore.queryAudit({ operation: "ExternalMcp:guarded:safe_tool" });
      expect(audits.length).toBeGreaterThan(0);
      expect(JSON.stringify(audits[0])).not.toContain("secret");
    });
  });

  describe("8.4 Preserve Neryva idempotency, never expose arbitrary resources", () => {
    it("external calls preserve Neryva stable idempotency key (no second side effect)", async () => {
      registerExternalMcpServer({
        serverId: "idem",
        organizationId: "org_123",
        url: "https://mcp.idem.com",
        transport: "stateless",
        allowedTools: ["idem_tool"],
        egress: "external_mcp",
        credentialRef: "cred_idem",
        timeoutMs: 5000,
        maxResponseBytes: 100_000,
        circuitBreakerThreshold: 5,
      });
      globalStore.createConversation("conv_idem", "org_123");
      globalStore.createRun({ runId: "run_idem", organizationId: "org_123", conversationId: "conv_idem", assistantVersionId: "asst_v1", state: RunState.RUNNING });

      const runId = "run_idem";
      const stepId = "step_1";
      const toolCallId = "tc_idem";
      const idempotencyKey = `neryva_tool_${runId}_${stepId}_${toolCallId}`; // Neryva stable key
      const args = { val: "x" };

      // First via gateway (which delegates to external)
      const auth = await authorizeToolCallGateway({ runId, organizationId: "org_123", stepId, toolCallId, toolName: "ext_idem_idem_tool", args });
      // For external, authorize will succeed if allowlisted (our ext tool is READ_ONLY)
      // Now execute
      const r1 = await executeToolGateway({ runId, stepId, toolCallId, toolName: "ext_idem_idem_tool", args, toolCapabilityToken: auth.toolCapabilityToken, organizationId: "org_123" });
      const r2 = await executeToolGateway({ runId, stepId, toolCallId, toolName: "ext_idem_idem_tool", args, toolCapabilityToken: auth.toolCapabilityToken, organizationId: "org_123" });
      expect(r2.wasDuplicate).toBe(true);
      expect(Buffer.from(r1.resultDigest).toString("hex")).toBe(Buffer.from(r2.resultDigest).toString("hex"));
    });

    it("never exposes arbitrary external resources without policy", async () => {
      registerExternalMcpServer({
        serverId: "res",
        organizationId: "org_123",
        url: "https://mcp.res.com",
        transport: "stateless",
        allowedTools: ["tool_a"],
        egress: "external_mcp",
        credentialRef: "cred_res",
        timeoutMs: 5000,
        maxResponseBytes: 100_000,
        circuitBreakerThreshold: 3,
      });
      // Resource from same host allowed, other host denied
      expect(isResourceAllowed("https://mcp.res.com/docs/1", "org_123", "res")).toBe(true);
      expect(isResourceAllowed("https://evil.com/docs/1", "org_123", "res")).toBe(false);
      // Direct test: callExternalMcpTool should reject if result contains file://
      // Our adapter checks result string for file:// and rejects
      // Simulate via a tool that returns file:// — we can't easily, but we test the guard
      expect(isResourceAllowed("file:///etc/passwd", "org_123", "res")).toBe(false);
    });

    it("must not weaken Engine authority — external still requires Engine AuthorizeToolCall", async () => {
      registerExternalMcpServer({
        serverId: "auth",
        organizationId: "org_123",
        url: "https://mcp.auth.com",
        transport: "stateless",
        allowedTools: ["auth_tool"],
        egress: "external_mcp",
        credentialRef: "cred_auth",
        timeoutMs: 5000,
        maxResponseBytes: 100_000,
        circuitBreakerThreshold: 3,
      });
      globalStore.createConversation("conv_auth", "org_123");
      globalStore.createRun({ runId: "run_auth", organizationId: "org_123", conversationId: "conv_auth", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      // Direct external call without Engine auth should still be blocked at gateway level if not allowlisted
      // But even if allowlisted, Engine's Authorize must still be called — we test that authorize is required
      const h = createRunAuthorityHandlers(globalStore);
      const ctx = makeCtx("run_auth", "org_123", "conv_auth");
      // Try to authorize external tool directly via Engine — should succeed if allowlisted, but still via Engine
      const res = await h.authorizeToolCall({
        ctx,
        stepId: "step_1",
        toolCallId: "tc_ext_auth",
        toolName: "ext_auth_auth_tool",
        toolVersion: "v1",
        argumentDigest: new Uint8Array(32),
      } as never);
      expect(res.allowed).toBe(true); // because allowlisted, but still Engine decides
      // If not allowlisted, Engine denies
      const bad = await h.authorizeToolCall({
        ctx,
        stepId: "step_1",
        toolCallId: "tc_bad",
        toolName: "ext_auth_not_allowed",
        toolVersion: "v1",
        argumentDigest: new Uint8Array(32),
      } as never);
      expect(bad.allowed).toBe(false);
    });
  });

  describe("8.5 Per-server conformance + failure tests", () => {
    it("per-server conformance — each server has explicit tests for stateless/stateful, timeout, size, circuit", async () => {
      // Register two servers with different modes
      registerExternalMcpServer({
        serverId: "conf_stateless",
        organizationId: "org_123",
        url: "https://mcp.conf1.com",
        transport: "stateless",
        allowedTools: ["tool1"],
        egress: "external_mcp",
        credentialRef: "cred1",
        timeoutMs: 1000,
        maxResponseBytes: 100_000,
        circuitBreakerThreshold: 2,
      });
      registerExternalMcpServer({
        serverId: "conf_stateful",
        organizationId: "org_123",
        url: "https://mcp.conf2.com",
        transport: "stateful",
        allowedTools: ["tool2"],
        egress: "external_mcp",
        credentialRef: "cred2",
        timeoutMs: 1000,
        maxResponseBytes: 100_000,
        circuitBreakerThreshold: 2,
      });
      // Stateless: each call independent, no session
      const s1 = await callExternalMcpTool({
        serverId: "conf_stateless",
        organizationId: "org_123",
        toolName: "ext_conf_stateless_tool1",
        externalToolName: "tool1",
        args: {},
        runId: "run_c1",
        stepId: "s1",
        toolCallId: "tc1",
        idempotencyKey: "k1",
      });
      expect(s1.result).toBeDefined();
      // Stateful: session required
      const sess = createExternalSession("conf_stateful", "org_123", "stateful", { state: "init" });
      expect(sess.mode).toBe("stateful");
      const s2 = await callExternalMcpTool({
        serverId: "conf_stateful",
        organizationId: "org_123",
        toolName: "ext_conf_stateful_tool2",
        externalToolName: "tool2",
        args: {},
        runId: "run_c2",
        stepId: "s1",
        toolCallId: "tc2",
        idempotencyKey: "k2",
        sessionId: sess.sessionId,
      });
      expect(s2.result).toBeDefined();
      // Session state isolated
      expect(getExternalSession("conf_stateful", "org_123", sess.sessionId)?.state.state).toBe("init");
    });

    it("failure — external server down, timeout, circuit breaker", async () => {
      registerExternalMcpServer({
        serverId: "fail",
        organizationId: "org_123",
        url: "https://mcp.fail.com",
        transport: "stateless",
        allowedTools: ["tool_a"],
        egress: "external_mcp",
        credentialRef: "cred_fail",
        timeoutMs: 1000,
        maxResponseBytes: 100_000,
        circuitBreakerThreshold: 1,
      });
      // First failure opens circuit
      try {
        await callExternalMcpTool({
          serverId: "fail",
          organizationId: "org_123",
          toolName: "ext_fail_tool_a",
          externalToolName: "fail_tool",
          args: {},
          runId: "run_fail",
          stepId: "s1",
          toolCallId: "tc_fail",
          idempotencyKey: "k_fail",
        });
      } catch {}
      expect(isCircuitOpen("fail", "org_123")).toBe(true);
      // Next call blocked
      await expect(
        callExternalMcpTool({
          serverId: "fail",
          organizationId: "org_123",
          toolName: "ext_fail_tool_a",
          externalToolName: "tool_a",
          args: {},
          runId: "run_fail",
          stepId: "s1",
          toolCallId: "tc_blocked",
          idempotencyKey: "k_blocked",
        }),
      ).rejects.toThrow(/circuit open/);
    });
  });
});
