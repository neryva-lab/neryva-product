/**
 * errors.ts — Neryva-normalized provider error taxonomy
 * Source: agent_studio_implementation_plan.md:862-886, 890-903
 * All provider errors are mapped to this contract; provider-specific codes never leak.
 */

import { z } from 'zod';

export const NeryvaProviderErrorCodeSchema = z.enum([
  'INVALID_REQUEST', // 400 — schema/validation
  'AUTH_FAILED', // 401/403 — credential invalid or expired
  'FORBIDDEN', // 403 — allowlist / policy
  'NOT_FOUND', // 404 — model not found
  'RATE_LIMITED', // 429 — with retry-after
  'TIMEOUT', // deadline exceeded
  'CONTEXT_LENGTH_EXCEEDED', // provider context window
  'UNSUPPORTED_FEATURE', // tool/structured output not supported
  'CONTENT_FILTERED', // safety refusal distinct from normal refusal
  'PROVIDER_UNAVAILABLE', // 5xx / transient
  'CANCELLED', // caller cancelled
  'UNKNOWN',
]);

export type NeryvaProviderErrorCode = z.infer<typeof NeryvaProviderErrorCodeSchema>;

export const NeryvaProviderErrorSchema = z.object({
  code: NeryvaProviderErrorCodeSchema,
  /** Human-safe message (redacted, no secrets) */
  message: z.string().min(1).max(2000),
  /** Whether caller may retry (respects retry-after) */
  retryable: z.boolean(),
  /** Suggested retry after in ms (from Retry-After header or provider hint) */
  retryAfterMs: z.number().int().min(0).optional(),
  /** Original provider code for telemetry (not for business logic) */
  providerCode: z.string().optional(),
  /** HTTP status if applicable */
  httpStatus: z.number().int().optional(),
  /** Provider id that produced the error */
  providerId: z.string().optional(),
  /** Whether error is due to budget/entitlement */
  isBudget: z.boolean().optional(),
});

export type NeryvaProviderErrorData = z.infer<typeof NeryvaProviderErrorSchema> & {
  name: 'NeryvaProviderError';
};

export class NeryvaProviderError extends Error implements NeryvaProviderErrorData {
  code: NeryvaProviderErrorCode;
  retryable: boolean;
  retryAfterMs?: number | undefined;
  providerCode?: string | undefined;
  httpStatus?: number | undefined;
  providerId?: string | undefined;
  isBudget?: boolean | undefined;
  declare name: 'NeryvaProviderError';

  constructor(params: Omit<NeryvaProviderErrorData, 'name'>) {
    super(params.message);
    this.name = 'NeryvaProviderError';
    this.code = params.code;
    this.retryable = params.retryable;
    this.retryAfterMs = params.retryAfterMs;
    this.providerCode = params.providerCode;
    this.httpStatus = params.httpStatus;
    this.providerId = params.providerId;
    this.isBudget = params.isBudget;
  }

  static invalidRequest(message: string, providerId?: string): NeryvaProviderError {
    return new NeryvaProviderError({
      code: 'INVALID_REQUEST',
      message,
      retryable: false,
      providerId,
    });
  }

  static authFailed(message: string, providerId?: string): NeryvaProviderError {
    return new NeryvaProviderError({ code: 'AUTH_FAILED', message, retryable: false, providerId });
  }

  static rateLimited(
    message: string,
    retryAfterMs?: number,
    providerId?: string,
  ): NeryvaProviderError {
    return new NeryvaProviderError({
      code: 'RATE_LIMITED',
      message,
      retryable: true,
      retryAfterMs,
      providerId,
    });
  }

  static timeout(message: string, providerId?: string): NeryvaProviderError {
    return new NeryvaProviderError({ code: 'TIMEOUT', message, retryable: true, providerId });
  }

  static contextLengthExceeded(message: string, providerId?: string): NeryvaProviderError {
    return new NeryvaProviderError({
      code: 'CONTEXT_LENGTH_EXCEEDED',
      message,
      retryable: false,
      providerId,
    });
  }

  static unsupportedFeature(message: string, providerId?: string): NeryvaProviderError {
    return new NeryvaProviderError({
      code: 'UNSUPPORTED_FEATURE',
      message,
      retryable: false,
      providerId,
    });
  }
}
