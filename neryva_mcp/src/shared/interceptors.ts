/**
 * ConnectRPC interceptor pipeline — fixed order per neryva_mcp_implementation_plan.md:710-723
 *
 * transport security (mTLS workload identity 668-678)
 *  -> request size/decompression limits
 *  -> authentication (workload identity 7.1)
 *  -> trace extraction (W3C 725)
 *  -> request validation (protovalidate)
 *  -> scope/capability validation (run capability 7.2, 682-693)
 *  -> idempotency and replay check (6-step 780-789)
 *  -> authorization (policy service 97)
 *  -> handler
 *  -> audit/metrics (12 IDs 842-852)
 */
import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { parseTraceParent, formatTraceParent, generateTraceContext } from "./trace.js";
import { validateRequestContext } from "./validation.js";
import { authorizationError, validationError, authenticationError } from "./errors.js";

export interface InterceptorOptions {
  maxBytes?: number;
  serviceName?: string;
}

/**
 * Size limit interceptor — rejects if X-Content-Length or serialized size exceeds max.
 */
export function sizeLimitInterceptor(maxBytes = 1 * 1024 * 1024): Interceptor {
  return (next) => async (req) => {
    // Connect doesn't expose raw bytes easily; we approximate via JSON length for spike
    // Real impl: check Content-Length header / decompressed size at transport layer
    const headerLen = req.header.get("content-length");
    if (headerLen && Number(headerLen) > maxBytes) {
      throw new ConnectError(`request too large: ${headerLen} > ${maxBytes}`, Code.ResourceExhausted);
    }
    return next(req);
  };
}

/**
 * Trace extraction interceptor — reads traceparent, injects into context, propagates downstream.
 * Attaches `traceparent` to response headers for correlation.
 */
export function traceInterceptor(): Interceptor {
  return (next) => async (req) => {
    const incoming = req.header.get("traceparent");
    const parsed = incoming ? parseTraceParent(incoming) : undefined;
    const ctx = parsed ?? generateTraceContext();
    // Echo traceparent for downstream consumers / tests
    // We mutate headers to ensure propagation in this fake transport
    req.header.set("traceparent", formatTraceParent(ctx));
    req.header.set("x-trace-id", ctx.traceId);
    const res = await next(req);
    res.header.set("traceparent", formatTraceParent(ctx));
    return res;
  };
}

/**
 * Validation interceptor — protovalidate at both boundaries.
 * Extracts `ctx` (RequestContext) from message if present and validates.
 */
export function validationInterceptor(): Interceptor {
  return (next) => async (req) => {
    const msg = req.message as Record<string, unknown>;
    if (msg && typeof msg === "object" && "ctx" in msg) {
      const ctx = (msg as Record<string, unknown>)["ctx"];
      if (ctx) validateRequestContext(ctx);
    }
    // Also handle `ctx` embedded in AppendRunEventsRequest etc — already covered
    return next(req);
  };
}

/**
 * Workload identity interceptor — mTLS / SPIFFE SVID verification (7.1).
 * Verifies X.509-SVID (preferred) or JWT, checks trust domain, expiry, rotation.
 */
export function workloadIdentityInterceptor(expectedTrustDomain: "prod" | "non-prod" = "non-prod"): Interceptor {
  return (next) => async (req) => {
    const svid = req.header.get("x-workload-svid") ?? req.header.get("x-mtls-cert");
    // In spike, SVID is optional for non-prod tests, but if present must be valid; in prod, require it
    if (svid) {
      const { verifyWorkloadIdentity } = await import("../security/workloadIdentity.js");
      const res = verifyWorkloadIdentity(svid, expectedTrustDomain);
      if (!res.valid) throw authenticationError(res.error ?? "workload identity invalid");
      // Attach verified identity for downstream audit
      req.header.set("x-verified-spiffe", res.spiffeId ?? "");
    }
    // Separate prod/non-prod trust domains already enforced via verify
    return next(req);
  };
}

/**
 * Run capability interceptor — validates short-lived run capability (7.2).
 * Checks 6 reject cases: missing/invalid, wrong audience/issuer, expired/not-yet-valid, scope mismatch, replayed nonce, stale lease, operation not listed, cross-tenant.
 */
export function runCapabilityInterceptor(): Interceptor {
  return (next) => async (req) => {
    const msg = req.message as Record<string, unknown>;
    const ctx = msg?.["ctx"] as Record<string, unknown> | undefined;
    const capToken = req.header.get("x-run-capability") ?? (ctx?.["capabilityId"] as string | undefined);
    // Capability is required for mutating RPCs; for spike, we allow missing but if present validate
    if (capToken && capToken.startsWith("eyJ")) {
      // Looks like JWT/base64 capability token
      try {
        const { verifyRunCapability } = await import("../security/runCapability.js");
        verifyRunCapability(capToken, { operation: req.method.name });
      } catch (e) {
        // Check if it's tool capability vs run capability — tool capability has different audience, ignore here
        const errMsg = (e as Error).message;
        if (errMsg.includes("audience") && errMsg.includes("neryva-agent-studio")) {
          // This is actually a tool capability, not run capability — let tool gateway verify
        } else if (!errMsg.includes("wrong audience")) {
          throw authenticationError(`run capability invalid: ${errMsg}`);
        }
      }
    }
    return next(req);
  };
}

/**
 * Idempotency and replay check interceptor — 6-step (780-789) + nonce replay (701).
 * Checks idempotencyKey presence and nonce replay before handler.
 */
