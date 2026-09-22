/**
 * Test transport wiring — ConnectRPC in-memory router with fixed interceptor order.
 * Reference: neryva_mcp_implementation_plan.md:710-723 interceptor order
 *
 * For Phase 0 spike we use `createRouterTransport` from @connectrpc/connect so tests
 * can call Engine/Studio fakes without starting an HTTP server, while still exercising
 * interceptors (trace, size, validation, scope).
 *
 * Real deployment: Engine uses @connectrpc/connect-node with Fastify/Express adapter.
 */

import { createRouterTransport } from "@connectrpc/connect";
import type { Interceptor } from "@connectrpc/connect";
import {
  workloadIdentityInterceptor,
  sizeLimitInterceptor,
  traceInterceptor,
  validationInterceptor,
  runCapabilityInterceptor,
  scopeInterceptor,
  idempotencyInterceptor,
  policyInterceptor,
  auditInterceptor,
} from "./interceptors.js";
import { globalStore } from "../engine/store.js";

// We export a helper to build a test transport with ordered interceptors.
// Callers pass a router callback that registers service handlers.

export function createTestTransport(
  configure: (router: unknown) => void,
  opts?: { interceptors?: Interceptor[]; trustDomain?: "prod" | "non-prod" },
): ReturnType<typeof createRouterTransport> {
  // Fixed interceptor order per 710-723: TLS→size→auth→trace(W3C)→validation→capability/scope→idempotency→authz→audit
  const defaultInterceptors: Interceptor[] = [
    workloadIdentityInterceptor(opts?.trustDomain ?? "non-prod"),
    sizeLimitInterceptor(),
    traceInterceptor(), // W3C Trace Context 725
    validationInterceptor(),
    runCapabilityInterceptor(),
    scopeInterceptor({
      getRun: (runId) => {
        const r = globalStore.getRun(runId);
        return r ? { organizationId: r.organizationId, conversationId: r.conversationId } : undefined;
      },
    }),
    idempotencyInterceptor(),
    policyInterceptor(),
    auditInterceptor(),
  ];

  const interceptors = [...defaultInterceptors, ...(opts?.interceptors ?? [])];

  return createRouterTransport(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (router: any) => {
      (configure as (r: typeof router) => void)(router);
    },
    { transport: { interceptors } },
  );
}
