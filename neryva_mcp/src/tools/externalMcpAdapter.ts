/**
 * External MCP Adapter — inside Studio Tool Gateway, never Neryva MCP.
 * Reference: neryva_mcp_implementation_plan.md:985-1004, ledger 8.1-8.5
 *
 * Invariants:
 * - External servers are untrusted dependencies, isolated from Neryva MCP
 * - Adapter normalizes external tools to Neryva ToolDescriptor, validates args/results
 * - Stateless + stateful sessions supported, session state isolated from workflow state
 * - Org allowlists, egress, scoped credentials, timeouts, size limits, circuit breaker, redaction/audit
 * - Preserves Neryva idempotency (stable key), never exposes arbitrary resources without policy
 * - Must not change meaning of Neryva MCP or weaken Engine authority
 */

import { validationError, authorizationError } from "../shared/errors.js";
import { ToolEffectClass, ApprovalRequirement } from "./registry.js";
import type { ToolDescriptor } from "./registry.js";
import { redactArgs } from "./redaction.js";

// ── Server registry (per-org allowlist) ──

export interface ExternalMcpServer {
  serverId: string;
  organizationId: string; // owner org — empty means global but still needs per-org allowlist entry
  url: string; // e.g., https://mcp.example.com
  transport: "stateless" | "stateful"; // external MCP session behavior
  allowedTools: string[]; // explicit allowlist, never "allow all"
  egress: "external_mcp";
  credentialRef: string; // scoped, never raw secret
  timeoutMs: number;
  maxResponseBytes: number;
  circuitBreakerThreshold: number;
}

const serverRegistry = new Map<string, ExternalMcpServer>(); // key = `${org}:${serverId}`
const orgAllowlist = new Map<string, Set<string>>(); // org -> set of serverIds

export function registerExternalMcpServer(server: ExternalMcpServer): void {
  if (!server.serverId || !server.organizationId || !server.url) throw validationError("serverId/organizationId/url required");
  if (!server.url.startsWith("https://")) throw validationError("external MCP URL must be https");
  if (server.allowedTools.length === 0) throw validationError("allowlist must be explicit, not empty");
  const key = `${server.organizationId}:${server.serverId}`;
  if (serverRegistry.has(key)) throw validationError(`server ${server.serverId} already registered for org ${server.organizationId}`);
  serverRegistry.set(key, server);
  let set = orgAllowlist.get(server.organizationId);
  if (!set) {
    set = new Set();
    orgAllowlist.set(server.organizationId, set);
  }
  set.add(server.serverId);
}

export function isServerAllowedForOrg(serverId: string, organizationId: string): boolean {
  return orgAllowlist.get(organizationId)?.has(serverId) ?? false;
}

export function getExternalServer(serverId: string, organizationId: string): ExternalMcpServer | undefined {
  return serverRegistry.get(`${organizationId}:${serverId}`);
}

export function listAllowedServers(organizationId: string): ExternalMcpServer[] {
  const ids = orgAllowlist.get(organizationId);
  if (!ids) return [];
  return [...ids].map((id) => serverRegistry.get(`${organizationId}:${id}`)!).filter(Boolean);
}

// ── Session state — isolated from workflow state (Temporal) ──
// Workflow history must never contain external session state; store separately.

export interface ExternalSession {
  sessionId: string;
  serverId: string;
  organizationId: string;
  mode: "stateless" | "stateful";
  createdAt: Date;
  lastUsedAt: Date;
  state: Record<string, unknown>; // e.g., external MCP session tokens, cursors
}

const sessions = new Map<string, ExternalSession>(); // key = `${org}:${serverId}:${sessionId}`

