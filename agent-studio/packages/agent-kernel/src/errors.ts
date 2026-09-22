/**
 * errors.ts — stable error taxonomy for Agent Studio kernel
 * Source: agent_studio_implementation_plan.md:756-770, 1135-1162
 * No `any` at boundaries; use typed errors with code + retryability.
 */

export type ErrorCode =
  | 'INVALID_TRANSITION'
  | 'BUDGET_EXHAUSTED'
  | 'DEFINITION_INVALID'
  | 'CAPABILITY_DENIED'
  | 'SCOPE_MISMATCH'
  | 'PROVIDER_ERROR'
  | 'TOOL_DENIED'
  | 'APPROVAL_REQUIRED'
  | 'CONTEXT_TOO_LARGE'
  | 'ARTIFACT_TOO_LARGE'
  | 'CHECKPOINT_INVALID'
  | 'RUN_TERMINAL'
  | 'IDEMPOTENCY_CONFLICT'
  | 'TIMEOUT'
  | 'INTERNAL';

export type Retryability = 'retryable' | 'non-retryable' | 'unknown';

export interface StudioErrorOptions {
  code: ErrorCode;
  message: string;
  retryable: Retryability;
  cause?: unknown;
  details?: Record<string, unknown> | undefined;
}

export class StudioError extends Error {
  public readonly code: ErrorCode;
  public readonly retryable: Retryability;
  public readonly details: Record<string, unknown> | undefined;

  constructor(options: StudioErrorOptions) {
    super(options.message);
    this.name = 'StudioError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.details = options.details;
    if (options.cause !== undefined) {
      (this as unknown as { cause: unknown }).cause = options.cause;
    }
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details !== undefined ? { details: this.details } : {}),
    };
  }
}

export function invalidTransition(from: string, to: string): StudioError {
  return new StudioError({
    code: 'INVALID_TRANSITION',
    message: `invalid transition ${from} -> ${to}`,
    retryable: 'non-retryable',
    details: { from, to },
  });
}

export function budgetExhausted(budget: string, limit: number): StudioError {
  return new StudioError({
    code: 'BUDGET_EXHAUSTED',
    message: `budget exhausted: ${budget} limit ${limit}`,
    retryable: 'non-retryable',
    details: { budget, limit },
  });
}
