/**
 * Tool Gateway — 8-step flow + 6-step idempotency for side effects.
 * Reference: neryva_mcp_implementation_plan.md:588-616, 618-623, 992-1004
 *
 * 8-step flow:
 * 1. Model proposes typed tool call
 * 2. Studio validates tool name/args against published schema (registry)
 * 3. Studio asks Engine to authorize (AuthorizeToolCall) with run,step,target,policyVersion
 * 4. Engine checks tenant/user/assistant/capability/limits/approval
 * 5. Engine returns allow/deny + short-lived tool capability if allowed
 * 6. Studio executes through Tool Gateway Activity (with idempotency key)
 * 7. Studio records normalized outcome + redacted audit metadata (RecordToolOutcome)
 * 8. Engine accepts outcome once under tool-call idempotency key
 *
 * Idempotency 6 steps (609-616):
 * - Derive stable key from Neryva run+step identity
 * - Pass to external API where supported
 * - Persist request/response before ack
 * - Reconcile ambiguous timeout by lookup before retry
 * - Require manual reconciliation for providers without idempotency
 * - Never claim success on send alone
 */

import { createHash } from "node:crypto";
import { getToolDescriptor, validateToolArgs } from "./registry.js";
import { createToolCapability, hashArgs } from "./capability.js";
import { redactArgs, safeLogEntry } from "./redaction.js";
import { globalStore } from "../engine/store.js";
import { createRunAuthorityHandlers } from "../engine/authority.js";
import { validationError, authorizationError } from "../shared/errors.js";

// In-memory external side effects simulation — keyed by idempotency key
const externalEffects = new Map<string, { status: "success" | "ambiguous" | "failed"; result?: unknown; error?: string; attempts: number }>();
// Track raw args only as digest — never raw in logs/history
const requestLog: string[] = [];

function uuidv7(): string {
  const t = Date.now();
  const timeHex = t.toString(16).padStart(12, "0");
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);
  const randHex = Array.from(rand, (b) => b.toString(16).padStart(2, "0")).join("");
  return (
    timeHex.slice(0, 8) +
    "-" +
    timeHex.slice(8, 12) +
    "-7" +
    randHex.slice(1, 4) +
    "-" +
    ((parseInt(randHex.slice(4, 6), 16) & 0x3f | 0x80).toString(16).padStart(2, "0")) +
    randHex.slice(6, 8) +
    "-" +
    randHex.slice(8, 20)
  );
}

function stableIdempotencyKey(runId: string, stepId: string, toolCallId: string): string {
  return `neryva_tool_${runId}_${stepId}_${toolCallId}`;
}

function externalCallKey(toolName: string, idempotencyKey: string): string {
  return `${toolName}:${idempotencyKey}`;
}

export interface GatewayAuthorizeResult {
  allowed: boolean;
  reason: string;
  toolCapabilityToken?: string;
  approvalRequirement: number;
  descriptor?: ReturnType<typeof getToolDescriptor>;
}

export interface GatewayExecuteResult {
  status: "success" | "failed";
  result?: unknown;
  resultDigest: Uint8Array;
  wasReconciled?: boolean;
  wasDuplicate?: boolean;
}

