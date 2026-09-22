/**
 * Neryva MCP client layers — Studio side.
 * Reference: neryva_mcp_implementation_plan.md:620-627, 96-97
 *
 * Layers: generated transport → interceptors → scope/capability verifier → retry/idempotency → claim-check → domain client
 * Never allow caller to override scope fields `96-97`.
 */

import { createClient } from "@connectrpc/connect";
import type { Transport } from "@connectrpc/connect";
import { RunAuthorityService } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/run/v1/run_pb.js";
import { createTestTransport } from "../shared/transport.js";
import { globalStore } from "../engine/store.js";
import { createRunAuthorityHandlers } from "../engine/authority.js";
import { Code, ConnectError } from "@connectrpc/connect";
import { createArtifact } from "../artifacts/claimCheck.js";

// In-memory transport for spike — in production would be HTTP with mTLS `668-678`
let cachedTransport: Transport | null = null;
let cachedClient: ReturnType<typeof createClient<typeof RunAuthorityService>> | null = null;

export function getEngineTransport(): Transport {
  if (cachedTransport) return cachedTransport;
  const handlers = createRunAuthorityHandlers(globalStore);
  cachedTransport = createTestTransport((r) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r as any).service(RunAuthorityService, handlers);
  });
  return cachedTransport;
}

export function getEngineClient(): ReturnType<typeof createClient<typeof RunAuthorityService>> {
  if (cachedClient) return cachedClient;
  cachedClient = createClient(RunAuthorityService, getEngineTransport());
  return cachedClient;
}

// Scope verifier — ensures caller cannot override org/conv/run `96-97`
export function verifyScope(ctx: { organizationId: string; conversationId: string; runId: string }, expected: { organizationId: string; conversationId: string; runId: string }): void {
  if (ctx.organizationId !== expected.organizationId) throw new ConnectError("scope mismatch: organization_id", Code.PermissionDenied);
  if (ctx.conversationId !== expected.conversationId) throw new ConnectError("scope mismatch: conversation_id", Code.PermissionDenied);
  if (ctx.runId !== expected.runId) throw new ConnectError("scope mismatch: run_id", Code.PermissionDenied);
}

// Retry wrapper for idempotent calls only `218-223`
export async function withRetry<T>(fn: () => Promise<T>, opts: { maxAttempts?: number; retryableCodes?: number[] } = {}): Promise<T> {
  const max = opts.maxAttempts ?? 3;
  const retryable = new Set(opts.retryableCodes ?? [Code.Unavailable]);
  let last: unknown;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const code = (e as ConnectError).code;
      if (!retryable.has(code) || attempt === max) throw e;
      await new Promise((r) => setTimeout(r, 10 * attempt));
    }
  }
  throw last;
}

// Claim-check helper — large values must use ArtifactRef `113-115`
export function wrapWithClaimCheck<T extends Record<string, unknown>>(
  value: T,
  opts: { organizationId?: string; runId?: string; purpose?: string; maxBytes?: number } = {},
): T | { artifactRef: unknown } {
  const maxBytes = opts.maxBytes ?? 64 * 1024;
  const json = JSON.stringify(value);
  if (json.length <= maxBytes) return value;
  const data = new TextEncoder().encode(json);
  const purpose = opts.purpose ?? "assistant_output";
  const ref = createArtifact({
    data,
    mediaType: "application/json",
    purpose,
    organizationId: opts.organizationId ?? "org_default",
    runId: opts.runId ?? "run_default",
  });
  return { artifactRef: ref } as unknown as T;
}

export function clearClientCache(): void {
  cachedTransport = null;
  cachedClient = null;
}