export function createExternalSession(serverId: string, organizationId: string, mode: "stateless" | "stateful", initialState: Record<string, unknown> = {}): ExternalSession {
  if (!isServerAllowedForOrg(serverId, organizationId)) throw authorizationError(`server ${serverId} not allowlisted for org ${organizationId}`);
  const sessionId = `extsess_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
  const sess: ExternalSession = {
    sessionId,
    serverId,
    organizationId,
    mode,
    createdAt: new Date(),
    lastUsedAt: new Date(),
    state: { ...initialState },
  };
  sessions.set(`${organizationId}:${serverId}:${sessionId}`, sess);
  return sess;
}

export function getExternalSession(serverId: string, organizationId: string, sessionId: string): ExternalSession | undefined {
  return sessions.get(`${organizationId}:${serverId}:${sessionId}`);
}

export function updateExternalSession(serverId: string, organizationId: string, sessionId: string, patch: Record<string, unknown>): void {
  const key = `${organizationId}:${serverId}:${sessionId}`;
  const sess = sessions.get(key);
  if (!sess) throw validationError(`session ${sessionId} not found`);
  sess.state = { ...sess.state, ...patch };
  sess.lastUsedAt = new Date();
  sessions.set(key, sess);
}

export function clearExternalSessions(): void {
  sessions.clear();
}

// ── Circuit breaker ──

const failureCounts = new Map<string, { count: number; openedAt?: Date }>();

export function recordExternalFailure(serverId: string, organizationId: string): void {
  const key = `${organizationId}:${serverId}`;
  const rec = failureCounts.get(key) ?? { count: 0 };
  rec.count++;
  const server = getExternalServer(serverId, organizationId);
  const threshold = server?.circuitBreakerThreshold ?? 5;
  if (rec.count >= threshold) rec.openedAt = new Date();
  failureCounts.set(key, rec);
}

export function recordExternalSuccess(serverId: string, organizationId: string): void {
  failureCounts.delete(`${organizationId}:${serverId}`);
}

export function isCircuitOpen(serverId: string, organizationId: string): boolean {
  const rec = failureCounts.get(`${organizationId}:${serverId}`);
  if (!rec?.openedAt) return false;
  // Half-open after 30s
  if (Date.now() - rec.openedAt.getTime() > 30_000) {
    failureCounts.delete(`${organizationId}:${serverId}`);
    return false;
  }
  return true;
}

export function clearCircuitBreakers(): void {
  failureCounts.clear();
}

// ── Tool normalization — external -> Neryva descriptor ──

export function normalizeExternalTool(externalName: string, externalSchema: { required?: string[]; properties?: Record<string, { type: string }> }, serverId: string, organizationId: string): ToolDescriptor {
  if (!isServerAllowedForOrg(serverId, organizationId)) throw authorizationError(`server ${serverId} not allowlisted`);
  // Validate external tool name and schema (untrusted)
  if (!externalName || typeof externalName !== "string") throw validationError("external tool name required");
  if (externalName.length > 64) throw validationError("external tool name too long");
  // Normalize to Neryva naming: external_<server>_<tool>
  const normalizedName = `ext_${serverId}_${externalName}`.slice(0, 64);
  // External tools are by default READ_ONLY unless explicitly marked, and require approval for mutating
  // For spike, we treat all external tools as READ_ONLY+NONE unless allowlist says otherwise, but we validate
  const descriptor: ToolDescriptor = {
    toolName: normalizedName,
    toolVersion: "v1",
    effectClass: ToolEffectClass.READ_ONLY,
    approvalRequirement: ApprovalRequirement.NONE,
    egress: "external_mcp",
    timeoutMs: getExternalServer(serverId, organizationId)?.timeoutMs ?? 5_000,
    idempotency: "supported",
    credentialRef: getExternalServer(serverId, organizationId)?.credentialRef ?? `cred_ext_${serverId}`,
    scope: "org",
    redactedFields: ["secret", "api_key", "password", "token"],
    schema: {
      required: externalSchema.required ?? [],
      properties: externalSchema.properties ?? {},
    },
  };
  // Validate that schema is not overly permissive (no arbitrary Any)
  if (Object.keys(descriptor.schema.properties).length > 20) throw validationError("external tool schema too large");
  return descriptor;
}

// ── Execution via external MCP — with all guards ──

export interface ExternalCallOpts {
  serverId: string;
  organizationId: string;
  toolName: string; // normalized Neryva name (ext_...)
  externalToolName: string; // original external name
  args: Record<string, unknown>;
  runId: string;
  stepId: string;
  toolCallId: string;
  sessionId?: string; // for stateful
  idempotencyKey: string; // Neryva stable key, preserved
}

const externalCallLog = new Map<string, { result: unknown; at: Date }>(); // idempotencyKey -> result

export async function callExternalMcpTool(opts: ExternalCallOpts): Promise<{ result: unknown; resultDigest: Uint8Array; wasDuplicate?: boolean }> {
  const { serverId, organizationId, toolName, externalToolName, args, runId, stepId, toolCallId, idempotencyKey } = opts;
  // 1. Org allowlist
  if (!isServerAllowedForOrg(serverId, organizationId)) throw authorizationError(`server ${serverId} not allowlisted for org ${organizationId}`);
  const server = getExternalServer(serverId, organizationId)!;
  // 2. Egress check (only external_mcp allowed for external tools)
  if (server.egress !== "external_mcp") throw validationError(`server ${serverId} egress not external_mcp`);
  // 3. Scoped credentials check
  if (!server.credentialRef || server.credentialRef.includes("sk-")) throw validationError("credentialRef must be scoped ref, not raw secret");
  // 4. Circuit breaker
  if (isCircuitOpen(serverId, organizationId)) throw new Error(`circuit open for ${serverId} (too many failures)`);
  // 5. Timeouts and size limits
  const size = JSON.stringify(args).length;
  if (size > server.maxResponseBytes) throw validationError(`args too large ${size} > ${server.maxResponseBytes}`);
  // 6. Idempotency — preserve Neryva semantics, never double external side effect
  const dedupKey = `${organizationId}:${serverId}:${idempotencyKey}`;
  const existing = externalCallLog.get(dedupKey);
  if (existing) {
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(JSON.stringify(existing.result)).digest();
    return { result: existing.result, resultDigest: digest, wasDuplicate: true };
  }
  // 7. Redaction for audit (never log raw secrets)
  const redacted = redactArgs(toolName, args);
  // 8. Simulate external call with timeout
  // In real, would do fetch with AbortController, validate response size, etc.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), server.timeoutMs);
  let result: unknown;
  try {
    // Simulate network — untrusted, may return arbitrary data
    // For spike, we simulate based on externalToolName
    if (externalToolName === "fail_tool") {
      throw new Error("external tool failed");
    }
    if (externalToolName === "slow_tool") {
      // Simulate slow that would hit timeout — but we have 5s, so not
      await new Promise((r) => setTimeout(r, 10));
    }
    // Simulate cancellation
    if (controller.signal.aborted) throw new Error("external call timeout");
    result = { externalTool: externalToolName, normalized: toolName, redactedArgs: redacted, runId, stepId, toolCallId };
    // 9. Validate result (untrusted) — must be bounded, no arbitrary resources
    const resultSize = JSON.stringify(result).length;
    if (resultSize > server.maxResponseBytes) throw validationError(`external result too large ${resultSize}`);
    // Never expose arbitrary external resources without policy — check that result doesn't contain resource URLs unless allowlisted
    const resultStr = JSON.stringify(result);
    if (resultStr.includes("file://") || resultStr.includes("s3://")) throw validationError("external result contains arbitrary resource without policy");
    // 10. Audit (redacted)
    const { globalStore } = await import("../engine/store.js");
    globalStore.appendAudit({
      actorId: "tool_gateway",
      service: "ExternalMcpAdapter",
      operation: `ExternalMcp:${serverId}:${externalToolName}`,
      resource: toolCallId,
      organizationId,
      decision: "allow",
      policyVersion: "policy_v1",
      reason: `ext call ${toolName} via ${serverId}`,
    });
    // Persist idempotency before ack
    externalCallLog.set(dedupKey, { result, at: new Date() });
    recordExternalSuccess(serverId, organizationId);
    clearTimeout(timeout);
    // Return with digest (32B)
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(JSON.stringify(result)).digest();
    return { result, resultDigest: digest };
  } catch (e) {
    clearTimeout(timeout);
    recordExternalFailure(serverId, organizationId);
    throw e;
  }
}

// ── Resource exposure guard — never expose arbitrary external resources without policy ──

export function isResourceAllowed(resourceUrl: string, organizationId: string, serverId: string): boolean {
  const server = getExternalServer(serverId, organizationId);
  if (!server) return false;
  // Only allow resources from allowlisted server's domain
  try {
    const url = new URL(resourceUrl);
    const serverUrl = new URL(server.url);
    return url.hostname === serverUrl.hostname;
  } catch {
    return false;
  }
}

export function clearExternalAdapter(): void {
  serverRegistry.clear();
  orgAllowlist.clear();
  clearExternalSessions();
  clearCircuitBreakers();
  externalCallLog.clear();
}
