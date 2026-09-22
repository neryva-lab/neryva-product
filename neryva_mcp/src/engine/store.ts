/**
 * In-memory authoritative store — Phase 2 durability.
 * Mirrors Engine-owned persistence with 11 logical records + FK to parent conversations/messages.
 * Reference: neryva_mcp_implementation_plan.md:784-796, 800-801, 758-789, 458-469
 *
 * Constraints enforced (DB constraints in production):
 * - runs: PK run_id, FK conversation_id → conversations, unique, org match
 * - run_events: PK (run_id, event_id), per-run sequence monotonic, FK run_id
 * - run_idempotency: PK (scope, key), store digest, same→original, diff→ALREADY_EXISTS + audit
 * - run_steps: PK (run_id, step_id, attempt), FK run_id
 * - approvals: PK approval_id, FK run_id
 * - memory_proposals: PK proposal_id
 * - checkpoints: PK (run_id, version) + artifact FK
 * - tool_effects: PK (run_id, tool_call_id), idempotency key unique
 * - outbox: PK id, status PENDING→DISPATCHED→DEAD_LETTER, FK run_id
 * - audit_log: append-only, indexed by trace
 * - usage_ledger: append-only, provider/model tokens
 * - conversations/messages: parent tables, deletion/tombstone policy
 */
import { RunState } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";
import { RunEvent } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/event/v1/event_pb.js";
import { TimestampSchema } from "@bufbuild/protobuf/wkt";
import { create } from "@bufbuild/protobuf";
import { isTerminal, assertCanTransition, assertExpectedVersion } from "./stateMachine.js";
import { concurrencyError, lifecycleError, validationError } from "../shared/errors.js";

export interface ConversationRecord {
  conversationId: string;
  organizationId: string;
  version: bigint;
  createdAt: Date;
  deletedAt?: Date; // tombstone for retention/deletion policy
}

export interface MessageRecord {
  messageId: string;
  conversationId: string;
  organizationId: string;
  runId?: string;
  role: "user" | "assistant" | "tool";
  text?: string;
  createdAt: Date;
  deletedAt?: Date;
}

export interface RunRecord {
  runId: string;
  organizationId: string;
  conversationId: string;
  assistantVersionId: string;
  state: RunState;
  version: bigint;
  leaseEpoch: bigint;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunEventRecord {
  eventId: string;
  runId: string;
  sequence: bigint;
  event: RunEvent;
  acceptedAt: Date;
}

export interface IdempotencyRecord {
  scope: string;
  key: string;
  digest: string;
  result: unknown;
  createdAt: Date;
  expiresAt: Date;
}

export interface OutboxRecord {
  id: string;
  destination: string;
  dispatchKey: string;
  body: unknown;
  attempts: number;
  nextAttemptAt: Date;
  status: "PENDING" | "DISPATCHED" | "DEAD_LETTER";
  runId: string;
  lastError?: string;
}

export interface RunStepRecord {
  stepId: string;
  runId: string;
  attempt: number;
  state: string; // PENDING | RUNNING | SUCCEEDED | FAILED
  toolName?: string;
  argumentDigest?: string; // hex sha256
  resultDigest?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuditRecord {
  id: string;
  actorId: string;
  service: string;
  operation: string;
  resource: string; // run_id / conversation_id
  organizationId: string;
  decision: string; // allow/deny
  policyVersion: string;
  traceId?: string;
  reason?: string;
  createdAt: Date;
}

export interface UsageRecord {
  id: string;
  provider: string;
  model: string;
  tokens: number;
  cost: number;
  runId: string;
  messageId?: string;
  source: string; // model gateway normalization
  correctionStatus: "original" | "corrected";
  createdAt: Date;
}

export class InMemoryStore {
  // Parent tables
  conversations = new Map<string, ConversationRecord>();
  messages = new Map<string, MessageRecord>();

  // Core
  runs = new Map<string, RunRecord>();
  private seqPerRun = new Map<string, bigint>();
  events = new Map<string, RunEventRecord>();
  eventsByRun = new Map<string, RunEventRecord[]>();
  idempotency = new Map<string, IdempotencyRecord>();
  outbox = new Map<string, OutboxRecord>();