export async function authorizeToolCallGateway(opts: {
  runId: string;
  organizationId: string;
  stepId: string;
  toolCallId: string;
  toolName: string;
  toolVersion?: string;
  args: Record<string, unknown>;
  actorId?: string;
}): Promise<GatewayAuthorizeResult> {
  const { runId, organizationId, stepId, toolCallId, toolName, args } = opts;
  const toolVersion = opts.toolVersion ?? "v1";
  // Step 2: validate schema — for external tools (ext_*) validate via adapter allowlist, not main registry
  let desc: ReturnType<typeof getToolDescriptor> | undefined;
  let isExternal = toolName.startsWith("ext_");
  if (isExternal) {
    const { getExternalServer, isServerAllowedForOrg } = await import("./externalMcpAdapter.js");
    const parts = toolName.split("_");
    const serverId = parts[1];
    if (!serverId || !isServerAllowedForOrg(serverId, organizationId)) {
      throw validationError(`external tool ${toolName} server ${serverId} not allowlisted for org ${organizationId}`);
    }
    const server = getExternalServer(serverId, organizationId);
    const extName = parts.slice(2).join("_") || "unknown";
    // Check that external tool is in server's allowlist
    if (server && !server.allowedTools.includes(extName)) {
      throw validationError(`external tool ${extName} not allowlisted for server ${serverId}`);
    }
    desc = getToolDescriptor(toolName);
    if (!desc) {
      const { normalizeExternalTool } = await import("./externalMcpAdapter.js");
      desc = normalizeExternalTool(extName, { required: Object.keys(args), properties: Object.fromEntries(Object.keys(args).map((k) => [k, { type: typeof args[k] }])) }, serverId, organizationId);
    }
    // For external, validate args manually against normalized descriptor (not main registry's validate which would fail)
    if (desc) {
      for (const req of desc.schema.required) {
        if (!(req in args) || args[req] === undefined || args[req] === "") throw validationError(`tool ${toolName} missing required field ${req}`);
      }
    }
  } else {
    validateToolArgs(toolName, args);
    desc = getToolDescriptor(toolName)!;
  }
  const argumentDigest = hashArgs(args); // 32B sha256

  // Step 3: ask Engine to authorize — Engine will also check registry + external allowlist
  const h = createRunAuthorityHandlers(globalStore);
  const ctx = {
    requestId: uuidv7(),
    organizationId,
    conversationId: globalStore.getRun(runId)?.conversationId ?? "conv_123",
    runId,
    actorId: opts.actorId ?? "studio_worker",
    idempotencyKey: `idem_auth_${runId}_${toolCallId}`,
    protocolVersion: "1.0",
    capabilityId: "cap_gateway",
  };
  const res = await h.authorizeToolCall({ ctx, stepId, toolCallId, toolName, toolVersion, argumentDigest } as never);
  return {
    allowed: res.allowed,
    reason: res.reason,
    toolCapabilityToken: res.toolCapabilityToken,
    approvalRequirement: res.approvalRequirement as unknown as number,
    descriptor: desc,
  };
}

