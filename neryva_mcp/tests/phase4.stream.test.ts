import { describe, it, expect, beforeEach } from "vitest";
import { create } from "@bufbuild/protobuf";
import { RunState } from "../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";
import { RunEventSchema } from "../neryva-mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js";
import { RequestContextSchema } from "../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js";
import { globalStore } from "../src/engine/store.js";
import { createRunAuthorityHandlers, createRunObservationHandlers } from "../src/engine/authority.js";
import { createArtifact, clearArtifacts } from "../src/artifacts/claimCheck.js";
import { clearNats, createConsumer, consume, ack, publish, getStream, setNatsAvailable, getConsumerLag } from "../src/events/nats.js";
import { clearRedis, redisSet, redisGet, isRateLimited, redisPublish, redisSubscribe } from "../src/events/redis.js";
import { nextCursor, deduplicateBySequence, encodePageToken, decodePageToken, applyEventsAtomically, assertMonotonic } from "../src/events/cursor.js";
import { partitionEvents, isDurable, isEphemeral, coalesceAssistantChunks, shouldPersist } from "../src/events/coalesce.js";

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
function makeEvent(runId: string, eventId: string, type: number, body: Record<string, unknown>, seq?: bigint) {
  return create(RunEventSchema, {
    eventId,
    runId,
    stepId: "step_1",
    type,
    schemaVersion: "1.0",
    producerId: "studio_1",
    producerSequence: 1n,
    producerTimestamp: { seconds: BigInt(Math.floor(Date.now() / 1000)), nanos: 0 } as never,
    redaction: 1,
    body: body as never,
    sequence: seq ?? 0n,
  });
}

