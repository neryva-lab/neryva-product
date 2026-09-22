/**
 * interceptors.ts — protocol interceptors, scope/capability verifier
 * Source: agent_studio_implementation_plan.md:632-641, 1177-1192
 * Layers: generated transport → interceptors → scope/capability verifier → retry/idempotency → claim-check → domain client
 */

import type { Interceptor } from '@connectrpc/connect';
import { assertScopeImmutability } from '@neryva/security';
import { assertCapabilityForMethod, assertCapabilityScope } from '@neryva/security';
import type { Capability } from '@neryva/security';

export interface InterceptorContext {
  capability: Capability;
  grantedScope: {
    organizationId: string;
    conversationId: string;
    runId: string;
    agentVersionId: string;
    actorId: string;
  };
  method: string;
}

/**
 * Scope verifier — ensures caller cannot override granted scope fields.
 * Never allow caller to override organization_id, conversation_id, run_id, agent_version_id.
 */
export function createScopeVerifierInterceptor(ctx: InterceptorContext): Interceptor {
  return (next) => async (req) => {
    // In real Connect interceptor, req.message would be the protobuf message with RequestContext
    // For Phase 2, we verify via the passed context
    assertScopeImmutability(ctx.grantedScope, {
      organizationId: (req.message as unknown as { ctx: { organizationId: string } }).ctx
        .organizationId,
      conversationId: (req.message as unknown as { ctx: { conversationId: string } }).ctx
        .conversationId,
      runId: (req.message as unknown as { ctx: { runId: string } }).ctx.runId,
      agentVersionId: (req.message as unknown as { ctx: { agentVersionId: string } }).ctx
        .agentVersionId,
    } as never);
    // Capability scope match
    assertCapabilityScope(ctx.capability, ctx.grantedScope);
    assertCapabilityForMethod(ctx.capability, ctx.method);
    return next(req);
  };
}

/**
 * Retry interceptor — only for idempotent methods.
 * For Phase 2 skeleton, this is a placeholder; real retry is in retry.ts withRetry.
 */
export function createRetryInterceptor(): Interceptor {
  return (next) => async (req) => next(req);
}