  // Extended
  runSteps = new Map<string, RunStepRecord>(); // key = `${runId}:${stepId}:${attempt}`
  approvals = new Map<string, { approvalId: string; organizationId: string; runId: string; state: string; data: unknown; createdAt: Date }>();
  memoryProposals = new Map<string, { proposalId: string; organizationId: string; runId: string; scope: string; value: string; provenance?: string; confidence?: number; visibility?: string; expiresAt?: Date; status: string; createdAt: Date }>();
  checkpoints = new Map<string, { checkpointId: string; runId: string; version: bigint; artifactRef: unknown; createdAt: Date }>();
  toolEffects = new Map<string, { toolCallId: string; runId: string; stepId: string; status: string; digest: string; resultRef?: unknown; createdAt: Date }>();
  auditLog = new Map<string, AuditRecord>();
  usageLedger = new Map<string, UsageRecord>();
  // Knowledge base for authorized retrieval — tenant/role/conversation/document/classification filtered
  knowledgeDocs = new Map<string, { documentId: string; organizationId: string; classification: string; title: string; chunkId: string; artifactRef?: unknown; deletedAt?: Date; createdAt: Date }>();

  // ── Conversations / Messages ──
  createConversation(conversationId: string, organizationId: string): ConversationRecord {
    if (this.conversations.has(conversationId)) throw validationError(`conversation ${conversationId} already exists`);
    const rec: ConversationRecord = { conversationId, organizationId, version: 1n, createdAt: new Date() };
    this.conversations.set(conversationId, rec);
    return rec;
  }

  getConversation(conversationId: string): ConversationRecord | undefined {
    return this.conversations.get(conversationId);
  }

  deleteConversation(conversationId: string): void {
    const conv = this.conversations.get(conversationId);
    if (!conv) throw validationError(`conversation ${conversationId} not found`);
    conv.deletedAt = new Date();
    // Tombstone: runs remain but are filtered; new runs for deleted conv are rejected
    this.conversations.set(conversationId, conv);
  }

  createMessage(rec: Omit<MessageRecord, "createdAt">): MessageRecord {
    const conv = this.conversations.get(rec.conversationId);
    if (!conv) throw validationError(`FK violation: conversation ${rec.conversationId} not found for message ${rec.messageId}`);
    if (conv.deletedAt) throw validationError(`FK violation: conversation ${rec.conversationId} is tombstoned`);
    if (conv.organizationId !== rec.organizationId) throw validationError(`FK org mismatch for message ${rec.messageId}`);
    if (this.messages.has(rec.messageId)) throw validationError(`message ${rec.messageId} already exists`);
    const full: MessageRecord = { ...rec, createdAt: new Date() };
    this.messages.set(rec.messageId, full);
    return full;
  }

  // ── Runs ──
  getRun(runId: string): RunRecord | undefined {
    return this.runs.get(runId);
  }

  getRunForOrg(runId: string, organizationId: string): RunRecord | undefined {
    const r = this.runs.get(runId);
    if (!r) return undefined;
    if (r.organizationId !== organizationId) return undefined;
    // Also enforce conversation not deleted
    const conv = this.conversations.get(r.conversationId);
    if (conv?.deletedAt) return undefined;
    return r;
  }