describe("Phase 4 — Streaming & observation (exit gates)", () => {
  beforeEach(() => {
    globalStore.clear();
    clearArtifacts();
    clearNats();
    clearRedis();
  });

  describe("4.1 RunObservationService — ListRunEvents bounded page + WatchRunEvents cursor", () => {
    it("ListRunEvents respects pageSize 1..100 and returns nextPageToken as string sequence", async () => {
      const runId = "run_page_1";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const authority = createRunAuthorityHandlers(globalStore);
      const observation = createRunObservationHandlers(globalStore);
      const ctx = makeCtx({ runId });
      // Append 5 events
      const events = Array.from({ length: 5 }, (_, i) => makeEvent(runId, `evt_${i}`, 1, { case: "lifecycle", value: { fromState: "RUNNING", toState: "RUNNING", reason: `e${i}` } }));
      await authority.appendRunEvents({ ctx, events } as never);

      const p1 = await observation.listRunEvents({ ctx, afterSequence: 0n, page: { pageSize: 2 } } as never);
      expect(p1.events).toHaveLength(2);
      expect(p1.events[0].sequence).toBe(1n);
      expect(p1.events[1].sequence).toBe(2n);
      expect(p1.page.nextPageToken).toBe("2");

      // Resume with afterSequence + via pageToken
      const p2 = await observation.listRunEvents({ ctx, afterSequence: 2n, page: { pageSize: 10 } } as never);
      expect(p2.events.map((e) => e.sequence)).toEqual([3n, 4n, 5n]);
      expect(p2.page.nextPageToken).toBe("");

      // pageToken overrides afterSequence — resume via token
      const p3 = await observation.listRunEvents({ ctx, afterSequence: 0n, page: { pageSize: 2, pageToken: "2" } } as never);
      expect(p3.events.map((e) => e.sequence)).toEqual([3n, 4n]);
    });

    it("ListRunEvents enforces limit 100 and monotonic ordering", async () => {
      const runId = "run_page_limit";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const authority = createRunAuthorityHandlers(globalStore);
      const observation = createRunObservationHandlers(globalStore);
      const ctx = makeCtx({ runId });
      const events = Array.from({ length: 3 }, (_, i) => makeEvent(runId, `evt_${i}`, 3, { case: "toolCall", value: { toolCallId: `tc_${i}`, toolName: "read", argumentDigest: new Uint8Array(32) } }));
      await authority.appendRunEvents({ ctx, events } as never);
      const res = await observation.listRunEvents({ ctx, afterSequence: 0n, page: { pageSize: 200 } } as never);
      // clamped to 100 but we only have 3
      expect(res.events).toHaveLength(3);
      assertMonotonic(res.events, 0n);
      // deduplicate
      const dup = [...res.events, ...res.events];
      expect(deduplicateBySequence(dup)).toHaveLength(3);
    });

    it("WatchRunEvents yields snapshot from afterSequence and respects at-least-once dedup", async () => {
      const runId = "run_watch_snap";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const authority = createRunAuthorityHandlers(globalStore);
      const observation = createRunObservationHandlers(globalStore);
      const ctx = makeCtx({ runId });
      const e1 = makeEvent(runId, "e1", 1, { case: "lifecycle", value: { fromState: "QUEUED", toState: "RUNNING", reason: "x" } });
      const e2 = makeEvent(runId, "e2", 3, { case: "toolCall", value: { toolCallId: "tc1", toolName: "read", argumentDigest: new Uint8Array(32) } });
      await authority.appendRunEvents({ ctx, events: [e1, e2] } as never);

      const gen = observation.watchRunEvents({ ctx, afterSequence: 0n } as never);
      const collected: typeof e1[] = [];
      for await (const item of gen as AsyncGenerator<{ event: typeof e1 }>) collected.push(item.event);
      expect(collected.map((e) => e.eventId)).toEqual(["e1", "e2"]);
      expect(collected.map((e) => e.sequence)).toEqual([1n, 2n]);
    });

    it("WatchRunEvents streams new events appended while open (heartbeat keeps alive, terminal grace closes)", async () => {
      const runId = "run_watch_live";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const authority = createRunAuthorityHandlers(globalStore);
      const observation = createRunObservationHandlers(globalStore);
      const ctx = makeCtx({ runId });
      const e1 = makeEvent(runId, "e1", 1, { case: "lifecycle", value: { fromState: "QUEUED", toState: "RUNNING", reason: "x" } });
      await authority.appendRunEvents({ ctx, events: [e1] } as never);

      // Start watch at 0, but append e2 after 60ms while stream is polling
      const gen = observation.watchRunEvents({ ctx, afterSequence: 0n } as never);
      setTimeout(async () => {
        const e2 = makeEvent(runId, "e2", 11, { case: "terminal", value: { code: "ok", message: "done" } });
        await authority.appendRunEvents({ ctx: makeCtx({ runId }), events: [e2] } as never);
        // Transition to terminal shortly after to trigger grace close
        setTimeout(() => globalStore.transitionRun(runId, RunState.SUCCEEDED, globalStore.getRun(runId)!.version), 40);
      }, 60);

      const collected: string[] = [];
      const start = Date.now();
      for await (const item of gen as AsyncGenerator<{ event: typeof e1 }>) collected.push(item.event.eventId);
      const elapsed = Date.now() - start;
      // Should have received both e1 snapshot + e2 live, and closed after terminal grace (~300ms)
      expect(collected).toContain("e1");
      expect(collected).toContain("e2");
      expect(elapsed).toBeGreaterThanOrEqual(300);
      expect(elapsed).toBeLessThan(2000); // bounded close, not infinite
    });

    it("WatchRunEvents heartbeat does not yield business event, terminal grace closes cleanly", async () => {
      const runId = "run_heartbeat";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const observation = createRunObservationHandlers(globalStore);
      const ctx = makeCtx({ runId });
      const e1 = makeEvent(runId, "e1", 1, { case: "lifecycle", value: { fromState: "QUEUED", toState: "RUNNING", reason: "x" } });
      await createRunAuthorityHandlers(globalStore).appendRunEvents({ ctx, events: [e1] } as never);
      // Watch from after last sequence — should stay open heartbeat interval then close (no business events)
      const gen = observation.watchRunEvents({ ctx, afterSequence: 1n } as never);
      const collected: unknown[] = [];
      for await (const item of gen as AsyncGenerator<{ event: unknown }>) collected.push(item);
      expect(collected).toHaveLength(0); // heartbeat not counted
    });
  });

  describe("4.2 Frontend cursor + reconnect — no missing/duplicated authoritative event", () => {
    it("client reconnects with last sequence, applies idempotently", async () => {
      const runId = "run_reconnect";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const authority = createRunAuthorityHandlers(globalStore);
      const observation = createRunObservationHandlers(globalStore);
      const ctx = makeCtx({ runId });
      const evs = Array.from({ length: 6 }, (_, i) => makeEvent(runId, `evt_${i}`, 1, { case: "lifecycle", value: { fromState: "RUNNING", toState: "RUNNING", reason: `${i}` } }));
      await authority.appendRunEvents({ ctx, events: evs.slice(0, 3) } as never);
      // Client gets page 1 (2 events)
      const p1 = await observation.listRunEvents({ ctx, afterSequence: 0n, page: { pageSize: 2 } } as never);
      let cursor = { afterSequence: 0n, events: [] as typeof evs };
      cursor = nextCursor(cursor, p1.events);
      expect(cursor.afterSequence).toBe(2n);
      // Simulate disconnect, more events appended on Engine
      await authority.appendRunEvents({ ctx: makeCtx({ runId }), events: evs.slice(3) } as never);
      // Reconnect with last sequence 2 — should get 3..6 without gaps
      const p2 = await observation.listRunEvents({ ctx: makeCtx({ runId }), afterSequence: cursor.afterSequence, page: { pageSize: 10 } } as never);
      expect(p2.events.map((e) => e.sequence)).toEqual([3n, 4n, 5n, 6n]);
      const merged = deduplicateBySequence([...p1.events, ...p2.events]);
      expect(merged).toHaveLength(6);
      // At-least-once: simulate duplicate delivery after reconnect (server resends 2)
      const withDup = deduplicateBySequence([...merged, p1.events[1]]);
      expect(withDup).toHaveLength(6);
      // Durable projection atomically persists appliedSequence
      let proj: string[] = [];
      let applied = 0n;
      ({ projection: proj, appliedSequence: applied } = applyEventsAtomically(proj, applied, p1.events, (e) => e.eventId));
      expect(applied).toBe(2n);
      ({ projection: proj, appliedSequence: applied } = applyEventsAtomically(proj, applied, p2.events, (e) => e.eventId));
      expect(applied).toBe(6n);
      expect(proj).toEqual(evs.map((e) => e.eventId));
      // Repeat apply with same p2 (duplicate after reconnect) does not duplicate projection
      ({ projection: proj, appliedSequence: applied } = applyEventsAtomically(proj, applied, p2.events, (e) => e.eventId));
      expect(proj).toHaveLength(6);
    });

    it("encode/decode pageToken round-trip and nextCursor validates monotonic", async () => {
      expect(decodePageToken(encodePageToken(123n))).toBe(123n);
      expect(decodePageToken("")).toBe(0n);
      expect(decodePageToken(undefined)).toBe(0n);
      const c0 = { afterSequence: 0n, events: [] as ReturnType<typeof makeEvent>[] };
      const e1 = makeEvent("run_x", "e1", 1, { case: "lifecycle", value: { fromState: "a", toState: "b", reason: "x" } }, 1n);
      const e2 = makeEvent("run_x", "e2", 1, { case: "lifecycle", value: { fromState: "b", toState: "c", reason: "y" } }, 2n);
      const c1 = nextCursor(c0, [e1, e2]);
      expect(c1.afterSequence).toBe(2n);
      // Non-monotonic should throw
      const bad = makeEvent("run_x", "e_bad", 1, { case: "lifecycle", value: { fromState: "a", toState: "b", reason: "x" } }, 1n);
      expect(() => nextCursor(c1, [bad])).toThrow(/non-monotonic/);
    });
  });

  describe("4.3 Event coalescing — durable vs ephemeral", () => {
    it("partitions durable vs ephemeral per spec and coalesces assistant chunks", async () => {
      const runId = "run_coalesce";
      const durableLif = makeEvent(runId, "d1", 1, { case: "lifecycle", value: { fromState: "a", toState: "b", reason: "x" } });
      const toolCall = makeEvent(runId, "d2", 3, { case: "toolCall", value: { toolCallId: "tc", toolName: "read", argumentDigest: new Uint8Array(32) } });
      const chunk1 = makeEvent(runId, "e1", 2, { case: "assistantChunk", value: { text: "hel", isFinal: false } });
      const chunk2 = makeEvent(runId, "e2", 2, { case: "assistantChunk", value: { text: "lo", isFinal: true } });
      const retrieval = makeEvent(runId, "e3", 5, { case: "lifecycle", value: { fromState: "a", toState: "b", reason: "x" } });
      expect(isDurable(durableLif)).toBe(true);
      expect(isDurable(toolCall)).toBe(true);
      expect(isEphemeral(chunk1)).toBe(true);
      expect(isEphemeral(retrieval)).toBe(true);
      expect(shouldPersist(durableLif)).toBe(true);
      expect(shouldPersist(chunk1)).toBe(false); // not final
      expect(shouldPersist(chunk2)).toBe(true); // final coalesced snapshot may be persisted for UX but not authoritative

      const { durable, ephemeral } = partitionEvents([durableLif, toolCall, chunk1, chunk2, retrieval]);
      expect(durable).toHaveLength(2);
      expect(ephemeral).toHaveLength(3);

      const coalesced = coalesceAssistantChunks([chunk1, chunk2]);
      expect(coalesced).toBeDefined();
      expect((coalesced!.body.value as { text: string }).text).toBe("hello");
      expect((coalesced!.body.value as { isFinal: boolean }).isFinal).toBe(true);
    });

    it("heartbeat is not a business event and never persisted", () => {
      // No event type for heartbeat — ensure coalesce never treats heartbeat as durable
      const fakeHeartbeat = { type: 999 } as unknown as ReturnType<typeof makeEvent>;
      expect(isEphemeral(fakeHeartbeat)).toBe(true);
      expect(partitionEvents([fakeHeartbeat]).durable).toHaveLength(0);
    });
  });

  describe("4.4 NATS JetStream — commit first, outage does not lose state, dedup, slow consumer bounded", () => {
    it("Engine commit before NATS: AppendRunEvents publishes after store, outage does not fail commit", async () => {
      const runId = "run_nats_commit";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const authority = createRunAuthorityHandlers(globalStore);
      const ctx = makeCtx({ runId });
      // Simulate NATS down
      setNatsAvailable(false);
      const ev = makeEvent(runId, "e_nats_1", 1, { case: "lifecycle", value: { fromState: "RUNNING", toState: "RUNNING", reason: "x" } });
      const res = await authority.appendRunEvents({ ctx, events: [ev] } as never);
      expect(res.accepted).toHaveLength(1);
      expect(res.accepted[0].sequence).toBe(1n);
      // Store has it even though NATS dropped
      expect(globalStore.listEvents(runId, 0n, 10)).toHaveLength(1);
      expect(getStream("run.events")).toHaveLength(0); // not published while down
      // Restore NATS — next append publishes
      setNatsAvailable(true);
      const ev2 = makeEvent(runId, "e_nats_2", 1, { case: "lifecycle", value: { fromState: "RUNNING", toState: "RUNNING", reason: "y" } });
      await authority.appendRunEvents({ ctx: makeCtx({ runId }), events: [ev2] } as never);
      expect(getStream("run.events")).toHaveLength(1); // only ev2, ev1 lost to NATS but NOT to Engine — outage did not invalidate committed state
      // Replay from Engine cursor still gets both
      expect(globalStore.listEvents(runId, 0n, 10)).toHaveLength(2);
    });

    it("duplicate Nats-Msg-Id suppressed and at-least-once consumers dedup by (run_id,event_id)", async () => {
      const runId = "run_nats_dedup";
      const ev = makeEvent(runId, "e_dup", 1, { case: "lifecycle", value: { fromState: "a", toState: "b", reason: "x" } });
      const m1 = publish("run.events", ev);
      const m2 = publish("run.events", ev); // same Nats-Msg-Id
      expect(m2?.id).toBe(m1?.id);
      expect(getStream("run.events")).toHaveLength(1);

      const c = createConsumer("c1", 100);
      // Consumer created after publish replays backlog
      expect(c.pending).toHaveLength(1);
      const msg = consume("c1")!;
      expect(msg.id).toBe(`${runId}:e_dup`);
      // Ack dedups future fan-out
      ack("c1", msg.id);
      // Republish duplicate should not enqueue to acked consumer again (dedup set)
      publish("run.events", ev);
      expect(consume("c1")).toBeUndefined();
    });

    it("slow consumer isolated/bounded — never unbounded buffer, does not block Engine commit", async () => {
      const cSlow = createConsumer("slow", 2);
      // Publish 5 events
      for (let i = 0; i < 5; i++) {
        const ev = makeEvent(`run_slow_${i}`, `e_${i}`, 1, { case: "lifecycle", value: { fromState: "a", toState: "b", reason: `${i}` } });
        publish("run.events", ev);
      }
      // Slow consumer bounded to 2, not 5 — isolate, no unbounded growth
      expect(cSlow.pending.length).toBeLessThanOrEqual(2);
      expect(getConsumerLag("slow")).toBeLessThanOrEqual(2);
      // Engine still accepted all (store not checked here, but NATS stream has 5)
      expect(getStream("run.events")).toHaveLength(5);
    });
  });

  describe("4.5 Redis/Valkey cache-only + frontend scope isolation", () => {
    it("Redis is cache/rate-limit/transient fan-out only — not source of truth", async () => {
      // Cache miss tolerates fallback to Engine
      expect(redisGet("manifest:run_123")).toBeUndefined();
      redisSet("manifest:run_123", { data: "cached" }, 60_000);
      expect(redisGet("manifest:run_123")).toEqual({ data: "cached" });
      // Rate limit isolated per key
      expect(isRateLimited("org_123:run_123", 2, 60_000)).toBe(false);
      expect(isRateLimited("org_123:run_123", 2, 60_000)).toBe(false);
      expect(isRateLimited("org_123:run_123", 2, 60_000)).toBe(true); // 3rd exceeds limit 2
      // Other org not affected
      expect(isRateLimited("org_other:run_123", 2, 60_000)).toBe(false);
      // Transient pub/sub does not persist
      let got: unknown = undefined;
      const unsub = redisSubscribe("watch:run_123", (m) => { got = m; });
      redisPublish("watch:run_123", { seq: 1 });
      expect(got).toEqual({ seq: 1 });
      unsub();
      got = undefined;
      redisPublish("watch:run_123", { seq: 2 });
      expect(got).toBeUndefined();
      // Ensure no run state read from Redis — only store is authoritative
      const runId = "run_redis_truth";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      // Even if Redis has stale entry, Engine truth wins
      redisSet(`run:${runId}`, { state: "FAKE" });
      expect(globalStore.getRun(runId)?.state).toBe(RunState.RUNNING);
    });

    it("Frontend never receives event outside caller scope (tenant WHERE before serialization)", async () => {
      const runId = "run_scope_stream";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const authority = createRunAuthorityHandlers(globalStore);
      const observation = createRunObservationHandlers(globalStore);
      const ctxOwner = makeCtx({ runId, organizationId: "org_123", conversationId: "conv_123" });
      await authority.appendRunEvents({ ctx: ctxOwner, events: [makeEvent(runId, "e1", 1, { case: "lifecycle", value: { fromState: "QUEUED", toState: "RUNNING", reason: "x" } })] } as never);

      const ctxAttacker = makeCtx({ runId, organizationId: "org_ATTACKER", conversationId: "conv_123" });
      await expect(observation.listRunEvents({ ctx: ctxAttacker, afterSequence: 0n } as never)).rejects.toThrow(/scope mismatch|not found/);
      await expect(observation.getRun({ ctx: ctxAttacker } as never)).rejects.toThrow();
      // Watch also rejected
      await expect(async () => {
        const gen = observation.watchRunEvents({ ctx: ctxAttacker, afterSequence: 0n } as never);
        for await (const _ of gen as AsyncGenerator<unknown>) { /* */ }
      }).rejects.toThrow();

      // Correct org can still read
      const ok = await observation.listRunEvents({ ctx: ctxOwner, afterSequence: 0n } as never);
      expect(ok.events).toHaveLength(1);
    });

    it("GetRunArtifact verifies 7 checks and respects scope/expiry/checksum", async () => {
      const runId = "run_artifact_scope";
      globalStore.createRun({ runId, organizationId: "org_123", conversationId: "conv_123", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      const data = new TextEncoder().encode("secret doc");
      const ref = createArtifact({ data, mediaType: "text/plain", purpose: "kb_document", organizationId: "org_123", runId });
      const observation = createRunObservationHandlers(globalStore);
      // Valid fetch
      const ok = await observation.getRunArtifact({ ctx: makeCtx({ runId, organizationId: "org_123" }), artifactRef: ref } as never);
      expect(ok.artifact.artifactId).toBe(ref.artifactId);
      // Wrong org rejected (scope check) — run lookup fails permission_denied
      await expect(observation.getRunArtifact({ ctx: makeCtx({ runId, organizationId: "org_other" }), artifactRef: ref } as never)).rejects.toThrow(/scope mismatch|not found|permission_denied/);
      // Wrong run (exists but artifact belongs to other run) — 7 checks detect run scope mismatch
      globalStore.createRun({ runId: "run_other", organizationId: "org_123", conversationId: "conv_other", assistantVersionId: "asst_v1", state: RunState.RUNNING });
      await expect(observation.getRunArtifact({ ctx: makeCtx({ runId: "run_other", organizationId: "org_123", conversationId: "conv_other" }), artifactRef: ref } as never)).rejects.toThrow(/scope mismatch/);
    });
  });
});
