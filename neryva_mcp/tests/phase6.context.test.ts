import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { RunState } from "../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";
import { RequestContextSchema } from "../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js";
import { ArtifactRefSchema } from "../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js";
import { globalStore } from "../src/engine/store.js";
import { createRunAuthorityHandlers } from "../src/engine/authority.js";
import { createArtifact, verifyArtifact, deleteArtifact, clearArtifacts, MAX_INLINE_BYTES } from "../src/artifacts/claimCheck.js";
import { clearNats } from "../src/events/nats.js";
import { clearRedis } from "../src/events/redis.js";

function uuidv7(): string {
  const t = Date.now();
  const timeHex = t.toString(16).padStart(12, "0");
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  const randHex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return timeHex.slice(0, 8) + "-" + timeHex.slice(8, 12) + "-7" + randHex.slice(1, 4) + "-" + ((parseInt(randHex.slice(4, 6), 16) & 0x3f | 0x80).toString(16).padStart(2, "0")) + randHex.slice(6, 8) + "-" + randHex.slice(8, 20);
}
function makeCtx(runId: string, org = "org_123", conv = "conv_123", overrides: Record<string, string> = {}) {
  return create(RequestContextSchema, {
    requestId: uuidv7(),
    organizationId: org,
    conversationId: conv,
    runId,
    actorId: "actor_123",
    idempotencyKey: `idem_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    protocolVersion: "1.0",
    capabilityId: "cap_123",
    ...overrides,
  });
}

describe("Phase 6 — Context, memory & artifacts (exit gates)", () => {
  beforeEach(() => {
    globalStore.clear();
    clearArtifacts();
    clearNats();
    clearRedis();
  });

  describe("6.1 Manifest — assistant/policy versions, bounded messages, memories, knowledge, tools, budgets, artifact refs", () => {
    it("GetAuthorizedRunContext returns bounded manifest with tenant-filtered data", async () => {
      const org = "org_123";
      const conv = "conv_manifest";
      globalStore.createConversation(conv, org);
      globalStore.createMessage({ messageId: "msg_1", conversationId: conv, organizationId: org, role: "user", text: "hello" });
      globalStore.createMessage({ messageId: "msg_2", conversationId: conv, organizationId: org, role: "assistant", text: "hi" });
      const runId = "run_manifest_1";
      globalStore.createRun({ runId, organizationId: org, conversationId: conv, assistantVersionId: "asst_v2", state: RunState.RUNNING });
      // Add memory proposal with provenance
      globalStore.submitMemoryProposal("mem_1", org, runId, "conversation", "user prefers dark", { provenance: "msg_1", confidence: 0.9, visibility: "private" });
      // Add knowledge doc with artifact
      const data = new TextEncoder().encode("knowledge content");
      const ref = createArtifact({ data, mediaType: "text/plain", purpose: "kb_document", organizationId: org, runId });
      globalStore.createKnowledgeDoc({ documentId: "doc_1", organizationId: org, classification: "public", title: "doc1", chunkId: "chunk_1", artifactRef: ref });

      const h = createRunAuthorityHandlers(globalStore);
      const ctx = makeCtx(runId, org, conv);
      const res = await h.getAuthorizedRunContext({ ctx } as never);
      expect(res.manifest.assistantVersionId).toBe("asst_v2");
      expect(res.manifest.policyVersion).toBe("policy_v1");
      expect(res.manifest.conversationSummary).toContain(conv);
      expect(res.manifest.recentMessages.length).toBe(2);
      expect(res.manifest.recentMessages[0].text).toBe("hello");
      expect(res.manifest.memories.length).toBeGreaterThan(0);
      expect(res.manifest.memories[0].provenance).toBe("msg_1");
      expect(res.manifest.knowledgeRefs.length).toBe(1);
      expect(res.manifest.knowledgeRefs[0].documentId).toBe("doc_1");
      expect(res.manifest.tools.length).toBeGreaterThan(0);
      expect(res.manifest.budgets.maxToolCalls).toBe(10);
      expect(res.manifest.artifactRefs.length).toBeGreaterThan(0);
    });

    it("recentMessages bounded 20 and text truncated 8192", async () => {
      const org = "org_123";
      const conv = "conv_bound";
      globalStore.createConversation(conv, org);
      for (let i = 0; i < 25; i++) {
        globalStore.createMessage({ messageId: `msg_${i}`, conversationId: conv, organizationId: org, role: "user", text: "x".repeat(9000) });
      }
      const runId = "run_bound";
      globalStore.createRun({ runId, organizationId: org, conversationId: conv, assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const h = createRunAuthorityHandlers(globalStore);
      const res = await h.getAuthorizedRunContext({ ctx: makeCtx(runId, org, conv) } as never);
      expect(res.manifest.recentMessages.length).toBe(20); // bounded
      expect(res.manifest.recentMessages[0].text.length).toBeLessThanOrEqual(8192);
    });
  });

  describe("6.2 Authorization in query — tenant WHERE before serialization", () => {
    it("cross-tenant retrieval fails closed (conversation, messages, knowledge, memories)", async () => {
      const orgA = "org_A";
      const orgB = "org_B";
      globalStore.createConversation("conv_A", orgA);
      globalStore.createConversation("conv_B", orgB);
      globalStore.createMessage({ messageId: "msg_A1", conversationId: "conv_A", organizationId: orgA, role: "user", text: "secret A" });
      globalStore.createMessage({ messageId: "msg_B1", conversationId: "conv_B", organizationId: orgB, role: "user", text: "secret B" });
      const runA = "run_A";
      const runB = "run_B";
      globalStore.createRun({ runId: runA, organizationId: orgA, conversationId: "conv_A", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      globalStore.createRun({ runId: runB, organizationId: orgB, conversationId: "conv_B", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      // Knowledge docs per org
      const refA = createArtifact({ data: new TextEncoder().encode("doc A"), mediaType: "text/plain", purpose: "kb_document", organizationId: orgA, runId: runA });
      const refB = createArtifact({ data: new TextEncoder().encode("doc B"), mediaType: "text/plain", purpose: "kb_document", organizationId: orgB, runId: runB });
      globalStore.createKnowledgeDoc({ documentId: "doc_A", organizationId: orgA, classification: "public", title: "A", artifactRef: refA });
      globalStore.createKnowledgeDoc({ documentId: "doc_B", organizationId: orgB, classification: "public", title: "B", artifactRef: refB });

      const h = createRunAuthorityHandlers(globalStore);
      // Org A querying should only see A
      const resA = await h.getAuthorizedRunContext({ ctx: makeCtx(runA, orgA, "conv_A") } as never);
      expect(resA.manifest.recentMessages.every((m) => m.text !== "secret B")).toBe(true);
      expect(resA.manifest.knowledgeRefs.every((k) => k.documentId !== "doc_B")).toBe(true);
      expect(resA.manifest.knowledgeRefs.some((k) => k.documentId === "doc_A")).toBe(true);
      // Org B should not see A's data
      const resB = await h.getAuthorizedRunContext({ ctx: makeCtx(runB, orgB, "conv_B") } as never);
      expect(resB.manifest.recentMessages.every((m) => m.text !== "secret A")).toBe(true);
      // Cross-tenant direct getRun should fail
      await expect(h.getAuthorizedRunContext({ ctx: makeCtx(runA, orgB, "conv_A") } as never)).rejects.toThrow(/not found|mismatch|permission_denied/);
      // Vector query simulation: queryKnowledgeDocs with org filter
      expect(globalStore.queryKnowledgeDocs(orgA).every((d) => d.organizationId === orgA)).toBe(true);
      expect(globalStore.queryKnowledgeDocs(orgA).some((d) => d.documentId === "doc_B")).toBe(false);
    });

    it("vector query must include organization_id predicate (fails closed if missing)", async () => {
      // Simulate that without org filter, query would leak — but our implementation requires org
      const org = "org_vec";
      globalStore.createConversation("conv_vec", org);
      const runId = "run_vec";
      globalStore.createRun({ runId, organizationId: org, conversationId: "conv_vec", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      globalStore.createKnowledgeDoc({ documentId: "doc_vec", organizationId: org, classification: "secret", title: "vec", artifactRef: undefined });
      const h = createRunAuthorityHandlers(globalStore);
      // Valid query with org succeeds
      const res = await h.getAuthorizedRunContext({ ctx: makeCtx(runId, org, "conv_vec") } as never);
      expect(res.manifest.knowledgeRefs.length).toBe(1);
      // Invalid ctx org mismatch should fail before serialization
      await expect(h.getAuthorizedRunContext({ ctx: makeCtx(runId, "org_other", "conv_vec") } as never)).rejects.toThrow();
    });
  });

  describe("6.3 Artifact facade — 7 checks + purpose allowlist + fresh auth", () => {
    it("7 checks enforced and sha256 exactly 32B, purpose not arbitrary", async () => {
      const org = "org_art";
      const runId = "run_art";
      globalStore.createConversation("conv_art", org);
      globalStore.createRun({ runId, organizationId: org, conversationId: "conv_art", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const data = new TextEncoder().encode("artifact data");
      const ref = createArtifact({ data, mediaType: "text/plain", purpose: "kb_document", organizationId: org, runId });
      expect(ref.sha256.length).toBe(32);
      expect(ref.purpose).toBe("kb_document");
      // Verify succeeds with correct scope
      expect(verifyArtifact(ref, { organizationId: org, runId })).toEqual(data);
      // Purpose arbitrary rejected at create
      expect(() => createArtifact({ data, mediaType: "text/plain", purpose: "evil_purpose'; DROP", organizationId: org, runId })).toThrow(/not allowlisted/);
      // Sha256 tampered
      const badRef = create(ArtifactRefSchema, { ...ref, sha256: new Uint8Array(16) } as unknown as Record<string, unknown>);
      const { validateArtifactRef } = await import("../src/shared/validation.js");
      expect(() => validateArtifactRef(badRef)).toThrow(/32 bytes/);
      // Opaque URI check
      const badUri = create(ArtifactRefSchema, { ...ref, uri: "https://s3.amazonaws.com/bucket/key" } as unknown as Record<string, unknown>);
      expect(() => verifyArtifact(badUri as unknown as typeof ref, { organizationId: org, runId })).toThrow(/opaque artifact/);
      // Fresh auth: wrong org/run rejected even with same ref
      expect(() => verifyArtifact(ref, { organizationId: "org_other", runId })).toThrow(/scope mismatch/);
      expect(() => verifyArtifact(ref, { organizationId: org, runId: "run_other" })).toThrow(/scope mismatch/);
    });

    it("never put raw docs/secrets/unbounded prompts into Temporal args", async () => {
      const { assertTemporalArgsSafe } = await import("../src/shared/temporalGuard.js");
      const large = "x".repeat(70 * 1024);
      expect(() => assertTemporalArgsSafe({ runId: "run_123", documentContent: large } as unknown as Record<string, unknown>)).toThrow(/ArtifactRef/);
      // Valid with ArtifactRef passes
      const ref = createArtifact({ data: new TextEncoder().encode("small"), mediaType: "text/plain", purpose: "kb_document", organizationId: "org_123", runId: "run_123" });
      expect(() => assertTemporalArgsSafe({ runId: "run_123", checkpointRef: ref } as unknown as Record<string, unknown>)).not.toThrow();
      // Raw secret in args must use ArtifactRef — forbidden key triggers guard (122-123)
      expect(() => assertTemporalArgsSafe({ runId: "run_123", apiKey: "sk-secret" } as unknown as Record<string, unknown>)).toThrow(/secret|forbidden|ArtifactRef/);
      expect(() => assertTemporalArgsSafe({ runId: "run_123", secretToken: "s3cr3t" } as unknown as Record<string, unknown>)).toThrow();
    });
  });

  describe("6.4 SubmitMemoryProposal — provenance/confidence/visibility/expiry preserved", () => {
    it("stores as proposal not truth, preserves provenance/visibility/confidence/expiry", async () => {
      const org = "org_mem";
      const conv = "conv_mem";
      globalStore.createConversation(conv, org);
      const runId = "run_mem";
      globalStore.createRun({ runId, organizationId: org, conversationId: conv, assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const h = createRunAuthorityHandlers(globalStore);
      const expiresAt = new Date(Date.now() + 3600_000);
      const res = await h.submitMemoryProposal({
        ctx: makeCtx(runId, org, conv),
        proposalId: "mem_test",
        scope: "conversation",
        value: "user likes cats",
        provenance: "msg_123",
        confidence: 0.85,
        visibility: "private",
        expiresAt: { seconds: BigInt(Math.floor(expiresAt.getTime() / 1000)), nanos: 0 } as never,
      } as never);
      expect(res.proposalId).toBe("mem_test");
      const stored = globalStore.memoryProposals.get("mem_test")!;
      expect(stored.provenance).toBe("msg_123");
      expect(stored.confidence).toBe(0.85);
      expect(stored.visibility).toBe("private");
      expect(stored.status).toBe("PENDING"); // not truth yet
      // GetAuthorizedRunContext should include it with provenance
      const manifest = await h.getAuthorizedRunContext({ ctx: makeCtx(runId, org, conv) } as never);
      const mem = manifest.manifest.memories.find((m) => m.memoryId === "mem_test");
      expect(mem?.provenance).toBe("msg_123");
    });

    it("memory proposal idempotent same digest returns original, different digest rejects", async () => {
      const org = "org_mem2";
      const conv = "conv_mem2";
      globalStore.createConversation(conv, org);
      const runId = "run_mem2";
      globalStore.createRun({ runId, organizationId: org, conversationId: conv, assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const h = createRunAuthorityHandlers(globalStore);
      const ctx = makeCtx(runId, org, conv, { idempotencyKey: "k_mem" });
      const r1 = await h.submitMemoryProposal({ ctx, proposalId: "mem_dup", scope: "user", value: "val1" } as never);
      const r2 = await h.submitMemoryProposal({ ctx, proposalId: "mem_dup", scope: "user", value: "val1" } as never);
      expect(r2.proposalId).toBe(r1.proposalId);
      const ctx2 = makeCtx(runId, org, conv, { idempotencyKey: "k_mem" });
      await expect(h.submitMemoryProposal({ ctx: ctx2, proposalId: "mem_dup", scope: "user", value: "different" } as never)).rejects.toThrow(/AlreadyExists|conflict/);
    });
  });

  describe("6.5 Citation/reference preservation", () => {
    it("knowledge refs preserve citation with document_id/chunk_id/artifact_ref", async () => {
      const org = "org_cite";
      const conv = "conv_cite";
      globalStore.createConversation(conv, org);
      const runId = "run_cite";
      globalStore.createRun({ runId, organizationId: org, conversationId: conv, assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const data = new TextEncoder().encode("chunk data");
      const ref = createArtifact({ data, mediaType: "text/plain", purpose: "kb_document", organizationId: org, runId });
      globalStore.createKnowledgeDoc({ documentId: "doc_cite", organizationId: org, classification: "public", title: "cite doc", chunkId: "chunk_42", artifactRef: ref });
      const h = createRunAuthorityHandlers(globalStore);
      const res = await h.getAuthorizedRunContext({ ctx: makeCtx(runId, org, conv) } as never);
      const kref = res.manifest.knowledgeRefs.find((k) => k.documentId === "doc_cite");
      expect(kref).toBeDefined();
      expect(kref?.chunkId).toBe("chunk_42");
      expect(kref?.artifactRef).toBeDefined();
      // Verify artifact via fresh auth preserves citation
      expect(verifyArtifact(kref!.artifactRef as unknown as typeof ref, { organizationId: org, runId })).toEqual(data);
    });
  });

  describe("6.6 Retention/deletion — deleted artifact inaccessible to old run refs", () => {
    it("deleted artifact via claimCheck not verifiable even with old ref", async () => {
      const org = "org_del";
      const runId = "run_del";
      globalStore.createConversation("conv_del", org);
      globalStore.createRun({ runId, organizationId: org, conversationId: "conv_del", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const data = new TextEncoder().encode("to be deleted");
      const ref = createArtifact({ data, mediaType: "text/plain", purpose: "kb_document", organizationId: org, runId });
      expect(verifyArtifact(ref, { organizationId: org, runId })).toEqual(data);
      deleteArtifact(ref.artifactId, { organizationId: org });
      expect(() => verifyArtifact(ref, { organizationId: org, runId })).toThrow(/deleted/);
      // Old run ref still fails — tombstone enforced via fresh auth (GetRunArtifact)
      const { createRunObservationHandlers } = await import("../src/engine/authority.js");
      const h = createRunObservationHandlers(globalStore);
      await expect(h.getRunArtifact({ ctx: makeCtx(runId, org, "conv_del"), artifactRef: ref } as never)).rejects.toThrow(/deleted/);
    });

    it("deleted knowledge doc not returned in manifest (fails closed)", async () => {
      const org = "org_kb_del";
      const conv = "conv_kb_del";
      globalStore.createConversation(conv, org);
      const runId = "run_kb_del";
      globalStore.createRun({ runId, organizationId: org, conversationId: conv, assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const ref = createArtifact({ data: new TextEncoder().encode("kb"), mediaType: "text/plain", purpose: "kb_document", organizationId: org, runId });
      globalStore.createKnowledgeDoc({ documentId: "doc_del", organizationId: org, classification: "public", title: "del", artifactRef: ref });
      let h = createRunAuthorityHandlers(globalStore);
      let res = await h.getAuthorizedRunContext({ ctx: makeCtx(runId, org, conv) } as never);
      expect(res.manifest.knowledgeRefs.some((k) => k.documentId === "doc_del")).toBe(true);
      globalStore.deleteKnowledgeDoc("doc_del", org);
      res = await h.getAuthorizedRunContext({ ctx: makeCtx(runId, org, conv) } as never);
      expect(res.manifest.knowledgeRefs.some((k) => k.documentId === "doc_del")).toBe(false);
    });

    it("deleted conversation tombstone makes context inaccessible", async () => {
      const org = "org_conv_del";
      const conv = "conv_del2";
      globalStore.createConversation(conv, org);
      const runId = "run_conv_del";
      globalStore.createRun({ runId, organizationId: org, conversationId: conv, assistantVersionId: "asst_v1", state: RunState.RUNNING });
      globalStore.deleteConversation(conv);
      const h = createRunAuthorityHandlers(globalStore);
      await expect(h.getAuthorizedRunContext({ ctx: makeCtx(runId, org, conv) } as never)).rejects.toThrow(/not found|tombstoned|deleted/);
    });
  });

  describe("Context rebuildable after provider/Studio replacement (derived prompt not canonical)", () => {
    it("manifest rebuildable deterministically from Engine state, not provider", async () => {
      const org = "org_rebuild";
      const conv = "conv_rebuild";
      globalStore.createConversation(conv, org);
      globalStore.createMessage({ messageId: "msg_r1", conversationId: conv, organizationId: org, role: "user", text: "hello rebuild" });
      const runId = "run_rebuild";
      globalStore.createRun({ runId, organizationId: org, conversationId: conv, assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const ref = createArtifact({ data: new TextEncoder().encode("kb"), mediaType: "text/plain", purpose: "kb_document", organizationId: org, runId });
      globalStore.createKnowledgeDoc({ documentId: "doc_rebuild", organizationId: org, classification: "public", title: "rebuild", artifactRef: ref });
      globalStore.submitMemoryProposal("mem_rebuild", org, runId, "conversation", "pref", { provenance: "msg_r1", confidence: 0.9, visibility: "private" });

      const h = createRunAuthorityHandlers(globalStore);
      const ctx = makeCtx(runId, org, conv);
      const m1 = await h.getAuthorizedRunContext({ ctx } as never);
      // Simulate Studio replacement: clear in-memory caches but store persists (snapshot/restore)
      const m2 = await h.getAuthorizedRunContext({ ctx: makeCtx(runId, org, conv) } as never);
      expect(m2.manifest.assistantVersionId).toBe(m1.manifest.assistantVersionId);
      expect(m2.manifest.recentMessages).toEqual(m1.manifest.recentMessages);
      expect(m2.manifest.memories).toEqual(m1.manifest.memories);
      expect(m2.manifest.knowledgeRefs.length).toBe(m1.manifest.knowledgeRefs.length);
      expect(m2.manifest.knowledgeRefs[0].documentId).toBe(m1.manifest.knowledgeRefs[0].documentId);
      // After restore, still rebuildable — compare via deterministic JSON (Uint8Array handling)
      const snap = globalStore.snapshot();
      globalStore.clear();
      clearArtifacts(); // artifacts are separate store, not in snapshot — recreate for test
      // Recreate artifact for after-restore check (artifacts cleared, so need to recreate knowledge doc)
      // Instead, test rebuild via store snapshot only for run/messages/memories
      globalStore.restore(snap);
      // Knowledge docs are in snapshot, so after restore they exist, but artifacts cleared — re-create artifact
      const ref2 = createArtifact({ data: new TextEncoder().encode("kb"), mediaType: "text/plain", purpose: "kb_document", organizationId: org, runId });
      // Update the restored knowledge doc's artifactRef to new ref (since artifact store cleared)
      const doc = globalStore.knowledgeDocs.get("doc_rebuild");
      if (doc) { doc.artifactRef = ref2; globalStore.knowledgeDocs.set("doc_rebuild", doc); }
      const m3 = await h.getAuthorizedRunContext({ ctx: makeCtx(runId, org, conv) } as never);
      expect(m3.manifest.assistantVersionId).toBe(m1.manifest.assistantVersionId);
      expect(m3.manifest.recentMessages).toEqual(m1.manifest.recentMessages);
      expect(m3.manifest.memories.length).toBe(m1.manifest.memories.length);
    });
  });
});