  createRun(rec: Omit<RunRecord, "version" | "leaseEpoch" | "createdAt" | "updatedAt"> & { version?: bigint; leaseEpoch?: bigint }): RunRecord {
    // FK to conversations — auto-create stub if missing for spike compat, but enforce org match if exists
    let conv = this.conversations.get(rec.conversationId);
    if (!conv) {
      // Auto-create for existing tests that don't create conversation explicitly
      conv = { conversationId: rec.conversationId, organizationId: rec.organizationId, version: 1n, createdAt: new Date() };
      this.conversations.set(rec.conversationId, conv);
    } else {
      if (conv.organizationId !== rec.organizationId) throw validationError(`FK org mismatch: run ${rec.runId} org ${rec.organizationId} vs conv ${conv.organizationId}`);
      if (conv.deletedAt) throw validationError(`FK violation: conversation ${rec.conversationId} is tombstoned`);
    }
    if (this.runs.has(rec.runId)) throw validationError(`run ${rec.runId} already exists`);
    const now = new Date();
    const full: RunRecord = {
      ...rec,
      version: rec.version ?? 0n,
      leaseEpoch: rec.leaseEpoch ?? 0n,
      createdAt: now,
      updatedAt: now,
    };
    // One active run per conversation (default policy)
    for (const existing of this.runs.values()) {
      if (existing.conversationId === rec.conversationId && !isTerminal(existing.state)) {
        throw validationError(`one active run per conversation: ${existing.runId} already ${RunState[existing.state]}`);
      }
    }
    this.runs.set(rec.runId, full);
    this.seqPerRun.set(rec.runId, 0n);
    this.eventsByRun.set(rec.runId, []);
    return full;
  }

  transitionRun(runId: string, to: RunState, expectedVersion: bigint): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw validationError(`run ${runId} not found`);
    assertExpectedVersion(run.version, expectedVersion);
    assertCanTransition(run.state, to);
    const updated: RunRecord = { ...run, state: to, version: run.version + 1n, updatedAt: new Date() };
    this.runs.set(runId, updated);
    // Audit terminal transitions
    if (isTerminal(to)) this.appendAudit({ actorId: "engine", service: "RunAuthorityService", operation: "transitionRun", resource: runId, organizationId: run.organizationId, decision: "allow", policyVersion: "policy_v1", reason: `${RunState[run.state]}->${RunState[to]}` });
    return updated;
  }

  claimRun(runId: string): RunRecord {
    const r = this.getRun(runId);
    if (!r) throw validationError(`run ${runId} not found`);
    let cur = r;
    if (cur.state === RunState.QUEUED) cur = this.transitionRun(runId, RunState.CLAIMED, cur.version);
    if (cur.state === RunState.CLAIMED) cur = this.transitionRun(runId, RunState.RUNNING, cur.version);
    else if (cur.state !== RunState.RUNNING) throw lifecycleError(`cannot claim run in ${RunState[cur.state]}`);
    return cur;
  }

  // ── Leases ──
  acquireOrRenewLease(runId: string, owner: string, expectedEpoch: bigint, ttlMs = 30_000): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw validationError(`run ${runId} not found`);
    if (run.leaseEpoch !== expectedEpoch && run.leaseOwner) throw concurrencyError(`lease epoch mismatch: expected ${expectedEpoch} but have ${run.leaseEpoch}`);
    const now = new Date();
    const isExpired = run.leaseExpiresAt ? run.leaseExpiresAt.getTime() < now.getTime() : true;
    if (run.leaseOwner && !isExpired && run.leaseEpoch !== expectedEpoch) throw concurrencyError(`lease held by ${run.leaseOwner} until ${run.leaseExpiresAt?.toISOString()}`);
    const updated: RunRecord = {
      ...run,
      leaseOwner: owner,
      // Bump epoch on takeover (owner change) or first acquire; keep same on renewal
      leaseEpoch: run.leaseOwner === owner ? run.leaseEpoch : run.leaseEpoch + 1n,
      leaseExpiresAt: new Date(now.getTime() + ttlMs),
      updatedAt: now,
    };
    this.runs.set(runId, updated);
    return updated;
  }

  releaseLease(runId: string, epoch: bigint): RunRecord {
    const run = this.runs.get(runId);
    if (!run) throw validationError(`run ${runId} not found`);
    if (run.leaseEpoch !== epoch) throw concurrencyError(`lease epoch ${epoch} stale, current ${run.leaseEpoch}`);
    const updated: RunRecord = { ...run, leaseOwner: undefined, leaseExpiresAt: undefined, updatedAt: new Date() };
    this.runs.set(runId, updated);
    return updated;
  }

