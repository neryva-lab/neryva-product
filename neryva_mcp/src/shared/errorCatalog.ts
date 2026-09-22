/**
 * Error catalog — gRPC mapping + retry classification.
 * Reference: neryva_mcp_implementation_plan.md:215-216, 741-754, 756
 *
 * UNAVAILABLE retryable, ABORTED/FAILED_PRECONDITION/INVALID_ARGUMENT/UNAUTHENTICATED not blindly retried.
 */

import { Code } from "@connectrpc/connect";

export type RetryClass = "retryable" | "not_retryable" | "conditional";

export interface ErrorCatalogEntry {
  family: string;
  code: Code;
  retry: RetryClass;
  safeMessageKey: string;
}

const CATALOG: Record<string, ErrorCatalogEntry> = {
  // Validation
  INVALID_ARGUMENT: { family: "VALIDATION", code: Code.InvalidArgument, retry: "not_retryable", safeMessageKey: "invalid_request" },
  // Authentication
  UNAUTHENTICATED: { family: "AUTHENTICATION", code: Code.Unauthenticated, retry: "not_retryable", safeMessageKey: "auth_failed" },
  // Authorization
  PERMISSION_DENIED: { family: "AUTHORIZATION", code: Code.PermissionDenied, retry: "not_retryable", safeMessageKey: "forbidden" },
  // Concurrency
  ABORTED: { family: "CONCURRENCY", code: Code.Aborted, retry: "not_retryable", safeMessageKey: "conflict_retry" },
  FAILED_PRECONDITION: { family: "LIFECYCLE", code: Code.FailedPrecondition, retry: "not_retryable", safeMessageKey: "precondition_failed" },
  ALREADY_EXISTS: { family: "CONCURRENCY", code: Code.AlreadyExists, retry: "not_retryable", safeMessageKey: "already_exists" },
  // Availability
  UNAVAILABLE: { family: "AVAILABILITY", code: Code.Unavailable, retry: "retryable", safeMessageKey: "temporarily_unavailable" },
  DEADLINE_EXCEEDED: { family: "AVAILABILITY", code: Code.DeadlineExceeded, retry: "conditional", safeMessageKey: "deadline_exceeded" },
  RESOURCE_EXHAUSTED: { family: "AVAILABILITY", code: Code.ResourceExhausted, retry: "conditional", safeMessageKey: "rate_limited" },
  // Integrity
  DATA_LOSS: { family: "INTEGRITY", code: Code.DataLoss, retry: "not_retryable", safeMessageKey: "integrity_error" },
};

export function getRetryClass(code: Code): RetryClass {
  for (const e of Object.values(CATALOG)) if (e.code === code) return e.retry;
  return "not_retryable";
}

export function isRetryable(code: Code): boolean {
  return getRetryClass(code) === "retryable";
}

export function isNotRetryable(code: Code): boolean {
  return getRetryClass(code) === "not_retryable";
}

export function catalogEntryForCode(code: Code): ErrorCatalogEntry | undefined {
  return Object.values(CATALOG).find((e) => e.code === code);
}
