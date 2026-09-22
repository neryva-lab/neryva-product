/**
 * Deadline/retry ownership — 4 owners per 218-223.
 * Reference: neryva_mcp_implementation_plan.md:218-223, 215-216
 *
 * 1. Neryva MCP retries only transport-level calls that are explicitly idempotent (UNAVAILABLE only).
 * 2. Temporal owns Activity retry and backoff for workflow work.
 * 3. Model Gateway owns provider-specific transient error normalization and provider retry hints.
 * 4. Effectful tools are not blindly retried — deterministic idempotency keys + reconciliation.
 */

import { Code, ConnectError } from "@connectrpc/connect";
import { isRetryable } from "./errorCatalog.js";

export type RetryOwner = "mcp_transport" | "temporal" | "model_gateway" | "tool";

export const DEADLINES_MS: Record<string, number> = {
  AcquireOrRenewRunLease: 2000,
  ReleaseRunLease: 2000,
  GetRun: 1000,
  CommitRunResult: 5000,
  FailRun: 3000,
  AppendRunEvents: 5000,
  GetAuthorizedRunContext: 3000,
  CreateApprovalRequest: 3000,
  SubmitMemoryProposal: 2000,
  AuthorizeToolCall: 2000,
  RecordToolOutcome: 3000,
  SaveCheckpointRef: 2000,
  ListRunEvents: 2000,
  WatchRunEvents: 0, // streaming, no deadline
  GetRunArtifact: 5000,
};

export function getDeadlineForMethod(method: string): number | undefined {
  return DEADLINES_MS[method];
}

export function shouldMcpRetry(code: Code, owner: RetryOwner): boolean {
  // MCP transport only retries UNAVAILABLE and only for idempotent methods
  if (owner !== "mcp_transport") return false;
  return isRetryable(code);
}

export function shouldTemporalRetry(code: Code): boolean {
  // Temporal owns Activity retry — retry unless non-retryable codes
  return code === Code.Unavailable || code === Code.DeadlineExceeded || code === Code.ResourceExhausted;
}

export function shouldModelGatewayRetry(code: Code, providerHint?: string): boolean {
  // Model Gateway normalizes provider errors and respects provider retry hints
  if (providerHint === "retryable") return true;
  return code === Code.ResourceExhausted; // rate limit
}

export function shouldToolRetry(toolIdempotency: "supported" | "unsupported", code: Code, isAmbiguous: boolean): boolean {
  // Effectful tools are not blindly retried — require idempotency + reconciliation
  if (isAmbiguous) return false; // manual reconciliation required if ambiguous and unsupported
  if (toolIdempotency === "unsupported") return false;
  return code === Code.Unavailable;
}

export async function withMcpRetry<T>(fn: () => Promise<T>, opts: { owner: RetryOwner; maxAttempts?: number } = { owner: "mcp_transport" }): Promise<T> {
  const max = opts.maxAttempts ?? 3;
  let attempts = 0;
  while (true) {
    try {
      attempts++;
      return await fn();
    } catch (e) {
      const code = (e as ConnectError).code ?? Code.Unknown;
      if (attempts >= max || !shouldMcpRetry(code, opts.owner)) throw e;
      await new Promise((r) => setTimeout(r, 10 * attempts));
    }
  }
}