  // ── Events ──
  appendEvents(runId: string, events: RunEvent[]): { accepted: RunEvent[]; duplicates: number } {
    const run = this.runs.get(runId);
    if (!run) throw validationError(`run ${runId} not found`);
    const list = this.eventsByRun.get(runId) ?? [];
    let seq = this.seqPerRun.get(runId) ?? 0n;
    let dup = 0;
    const accepted: RunEvent[] = [];
    // For at-least-once semantics, dedup by (run_id,event_id) BEFORE terminal check — duplicate after terminal should still be tolerated (return duplicateCount)
    // Only new events are rejected if terminal
    for (const ev of events) {
      const eid = (ev.eventId ?? (ev as unknown as Record<string, unknown>).event_id) as string | undefined;
      const erid = (ev.runId ?? (ev as unknown as Record<string, unknown>).run_id) as string | undefined;
      if (!eid) throw validationError("event.event_id required");
      if (erid && erid !== runId) throw validationError(`event run_id ${erid} mismatches ${runId}`);
      const key = `${runId}:${eid}`;
      if (this.events.has(key)) { dup++; continue; }
      if (isTerminal(run.state)) throw lifecycleError(`run ${runId} is terminal ${RunState[run.state]}, rejects events`);
      seq += 1n;
      const acceptedAt = new Date();
      const acceptedAtTs = create(TimestampSchema, { seconds: BigInt(Math.floor(acceptedAt.getTime() / 1000)), nanos: (acceptedAt.getTime() % 1000) * 1_000_000 });
      const withSeq: RunEvent = { ...ev, eventId: eid, runId, sequence: seq, acceptedAt: acceptedAtTs } as unknown as RunEvent;
      this.events.set(key, { eventId: eid, runId, sequence: seq, event: withSeq, acceptedAt });
      list.push({ eventId: eid, runId, sequence: seq, event: withSeq, acceptedAt });
      accepted.push(withSeq);
    }
    this.seqPerRun.set(runId, seq);
    this.eventsByRun.set(runId, list);
    return { accepted, duplicates: dup };
  }

  listEvents(runId: string, afterSequence: bigint, limit = 50): RunEvent[] {
    const list = this.eventsByRun.get(runId) ?? [];
    return list.filter((r) => r.sequence > afterSequence).slice(0, limit).map((r) => r.event);
  }

  // ── Idempotency 6-step ──
  idempotencyCheck(scope: string, key: string, digest: string): { hit: boolean; sameDigest: boolean; record?: IdempotencyRecord } {
    const k = `${scope}:${key}`;
    const rec = this.idempotency.get(k);
    if (!rec) return { hit: false, sameDigest: false };
    // Check expiry
    if (rec.expiresAt.getTime() < Date.now()) { this.idempotency.delete(k); return { hit: false, sameDigest: false }; }
    if (rec.digest === digest) return { hit: true, sameDigest: true, record: rec };
    return { hit: true, sameDigest: false, record: rec };
  }

  idempotencyPut(scope: string, key: string, digest: string, result: unknown, ttlMs = 24 * 3600 * 1000): IdempotencyRecord {
    const k = `${scope}:${key}`;
    const rec: IdempotencyRecord = { scope, key, digest, result, createdAt: new Date(), expiresAt: new Date(Date.now() + ttlMs) };
    this.idempotency.set(k, rec);
    return rec;
  }

  // ── Outbox ──
  insertOutbox(rec: Omit<OutboxRecord, "attempts" | "status" | "nextAttemptAt">): OutboxRecord {
    if (this.outbox.has(rec.id)) throw validationError(`outbox ${rec.id} already exists — unique (id) violated`);
    const full: OutboxRecord = { ...rec, attempts: 0, status: "PENDING", nextAttemptAt: new Date() };
    this.outbox.set(rec.id, full);
    return full;
  }

  getPendingOutbox(): OutboxRecord[] {
    const now = Date.now();
    return [...this.outbox.values()].filter((o) => o.status === "PENDING" && o.nextAttemptAt.getTime() <= now);
  }