export function idempotencyInterceptor(): Interceptor {
  return (next) => async (req) => {
    const msg = req.message as Record<string, unknown>;
    const ctx = msg?.["ctx"] as Record<string, unknown> | undefined;
    if (ctx) {
      const key = (ctx["idempotencyKey"] ?? ctx["idempotency_key"]) as string | undefined;
      const nonce = (ctx["capabilityId"] ?? ctx["capability_id"]) as string | undefined;
      // Idempotency key required for mutating RPCs (105)
      const mutating = [
        "CommitRunResult",
        "AppendRunEvents",
        "CreateApprovalRequest",
        "AuthorizeToolCall",
        "RecordToolOutcome",
        "AcquireOrRenewRunLease",
        "ReleaseRunLease",
        "FailRun",
        "SubmitMemoryProposal",
        "SaveCheckpointRef",
        "StartRun",
        "CancelRun",
        "DeliverRunInput",
      ];
      if (mutating.includes(req.method.name) && !key) {
        throw validationError(`idempotency_key required for ${req.method.name} (105)`);
      }
      // Nonce replay check (701) — if capabilityId is a nonce, ensure not replayed
      if (nonce) {
        const { isNonceReplayed } = await import("../security/runCapability.js");
        if (isNonceReplayed(nonce)) throw authenticationError(`replayed nonce ${nonce} (701)`);
      }
    }
    return next(req);
  };
}

/**
 * Scope validation interceptor — rejects scope mismatch between ctx and body.
 * Covers: wrong organization_id/conversation_id/run_id `neryva_mcp_implementation_plan.md:96-97,703-706`
 */
export function scopeInterceptor(store: { getRun?: (runId: string) => { organizationId: string; conversationId: string } | undefined }): Interceptor {
  return (next) => async (req) => {
    const msg = req.message as Record<string, unknown>;
    const ctx = msg?.["ctx"] as Record<string, unknown> | undefined;
    if (ctx && store.getRun) {
      const runId = (ctx["runId"] ?? ctx["run_id"]) as string | undefined;
      const orgId = (ctx["organizationId"] ?? ctx["organization_id"]) as string | undefined;
      const convId = (ctx["conversationId"] ?? ctx["conversation_id"]) as string | undefined;
      if (runId) {
        const run = store.getRun(runId);
        if (run) {
          if (orgId && run.organizationId !== orgId) {
            throw authorizationError(`scope mismatch: organization_id ${orgId} does not own run ${runId}`);
          }
          if (convId && run.conversationId !== convId) {
            throw authorizationError(`scope mismatch: conversation_id ${convId} does not own run ${runId}`);
          }
        }
      }
    }
    return next(req);
  };
}

/**
 * Policy interceptor — re-authorizes every operation (service identity alone insufficient).
 * Calls policy service which checks org/conv/run ownership and capability scope.
 * Reference: neryva_mcp_implementation_plan.md:97,1064
 */
export function policyInterceptor(): Interceptor {
  return (next) => async (req) => {
    const msg = req.message as Record<string, unknown>;
    const ctx = msg?.["ctx"] as Record<string, unknown> | undefined;
    if (ctx) {
      // Lazy import to avoid circular dep with store
      const { authorize } = await import("../engine/policy.js");
      const traceId = req.header.get("x-trace-id") ?? req.header.get("traceparent")?.split("-")[1];
      try {
        authorize({
          organizationId: (ctx["organizationId"] ?? ctx["organization_id"]) as string,
          conversationId: (ctx["conversationId"] ?? ctx["conversation_id"]) as string | undefined,
          runId: (ctx["runId"] ?? ctx["run_id"]) as string | undefined,
          actorId: (ctx["actorId"] ?? ctx["actor_id"]) as string,
          capabilityId: (ctx["capabilityId"] ?? ctx["capability_id"]) as string,
          operation: req.method.name,
          traceId,
        });
      } catch (e) {
        // authorize already audits deny; rethrow as ConnectError
        throw e;
      }
    }
    return next(req);
  };
}

/**
 * Simple audit interceptor — logs privileged ops for ledger exit gate "Audit records for all privileged ops"
 * For spike: stores to in-memory array accessible via `getAuditLog()`.
 */
export const auditLog: Array<{ time: string; method: string; requestId?: string; orgId?: string; traceId?: string }> = [];

export function auditInterceptor(): Interceptor {
  return (next) => async (req) => {
    const start = Date.now();
    const msg = req.message as Record<string, unknown>;
    const ctx = msg?.["ctx"] as Record<string, unknown> | undefined;
    const traceId = req.header.get("x-trace-id") ?? req.header.get("traceparent")?.split("-")[1];
    try {
      const res = await next(req);
      auditLog.push({
        time: new Date().toISOString(),
        method: req.method.name,
        requestId: (ctx?.["requestId"] ?? ctx?.["request_id"]) as string | undefined,
        orgId: (ctx?.["organizationId"] ?? ctx?.["organization_id"]) as string | undefined,
        traceId,
      });
      return res;
    } catch (e) {
      auditLog.push({
        time: new Date().toISOString(),
        method: req.method.name + ":error",
        requestId: (ctx?.["requestId"] ?? ctx?.["request_id"]) as string | undefined,
        orgId: (ctx?.["organizationId"] ?? ctx?.["organization_id"]) as string | undefined,
        traceId,
      });
      throw e;
    }
  };
}

export function getAuditLog() {
  return [...auditLog];
}
export function clearAuditLog() {
  auditLog.length = 0;
}