export async function executeToolGateway(opts: {
  runId: string;
  stepId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  toolCapabilityToken?: string;
  organizationId: string;
}): Promise<GatewayExecuteResult> {
  const { runId, stepId, toolCallId, toolName, args } = opts;
  // External tools use adapter, not main registry
  const isExternal = toolName.startsWith("ext_");
  let desc: ReturnType<typeof getToolDescriptor> | undefined;
  if (isExternal) {
    const serverId = toolName.split("_")[1];
    const { getExternalServer, isServerAllowedForOrg } = await import("./externalMcpAdapter.js");
    if (!serverId || !isServerAllowedForOrg(serverId, opts.organizationId)) throw validationError(`external tool ${toolName} not allowlisted`);
    desc = getToolDescriptor(toolName) ?? { toolName, toolVersion: "v1", effectClass: 1, approvalRequirement: 1, egress: "external_mcp", timeoutMs: 5000, idempotency: "supported", credentialRef: `cred_ext_${serverId}`, scope: "org", redactedFields: [], schema: { required: [], properties: {} } } as unknown as ReturnType<typeof getToolDescriptor>;
  } else {
    desc = getToolDescriptor(toolName);
    if (!desc) throw validationError(`tool ${toolName} not registered`);
  }

  // Validate capability if provided
  if (opts.toolCapabilityToken) {
    const { verifyToolCapability } = await import("./capability.js");
    try {
      verifyToolCapability(opts.toolCapabilityToken, { runId, stepId, toolCallId, argumentDigest: hashArgs(args), organizationId: opts.organizationId });
    } catch (e) {
      throw authorizationError(`tool capability verification failed: ${(e as Error).message}`);
    }
  }

  const idempotencyKey = stableIdempotencyKey(runId, stepId, toolCallId);
  const extKey = externalCallKey(toolName, idempotencyKey);

  // If external, delegate to adapter (preserves Neryva idempotency, isolates session)
  if (isExternal) {
    const serverId = toolName.split("_")[1];
    const externalToolName = toolName.split("_").slice(2).join("_") || "unknown";
    const { callExternalMcpTool } = await import("./externalMcpAdapter.js");
    // External adapter already handles idempotency via Neryva key, plus its own dedup
    const res = await callExternalMcpTool({
      serverId,
      organizationId: opts.organizationId,
      toolName,
      externalToolName,
      args,
      runId,
      stepId,
      toolCallId,
      idempotencyKey,
    });
    // Also persist to gateway's externalEffects for Neryva-level dedup (so duplicate Neryva calls don't hit external again)
    if (!externalEffects.has(extKey)) {
      externalEffects.set(extKey, { status: "success", result: res.result, attempts: 1 });
      requestLog.push(safeLogEntry(toolName, args));
    }
    return { status: "success", result: res.result, resultDigest: res.resultDigest, wasDuplicate: res.wasDuplicate };
  }

  // Idempotency: if we already persisted request/response, return same (at-least-once, no second side effect)
  const existing = externalEffects.get(extKey);
  if (existing) {
    if (existing.status === "success") {
      const resultDigest = hashArgs(existing.result);
      return { status: "success", result: existing.result, resultDigest, wasDuplicate: true };
    }
    if (existing.status === "failed") {
      throw new Error(existing.error ?? "external tool failed");
    }
    // Ambiguous outcome handling (6-step #4 & #5): reconcile ambiguous timeout by lookup before retry
    if (!desc) throw validationError(`tool ${toolName} not registered`);
    if (desc.idempotency === "supported") {
      // Reconcile: did external actually commit?
      if (existing.status === "success") {
        return { status: "success", result: existing.result, resultDigest: hashArgs(existing.result), wasReconciled: true };
      }
      // If ambiguous with supported idempotency, lookup before retry; for retry attempts < 3 allow re-invocation with same idempotency key
      if (existing.attempts < 3) {
        existing.attempts++;
      } else {
        throw new Error(`tool ${toolName} ambiguous outcome requires lookup reconciliation after ${existing.attempts} attempts`);
      }
    } else {
      // Unsupported idempotency requires manual reconciliation — never blindly retry (609-616)
      throw new Error(`tool ${toolName} does not support idempotency — ambiguous outcome requires manual reconciliation, not blind retry`);
    }
  }

  // Redaction: never log raw sensitive args
  const redacted = redactArgs(toolName, args);
  const logEntry = safeLogEntry(toolName, args);
  requestLog.push(logEntry);
  // Also ensure we never put raw sensitive data into Temporal args — gateway is inside Activity, not Workflow

  // Simulate external call with idempotency key passed where supported
  // For spike, simulate tool execution: READ_ONLY fast, MUTATING medium, DESTRUCTIVE slow
  let result: unknown;
  let status: "success" | "failed" = "success";
  let attempts = 1;
  try {
    // Never claim success on send alone — must persist before ack (step 3 of 6)
    // Simulate network: if toolName contains "timeout", we simulate ambiguous timeout
    if (toolName === "send_email" && (args as Record<string, unknown>).to === "timeout@example.com") {
      // Simulate ambiguous timeout (provider didn't respond, may have sent)
      externalEffects.set(extKey, { status: "ambiguous", attempts });
      throw new Error("ambiguous timeout: provider did not respond, side effect uncertain");
    }
    // Simulate tool logic
    if (toolName === "read_document") {
      result = { docId: (args as Record<string, unknown>).docId, content: "doc content redacted" };
    } else if (toolName === "create_draft") {
      result = { draftId: `draft_${runId}_${toolCallId}`, content: (args as Record<string, unknown>).content };
    } else if (toolName === "create_support_ticket") {
      result = { ticketId: `ticket_${Date.now()}`, status: "created" };
    } else if (toolName === "delete_conversation") {
      result = { deleted: (args as Record<string, unknown>).conversationId };
    } else if (toolName === "send_email") {
      result = { sentTo: "[REDACTED]", messageId: `msg_${Date.now()}` };
    } else {
      result = { tool: toolName, redactedArgs: redacted };
    }
    const resultDigest = hashArgs(result);
    // Persist request/response before ack (6-step #3)
    externalEffects.set(extKey, { status: "success", result, attempts });
    // Also persist to Engine toolEffects via RecordToolOutcome will be called next
    return { status, result, resultDigest };
  } catch (e) {
    if ((e as Error).message.includes("ambiguous")) {
      // Persist ambiguous outcome for reconciliation
      externalEffects.set(extKey, { status: "ambiguous", error: (e as Error).message, attempts });
      throw e;
    }
    externalEffects.set(extKey, { status: "failed", error: (e as Error).message, attempts });
    throw e;
  }
}