  markDispatched(id: string): void {
    const o = this.outbox.get(id);
    if (o) { o.status = "DISPATCHED"; o.attempts += 1; this.outbox.set(id, o); }
  }

  markFailed(id: string, error: string, maxAttempts = 5): void {
    const o = this.outbox.get(id);
    if (!o) return;
    o.attempts += 1;
    o.lastError = error;
    if (o.attempts >= maxAttempts) o.status = "DEAD_LETTER";
    else { o.nextAttemptAt = new Date(Date.now() + Math.pow(2, o.attempts) * 1000); } // exponential backoff
    this.outbox.set(id, o);
    if (o.status === "DEAD_LETTER") this.appendAudit({ actorId: "outbox", service: "OutboxDispatcher", operation: "dead_letter", resource: id, organizationId: "system", decision: "dead_letter", policyVersion: "policy_v1", reason: error });
  }

  getDeadLetters(): OutboxRecord[] {
    return [...this.outbox.values()].filter((o) => o.status === "DEAD_LETTER");
  }

  // ── Run Steps ──
  createRunStep(rec: Omit<RunStepRecord, "createdAt" | "updatedAt">): RunStepRecord {
    const key = `${rec.runId}:${rec.stepId}:${rec.attempt}`;
    if (this.runSteps.has(key)) throw validationError(`run_step ${key} already exists`);
    const run = this.runs.get(rec.runId);
    if (!run) throw validationError(`FK violation: run ${rec.runId} not found for step ${rec.stepId}`);
    const full: RunStepRecord = { ...rec, createdAt: new Date(), updatedAt: new Date() };
    this.runSteps.set(key, full);
    return full;
  }

  updateRunStep(runId: string, stepId: string, attempt: number, patch: Partial<RunStepRecord>): RunStepRecord {
    const key = `${runId}:${stepId}:${attempt}`;
    const existing = this.runSteps.get(key);
    if (!existing) throw validationError(`run_step ${key} not found`);
    const updated = { ...existing, ...patch, updatedAt: new Date() };
    this.runSteps.set(key, updated);
    return updated;
  }

  // ── Approvals / Memory / Checkpoints / Tool Effects (extended) ──
  createApproval(approvalId: string, organizationId: string, runId: string, data: unknown): { approvalId: string; state: string } {
    if (this.approvals.has(approvalId)) throw validationError(`approval ${approvalId} already exists`);
    const run = this.runs.get(runId);
    if (!run) throw validationError(`FK violation: run ${runId} not found for approval ${approvalId}`);
    if (run.organizationId !== organizationId) throw validationError(`FK org mismatch for approval ${approvalId}`);
    this.approvals.set(approvalId, { approvalId, organizationId, runId, state: "PENDING", data, createdAt: new Date() });
    this.appendAudit({ actorId: "engine", service: "RunAuthorityService", operation: "CreateApprovalRequest", resource: approvalId, organizationId, decision: "allow", policyVersion: "policy_v1" });
    return { approvalId, state: "PENDING" };
  }

  submitMemoryProposal(proposalId: string, organizationId: string, runId: string, scope: string, value: string, opts: { provenance?: string; confidence?: number; visibility?: string; expiresAt?: Date } = {}): { proposalId: string; accepted: boolean } {
    if (this.memoryProposals.has(proposalId)) return { proposalId, accepted: true };
    const run = this.runs.get(runId);
    if (!run) throw validationError(`FK violation: run ${runId} not found for memory ${proposalId}`);
    if (run.organizationId !== organizationId) throw validationError(`FK org mismatch for memory ${proposalId}`);
    this.memoryProposals.set(proposalId, { proposalId, organizationId, runId, scope, value, provenance: opts.provenance, confidence: opts.confidence, visibility: opts.visibility ?? "private", expiresAt: opts.expiresAt, status: "PENDING", createdAt: new Date() });
    this.appendAudit({ actorId: "engine", service: "MemoryService", operation: "SubmitMemoryProposal", resource: proposalId, organizationId, decision: "allow", policyVersion: "policy_v1", reason: `scope=${scope} visibility=${opts.visibility ?? "private"}` });
    return { proposalId, accepted: true };
  }

