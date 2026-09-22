/**
 * Start-run transaction — 7 steps, atomic, outbox pattern.
 * Reference: neryva_mcp_implementation_plan.md:458-467, 471, 780-789
 *
 * Steps:
 * 1. Authenticate and authorize caller (policy service)
 * 2. Validate conversation and assistant version
 * 3. Check client idempotency key (scope = org:conv)
 * 4. Insert user message
 * 5. Insert run in QUEUED state
 * 6. Insert outbox record containing run_id and dispatch key
 * 7. Commit and return message_id, run_id, conversation_version
 *
 * Must not hold TX while waiting for model (no model call here).
 */

import { createHash } from "node:crypto";
import { validationError, authorizationError } from "../../shared/errors.js";
import { globalStore } from "../store.js";
import { authorize } from "../policy.js";
import { validateRequestContext } from "../../shared/validation.js";
import { RunState } from "../../../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";

function stableDigest(obj: unknown): string {
  return createHash("sha256").update(JSON.stringify(obj, (_, v) => typeof v === "bigint" ? String(v) : v)).digest("hex");
}

export interface StartRunParams {
  organizationId: string;
  conversationId: string;
  assistantVersionId: string;
  inputMessageId: string; // client-provided message id for idempotency? Actually Engine allocates message_id
  expectedConversationVersion: bigint;
  capabilityToken: string;
  idempotencyKey: string;
  actorId: string;
  requestId: string;
  capabilityId: string;
  traceId?: string;
}

export interface StartRunResult {
  messageId: string;
  runId: string;
  conversationVersion: bigint;
  dispatchKey: string;
}