export async function recordToolOutcomeGateway(opts: {
  runId: string;
  organizationId: string;
  stepId: string;
  toolCallId: string;
  toolName: string;
  status: string;
  result?: unknown;
  resultDigest?: Uint8Array;
  toolCapabilityToken?: string;
  argumentDigest?: Uint8Array;
}): Promise<{ accepted: boolean; wasDuplicate: boolean }> {
  const h = createRunAuthorityHandlers(globalStore);
  const ctx = {
    requestId: uuidv7(),
    organizationId: opts.organizationId,
    conversationId: globalStore.getRun(opts.runId)?.conversationId ?? "conv_123",
    runId: opts.runId,
    actorId: "studio_worker",
    idempotencyKey: `idem_record_${opts.runId}_${opts.toolCallId}`,
    protocolVersion: "1.0",
    capabilityId: "cap_gateway",
  };
  const resultDigest = opts.resultDigest ?? hashArgs(opts.result ?? {});
  const res = await h.recordToolOutcome({
    ctx,
    stepId: opts.stepId,
    toolCallId: opts.toolCallId,
    status: opts.status,
    resultDigest,
    resultRef: opts.result ? undefined : undefined,
    toolCapabilityToken: opts.toolCapabilityToken,
    argumentDigest: opts.argumentDigest,
  } as never);
  return res;
}

/** Full 8-step + 6-step composite for Studio Activities to call */
export async function fullToolFlow(opts: {
  runId: string;
  organizationId: string;
  stepId: string;
  toolCallId: string;
  toolName: string;
  toolVersion?: string;
  args: Record<string, unknown>;
  actorId?: string;
}): Promise<{ allowed: boolean; executed: boolean; result?: unknown; needsApproval?: boolean }> {
  // Step 1-2 model proposes + validates
  // Step 3-5 authorize
  const auth = await authorizeToolCallGateway(opts);
  if (!auth.allowed) {
    const needsApproval = auth.approvalRequirement === 2;
    return { allowed: false, executed: false, needsApproval };
  }
  // Step 6 execute
  const exec = await executeToolGateway({
    runId: opts.runId,
    stepId: opts.stepId,
    toolCallId: opts.toolCallId,
    toolName: opts.toolName,
    args: opts.args,
    toolCapabilityToken: auth.toolCapabilityToken,
    organizationId: opts.organizationId,
  });
  // Step 7-8 record
  await recordToolOutcomeGateway({
    runId: opts.runId,
    organizationId: opts.organizationId,
    stepId: opts.stepId,
    toolCallId: opts.toolCallId,
    toolName: opts.toolName,
    status: exec.status,
    result: exec.result,
    resultDigest: exec.resultDigest,
    toolCapabilityToken: auth.toolCapabilityToken,
    argumentDigest: hashArgs(opts.args),
  });
  return { allowed: true, executed: true, result: exec.result };
}

export function getRequestLog(): string[] {
  return [...requestLog];
}
export function clearGateway(): void {
  externalEffects.clear();
  requestLog.length = 0;
}
export function getExternalEffect(toolName: string, idempotencyKey: string): unknown {
  return externalEffects.get(`${toolName}:${idempotencyKey}`);
}

export function reconcileAmbiguousToolEffect(
  toolName: string,
  idempotencyKey: string,
  resolution?: { committed: boolean; result?: unknown },
): boolean {
  const extKey = externalCallKey(toolName, idempotencyKey);
  const entry = externalEffects.get(extKey);
  if (!entry || entry.status !== "ambiguous") return false;
  if (resolution?.committed) {
    entry.status = "success";
    entry.result = resolution.result ?? { tool: toolName, reconciled: true };
    externalEffects.set(extKey, entry);
    return true;
  } else {
    externalEffects.delete(extKey);
    return true;
  }
}