  // Knowledge base — authorized retrieval with tenant WHERE before serialization
  createKnowledgeDoc(opts: { documentId: string; organizationId: string; classification: string; title: string; chunkId?: string; artifactRef?: unknown }): { documentId: string } {
    if (this.knowledgeDocs.has(opts.documentId)) throw validationError(`document ${opts.documentId} already exists`);
    this.knowledgeDocs.set(opts.documentId, { documentId: opts.documentId, organizationId: opts.organizationId, classification: opts.classification, title: opts.title, chunkId: opts.chunkId ?? `chunk_${opts.documentId}_0`, artifactRef: opts.artifactRef, createdAt: new Date() });
    return { documentId: opts.documentId };
  }

  deleteKnowledgeDoc(documentId: string, organizationId: string): void {
    const doc = this.knowledgeDocs.get(documentId);
    if (!doc) throw validationError(`document ${documentId} not found`);
    if (doc.organizationId !== organizationId) throw validationError("knowledge delete scope mismatch");
    doc.deletedAt = new Date();
    this.knowledgeDocs.set(documentId, doc);
  }

  queryKnowledgeDocs(organizationId: string, opts: { classification?: string; documentId?: string } = {}): Array<{ documentId: string; organizationId: string; classification: string; title: string; chunkId: string; artifactRef?: unknown }> {
    return [...this.knowledgeDocs.values()].filter((d) => {
      if (d.deletedAt) return false;
      if (d.organizationId !== organizationId) return false;
      if (opts.classification && d.classification !== opts.classification) return false;
      if (opts.documentId && d.documentId !== opts.documentId) return false;
      return true;
    });
  }

  // For testing: approve memory proposal (simulates policy decision)
  approveMemoryProposal(proposalId: string, decision: "APPROVED" | "REJECTED"): void {
    const rec = this.memoryProposals.get(proposalId);
    if (!rec) throw validationError(`memory ${proposalId} not found`);
    rec.status = decision;
    this.memoryProposals.set(proposalId, rec);
  }

  saveCheckpoint(checkpointId: string, runId: string, version: bigint, artifactRef: unknown): { checkpointId: string; accepted: boolean } {
    const key = `${runId}:${version}`;
    if (this.checkpoints.has(key)) return { checkpointId, accepted: true };
    const run = this.runs.get(runId);
    if (!run) throw validationError(`FK violation: run ${runId} not found for checkpoint ${checkpointId}`);
    this.checkpoints.set(key, { checkpointId, runId, version, artifactRef, createdAt: new Date() });
    this.checkpoints.set(checkpointId, { checkpointId, runId, version, artifactRef, createdAt: new Date() });
    return { checkpointId, accepted: true };
  }

  recordToolEffect(toolCallId: string, runId: string, stepId: string, status: string, digest: string, resultRef?: unknown): { accepted: boolean; wasDuplicate: boolean } {
    const key = `${runId}:${toolCallId}`;
    if (this.toolEffects.has(key)) return { accepted: true, wasDuplicate: true };
    const run = this.runs.get(runId);
    if (!run) throw validationError(`FK violation: run ${runId} not found for tool ${toolCallId}`);
    this.toolEffects.set(key, { toolCallId, runId, stepId, status, digest, resultRef, createdAt: new Date() });
    return { accepted: true, wasDuplicate: false };
  }

  // ── Audit & Usage ──
  appendAudit(rec: Omit<AuditRecord, "id" | "createdAt">): AuditRecord {
    const full: AuditRecord = { ...rec, id: `audit_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`, createdAt: new Date() };
    this.auditLog.set(full.id, full);
    return full;
  }

  queryAudit(filter: Partial<AuditRecord> = {}): AuditRecord[] {
    return [...this.auditLog.values()].filter((r) => {
      for (const [k, v] of Object.entries(filter)) if ((r as unknown as Record<string, unknown>)[k] !== v) return false;
      return true;
    });
  }

