/**
 * error-mapping.ts — map Connect errors to domain StudioError
 * Source: agent_studio_implementation_plan.md:663-671, neryva_mcp_implementation_plan.md:741-754
 * Terminal authorization/protocol/lease failures are non-retryable; transient transport
 * failures are retryable; unknown is treated as unknown (callers fail safe).
 */

import { Code, ConnectError } from '@connectrpc/connect';
import { StudioError } from '@neryva/agent-kernel';

export function mapConnectError(err: unknown): StudioError {
  if (err instanceof StudioError) return err;
  if (err instanceof ConnectError) {
    const code = err.code;
    switch (code) {
      case Code.Unauthenticated:
      case Code.PermissionDenied:
        return new StudioError({
          code: 'CAPABILITY_DENIED',
          message: err.message,
          retryable: 'non-retryable',
          cause: err,
        });
      case Code.Aborted:
        return new StudioError({
          code: 'SCOPE_MISMATCH',
          message: `stale version or lease lost: ${err.message}`,
          retryable: 'non-retryable',
          cause: err,
        });
      case Code.FailedPrecondition:
        // Engine uses FailedPrecondition for terminal run / protocol mismatch /
        // capability version skew — terminal, never retry, never repair scope.
        return new StudioError({
          code: 'RUN_TERMINAL',
          message: err.message,
          retryable: 'non-retryable',
          cause: err,
        });
      case Code.AlreadyExists:
        return new StudioError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: `idempotency conflict: ${err.message}`,
          retryable: 'non-retryable',
          cause: err,
        });
      case Code.ResourceExhausted:
        return new StudioError({
          code: 'PROVIDER_ERROR',
          message: `rate limited: ${err.message}`,
          retryable: 'retryable',
          cause: err,
        });
      case Code.DeadlineExceeded:
        return new StudioError({
          code: 'TIMEOUT',
          message: err.message,
          retryable: 'retryable',
          cause: err,
        });
      case Code.Unavailable:
        return new StudioError({
          code: 'PROVIDER_ERROR',
          message: err.message,
          retryable: 'retryable',
          cause: err,
        });
      default:
        return new StudioError({
          code: 'INTERNAL',
          message: err.message,
          retryable: 'unknown',
          cause: err,
        });
    }
  }
  if (err instanceof Error) {
    return new StudioError({
      code: 'INTERNAL',
      message: err.message,
      retryable: 'unknown',
      cause: err,
    });
  }
  return new StudioError({ code: 'INTERNAL', message: String(err), retryable: 'unknown' });
}

export function isTerminalError(err: unknown): boolean {
  if (err instanceof StudioError) return err.retryable === 'non-retryable';
  if (!(err instanceof ConnectError)) return false;
  return (
    err.code === Code.Aborted ||
    err.code === Code.PermissionDenied ||
    err.code === Code.Unauthenticated ||
    err.code === Code.AlreadyExists ||
    err.code === Code.FailedPrecondition
  );
}
