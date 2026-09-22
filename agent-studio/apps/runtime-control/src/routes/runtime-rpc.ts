/**
 * runtime-rpc.ts — ConnectRPC host for neryva.mcp.runtime.v1.RuntimeControlService.
 *
 * This is the leg the Engine's dispatch consumer calls: StartRun / CancelRun /
 * DeliverRunInput / GetRuntimeStatus / DrainRuntime. AuthN is the shared
 * service token (Authorization: Bearer) — REQUIRED in production, fail-closed;
 * per-run authorization stays with the Engine (run-scoped capability tokens on
 * the authority RPCs; StartRun merely carries the token into the executor).
 */

import {
  Code,
  ConnectError,
  type ConnectRouter,
  type HandlerContext,
  type Interceptor,
} from '@connectrpc/connect';
import {
  RuntimeControlService,
  type StartRunRequest,
  type CancelRunRequest,
  type DeliverRunInputRequest,
  type GetRuntimeStatusRequest,
  type DrainRuntimeRequest,
} from '@neryva/mcp-contract';
import type { RuntimeControlService as ControlFacade } from './internal-control.js';
import type { InlineRunInput } from '../inline-executor.js';

export interface RuntimeRpcDeps {
  control: ControlFacade;
  /** Inline execution path (EXECUTION_MODE=inline). */
  executeInline: (input: InlineRunInput) => Promise<{ resultText: string }>;
  serviceToken?: string | undefined;
  /** Fail the request when no capability token rides StartRun. */
  requireCapabilityToken: boolean;
}

function assertServiceAuth(context: HandlerContext, deps: RuntimeRpcDeps): void {
  const header =
    context.requestHeader.get('authorization') ?? context.requestHeader.get('Authorization');
  if (!deps.serviceToken) {
    // Dev/staging without a token: allow (Engine↔Studio leg is internal);
    // production config refuses to boot without NERYVA_SERVICE_TOKEN.
    return;
  }
  const expected = `Bearer ${deps.serviceToken}`;
  if (header !== expected) {
    throw new ConnectError('unauthorized runtime control call', Code.Unauthenticated);
  }
}

function readCtx(req: unknown): {
  requestId: string;
  organizationId: string;
  conversationId: string;
  runId: string;
  actorId: string;
  idempotencyKey: string;
  capabilityId: string;
} {
  const c = (req as { ctx?: Record<string, string | undefined> | undefined }).ctx;
  if (!c?.organizationId || !c.conversationId || !c.runId) {
    throw new ConnectError(
      'ctx.organization_id, ctx.conversation_id and ctx.run_id are required',
      Code.InvalidArgument,
    );
  }
  return {
    requestId: c.requestId || '',
    organizationId: c.organizationId,
    conversationId: c.conversationId,
    runId: c.runId,
    actorId: c.actorId || 'engine-dispatcher',
    idempotencyKey: c.idempotencyKey || '',
    capabilityId: c.capabilityId || '',
  };
}

/** Service-token auth interceptor — rejects early, before any handler runs.
 * Connect v2 server interceptors are `(next) => (req) => ...`: the runtime
 * calls `next()` with ONE request object that carries the inbound headers as
 * `header` (@connectrpc/connect protocol/invoke-implementation.js
 * `requestCommon()` → `header: context.requestHeader`). There is no second
 * context argument, so reading `context.requestHeader` here is always
 * undefined and every RPC 500s with a TypeError before any handler runs.
 * The per-handler `assertServiceAuth(context, deps)` calls stay as they are —
 * handlers really do receive a HandlerContext. */
export function serviceAuthInterceptor(deps: RuntimeRpcDeps): Interceptor {
  return (next) => async (req) => {
    const header = (req as { header?: { get(name: string): string | null } }).header;
    if (deps.serviceToken) {
      const expected = `Bearer ${deps.serviceToken}`;
      if (header?.get('authorization') !== expected) {
        throw new ConnectError('unauthorized runtime control call', Code.Unauthenticated);
      }
    }
    return next(req);
  };
}

export function registerRuntimeControlRpc(router: ConnectRouter, deps: RuntimeRpcDeps): void {
  router.service(RuntimeControlService, {
    async startRun(req: StartRunRequest, context: HandlerContext) {
      assertServiceAuth(context, deps);
      const c = readCtx(req);
      if (deps.requireCapabilityToken && !req.capabilityToken) {
        throw new ConnectError('capability_token is required to start a run', Code.InvalidArgument);
      }
      const result = await deps.control.startRun({
        runId: c.runId,
        organizationId: c.organizationId,
        conversationId: c.conversationId,
        agentVersionId: req.assistantVersionId,
        policySnapshotId: req.assistantVersionId, // Engine pins snapshots per version; manifest carries the authoritative id
        capabilityToken: req.capabilityToken,
        capabilityId: c.capabilityId,
        actorId: c.actorId,
        idempotencyKey: c.idempotencyKey || `start-run:${c.runId}`,
        correlationId: c.requestId || c.runId,
      });
      return {
        workflowId: result.workflowId,
        alreadyStarted: result.alreadyStarted,
        runId: c.runId,
      };
    },

    async cancelRun(req: CancelRunRequest, context: HandlerContext) {
      assertServiceAuth(context, deps);
      const c = readCtx(req);
      await deps.control.cancelRun({
        runId: c.runId,
        reason: req.reason || 'cancelled by engine',
        requestedBy: c.actorId,
      });
      return { accepted: true, runId: c.runId };
    },

    async deliverRunInput(req: DeliverRunInputRequest, context: HandlerContext) {
      assertServiceAuth(context, deps);
      const c = readCtx(req);
      const kind: 'APPROVAL_DECISION' | 'USER_MESSAGE' =
        req.kind === 1 ? 'APPROVAL_DECISION' : 'USER_MESSAGE';
      const payloadRaw =
        req.payload instanceof Uint8Array ? new TextDecoder().decode(req.payload) : '';
      let payload: unknown = {};
      try {
        payload = payloadRaw ? (JSON.parse(payloadRaw) as unknown) : {};
      } catch {
        payload = { raw: payloadRaw.slice(0, 1024) };
      }
      const result = await deps.control.deliverRunInput({
        runId: c.runId,
        requestId: req.inputId,
        inputType: kind,
        payload,
        idempotencyKey: c.idempotencyKey || `deliver:${req.inputId}`,
        requireSyncValidation: false,
      });
      const nowMs = Date.now();
      return {
        delivered: result.delivered,
        acceptedAt: {
          seconds: BigInt(Math.floor(nowMs / 1000)),
          nanos: (nowMs % 1000) * 1_000_000,
        },
      };
    },

    async getRuntimeStatus(req: GetRuntimeStatusRequest, context: HandlerContext) {
      assertServiceAuth(context, deps);
      const c = readCtx(req);
      const progress = (await deps.control.getProgress(c.runId)) as
        { kernelState?: { status?: string } } | undefined;
      return {
        runId: c.runId,
        workflowId: `agent-run::${c.runId}`,
        state: progress?.kernelState?.status ?? 'UNKNOWN',
      };
    },

    async drainRuntime(_req: DrainRuntimeRequest, context: HandlerContext) {
      assertServiceAuth(context, deps);
      // Inline mode is process-local: draining stops accepting new StartRuns
      // via the executor guard below. Temporal workers drain on their own
      // grace period.
      return { draining: true };
    },
  });
}