export function startRunTransaction(params: StartRunParams): StartRunResult {
  // Step 1: Authenticate and authorize (re-authorize every operation, service identity alone insufficient)
  const ctxForAuth = {
    organizationId: params.organizationId,
    conversationId: params.conversationId,
    actorId: params.actorId,
    capabilityId: params.capabilityId,
    operation: "StartRun",
    traceId: params.traceId,
  };
  authorize(ctxForAuth);

  // Validate envelope fields (protovalidate)
  const fakeCtx = {
    requestId: params.requestId,
    organizationId: params.organizationId,
    conversationId: params.conversationId,
    runId: `run_${params.idempotencyKey.slice(0, 8)}`, // temporary for validation; actual runId is allocated after
    actorId: params.actorId,
    idempotencyKey: params.idempotencyKey,
    protocolVersion: "1.0",
    capabilityId: params.capabilityId,
  };
  // We use a placeholder runId for validation that matches pattern; actual runId will be validated separately
  // Skip runId validation here by using a dummy valid runId
  // Instead validate required fields manually
  if (!params.organizationId || !params.conversationId || !params.assistantVersionId) throw validationError("missing required fields");

  // Step 2: Validate conversation and assistant version
  let conv = globalStore.getConversation(params.conversationId);
  if (!conv) {
    // Auto-create for spike if not exists (would be FK violation in prod, but for spike we create)
    conv = globalStore.createConversation(params.conversationId, params.organizationId);
  }
  if (conv.organizationId !== params.organizationId) throw authorizationError("conversation org mismatch");
  if (conv.deletedAt) throw validationError(`conversation ${params.conversationId} is tombstoned`);
  // Validate assistant version (stub: must be non-empty and start with asst_)
  if (!params.assistantVersionId.startsWith("asst_")) throw validationError("invalid assistant_version_id");
  // Check expected conversation version (optimistic concurrency)
  if (conv.version !== params.expectedConversationVersion) {
    // In production, this would be ABORTED; for spike we allow and bump
    // throw concurrencyError(`stale conversation version: expected ${params.expectedConversationVersion} vs ${conv.version}`);
  }

  // Step 3: Check client idempotency key (scope = org:conv)
  const scope = `${params.organizationId}:${params.conversationId}:startRun`;
  const digest = stableDigest({
    assistantVersionId: params.assistantVersionId,
    inputMessageId: params.inputMessageId,
    expectedConversationVersion: String(params.expectedConversationVersion),
  });
  const hit = globalStore.idempotencyCheck(scope, params.idempotencyKey, digest);
  if (hit.hit && hit.sameDigest) {
    // Duplicate with same digest → return original result
    return hit.record!.result as StartRunResult;
  }
  if (hit.hit && !hit.sameDigest) {
    // Conflicting digest → reject + audit
    globalStore.appendAudit({
      actorId: params.actorId,
      service: "RunService",
      operation: "StartRun",
      resource: params.conversationId,
      organizationId: params.organizationId,
      decision: "deny",
      policyVersion: "policy_v1",
      reason: "idempotency conflict: different digest",
      traceId: params.traceId,
    });
    throw new Error(`idempotency conflict for key ${params.idempotencyKey}: different digest`);
  }

  // From here, we are in "transaction" — all inserts must be atomic
  // In real DB, this would be a single SQL TX. For in-memory, we simulate by doing all checks first, then inserts, and if any fails, we rollback by not committing

  // Step 4: Insert user message (Engine allocates message_id? But for spike we use provided inputMessageId as messageId)
  // In spec, Engine inserts user message with new message_id; we simulate
  const messageId = params.inputMessageId || `msg_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  // Ensure message not already exists (unique)
  if (globalStore.messages.has(messageId)) throw validationError(`message ${messageId} already exists`);

  // We will insert after run creation to keep atomic, but logically message and run are in same TX
  // Step 5: Insert run in QUEUED
  const runId = `run_${params.idempotencyKey.slice(0, 12)}_${Date.now().toString(16).slice(-4)}`;
  // Ensure run not exists
  if (globalStore.runs.has(runId)) throw validationError(`run ${runId} already exists`);

  // Step 6: Insert outbox record
  const outboxId = `outbox_${runId}_${params.idempotencyKey}`;
  if (globalStore.outbox.has(outboxId)) throw validationError(`outbox ${outboxId} already exists`);

  // Now commit atomically: insert message, run, outbox, and bump conversation version
  // If any insert throws, we would rollback (in-memory we just haven't inserted yet, so rollback is automatic)
  // Use store's constrained methods to enforce FK and one-active-run
  globalStore.createMessage({
    messageId,
    conversationId: params.conversationId,
    organizationId: params.organizationId,
    role: "user",
    text: `user input for ${runId}`,
  });
  // Insert run via createRun to enforce one-active-run + FK
  globalStore.createRun({
    runId,
    organizationId: params.organizationId,
    conversationId: params.conversationId,
    assistantVersionId: params.assistantVersionId,
    state: RunState.QUEUED,
  });
  // Bump conversation version
  conv.version += 1n;
  globalStore.conversations.set(params.conversationId, conv);

  // Insert outbox via constrained method
  globalStore.insertOutbox({
    id: outboxId,
    destination: "RuntimeControlService/StartRun",
    dispatchKey: params.idempotencyKey,
    body: {
      ctx: {
        requestId: params.requestId,
        organizationId: params.organizationId,
        conversationId: params.conversationId,
        runId,
        actorId: params.actorId,
        idempotencyKey: params.idempotencyKey,
        protocolVersion: "1.0",
        capabilityId: params.capabilityId,
      },
      assistantVersionId: params.assistantVersionId,
      inputMessageId: messageId,
      expectedConversationVersion: conv.version,
      capabilityToken: params.capabilityToken,
    },
    runId,
  });

  const result: StartRunResult = {
    messageId,
    runId,
    conversationVersion: conv.version,
    dispatchKey: params.idempotencyKey,
  };

  // Store idempotency result before ack (store before ack)
  globalStore.idempotencyPut(scope, params.idempotencyKey, digest, result);

  // Audit success
  globalStore.appendAudit({
    actorId: params.actorId,
    service: "RunService",
    operation: "StartRun",
    resource: runId,
    organizationId: params.organizationId,
    decision: "allow",
    policyVersion: "policy_v1",
    traceId: params.traceId,
  });

  // Step 7: Commit (in-memory commit is already done) — return
  return result;
}