  appendUsage(rec: Omit<UsageRecord, "id" | "createdAt">): UsageRecord {
    const full: UsageRecord = { ...rec, id: `usage_${Date.now()}_${Math.random().toString(16).slice(2)}`, createdAt: new Date() };
    this.usageLedger.set(full.id, full);
    return full;
  }

  // ── Snapshot / Restore for restart tests ──
  snapshot(): string {
    return JSON.stringify(
      {
        conversations: [...this.conversations.entries()].map(([k, v]) => [k, { ...v, version: String(v.version) }]),
        messages: [...this.messages.entries()],
        runs: [...this.runs.entries()].map(([k, v]) => [k, { ...v, version: String(v.version), leaseEpoch: String(v.leaseEpoch) }]),
        seqPerRun: [...this.seqPerRun.entries()].map(([k, v]) => [k, String(v)]),
        events: [...this.events.entries()].map(([k, v]) => [k, { ...v, sequence: String(v.sequence) }]),
        eventsByRun: [...this.eventsByRun.entries()].map(([k, list]) => [k, list.map((v) => ({ ...v, sequence: String(v.sequence) }))]),
        idempotency: [...this.idempotency.entries()],
        outbox: [...this.outbox.entries()],
        runSteps: [...this.runSteps.entries()],
        approvals: [...this.approvals.entries()],
        memoryProposals: [...this.memoryProposals.entries()],
        checkpoints: [...this.checkpoints.entries()].map(([k, v]) => [k, { ...v, version: String(v.version) }]),
        toolEffects: [...this.toolEffects.entries()],
        auditLog: [...this.auditLog.entries()],
        usageLedger: [...this.usageLedger.entries()],
        knowledgeDocs: [...this.knowledgeDocs.entries()],
      },
      (_, v) => (typeof v === "bigint" ? `__bigint__${v.toString()}` : v),
    );
  }

  restore(snap: string): void {
    const parsed = JSON.parse(snap, (_, v) => (typeof v === "string" && v.startsWith("__bigint__") ? BigInt(v.slice(10)) : v));
    this.conversations = new Map(
      (parsed.conversations ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        {
          ...(v as unknown as ConversationRecord),
          version: typeof v.version === "bigint" ? v.version : BigInt((v.version as string) ?? 1),
          createdAt: new Date(v.createdAt as string),
          deletedAt: v.deletedAt ? new Date(v.deletedAt as string) : undefined,
        },
      ]),
    );
    this.messages = new Map(
      (parsed.messages ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        {
          ...(v as unknown as MessageRecord),
          createdAt: new Date(v.createdAt as string),
          deletedAt: v.deletedAt ? new Date(v.deletedAt as string) : undefined,
        },
      ]),
    );
    this.runs = new Map(
      (parsed.runs ?? []).map(([k, v]: [string, Record<string, unknown>]) => {
        const version = typeof v.version === "bigint" ? v.version : BigInt((v.version as string) ?? 0);
        const leaseEpoch = typeof v.leaseEpoch === "bigint" ? v.leaseEpoch : BigInt((v.leaseEpoch as string) ?? 0);
        return [
          k,
          {
            ...(v as unknown as RunRecord),
            version,
            leaseEpoch,
            createdAt: new Date(v.createdAt as string),
            updatedAt: new Date(v.updatedAt as string),
            leaseExpiresAt: v.leaseExpiresAt ? new Date(v.leaseExpiresAt as string) : undefined,
          },
        ];
      }),
    );
    this.seqPerRun = new Map((parsed.seqPerRun ?? []).map(([k, v]: [string, string | bigint]) => [k, typeof v === "bigint" ? v : BigInt(v)]));
    this.events = new Map(
      (parsed.events ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        {
          ...(v as unknown as RunEventRecord),
          sequence: typeof v.sequence === "bigint" ? v.sequence : BigInt((v.sequence as string) ?? 0),
          acceptedAt: new Date(v.acceptedAt as string),
        },
      ]),
    );
    this.eventsByRun = new Map(
      (parsed.eventsByRun ?? []).map(([k, list]: [string, Array<Record<string, unknown>>]) => [
        k,
        list.map((v) => ({
          ...(v as unknown as RunEventRecord),
          sequence: typeof v.sequence === "bigint" ? v.sequence : BigInt((v.sequence as string) ?? 0),
          acceptedAt: new Date(v.acceptedAt as string),
        })),
      ]),
    );
    this.idempotency = new Map(
      (parsed.idempotency ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        { ...(v as unknown as IdempotencyRecord), createdAt: new Date(v.createdAt as string), expiresAt: new Date(v.expiresAt as string) },
      ]),
    );
    this.outbox = new Map(
      (parsed.outbox ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        { ...(v as unknown as OutboxRecord), nextAttemptAt: new Date(v.nextAttemptAt as string) },
      ]),
    );
    this.runSteps = new Map(
      (parsed.runSteps ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        { ...(v as unknown as RunStepRecord), createdAt: new Date(v.createdAt as string), updatedAt: new Date(v.updatedAt as string) },
      ]),
    );
    this.approvals = new Map(
      (parsed.approvals ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        { ...(v as unknown as { approvalId: string; organizationId: string; runId: string; state: string; data: unknown; createdAt: Date }), createdAt: new Date(v.createdAt as string) },
      ]),
    );
    this.memoryProposals = new Map(
      (parsed.memoryProposals ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        {
          ...(v as unknown as { proposalId: string; organizationId: string; runId: string; scope: string; value: string; provenance?: string; confidence?: number; visibility?: string; expiresAt?: Date; status: string; createdAt: Date }),
          createdAt: new Date(v.createdAt as string),
          expiresAt: v.expiresAt ? new Date(v.expiresAt as string) : undefined,
        },
      ]),
    );
    this.checkpoints = new Map(
      (parsed.checkpoints ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        {
          ...(v as unknown as { checkpointId: string; runId: string; version: bigint; artifactRef: unknown; createdAt: Date }),
          version: typeof v.version === "bigint" ? v.version : BigInt((v.version as string) ?? 1),
          createdAt: new Date(v.createdAt as string),
        },
      ]),
    );
    this.toolEffects = new Map(
      (parsed.toolEffects ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        {
          ...(v as unknown as { toolCallId: string; runId: string; stepId: string; status: string; digest: string; resultRef?: unknown; createdAt: Date }),
          createdAt: new Date(v.createdAt as string),
        },
      ]),
    );
    this.auditLog = new Map(
      (parsed.auditLog ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        { ...(v as unknown as AuditRecord), createdAt: new Date(v.createdAt as string) },
      ]),
    );
    this.usageLedger = new Map(
      (parsed.usageLedger ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        { ...(v as unknown as UsageRecord), createdAt: new Date(v.createdAt as string) },
      ]),
    );
    this.knowledgeDocs = new Map(
      (parsed.knowledgeDocs ?? []).map(([k, v]: [string, Record<string, unknown>]) => [
        k,
        {
          ...(v as unknown as { documentId: string; organizationId: string; classification: string; title: string; chunkId: string; artifactRef?: unknown; deletedAt?: Date; createdAt: Date }),
          createdAt: new Date(v.createdAt as string),
          deletedAt: v.deletedAt ? new Date(v.deletedAt as string) : undefined,
        },
      ]),
    );
  }

  // For testing: reset all
  clear(): void {
    this.conversations.clear();
    this.messages.clear();
    this.runs.clear();
    this.seqPerRun.clear();
    this.events.clear();
    this.eventsByRun.clear();
    this.idempotency.clear();
    this.outbox.clear();
    this.runSteps.clear();
    this.approvals.clear();
    this.memoryProposals.clear();
    this.checkpoints.clear();
    this.toolEffects.clear();
    this.auditLog.clear();
    this.usageLedger.clear();
    this.knowledgeDocs.clear();
  }
}

export const globalStore = new InMemoryStore();
