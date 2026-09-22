import { Code, ConnectError } from "@connectrpc/connect";

/**
 * Neryva error catalog → gRPC/Connect mapping.
 * Reference: neryva_mcp_implementation_plan.md:741-754
 */
export type ErrorFamily =
  | "VALIDATION"
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "CONCURRENCY"
  | "AVAILABILITY"
  | "PROVIDER"
  | "TOOL"
  | "LIFECYCLE"
  | "INTEGRITY"
  | "INTERNAL";

export interface NeryvaErrorOpts {
  family: ErrorFamily;
  code: Code;
  message: string;
  details?: unknown;
}

const familyToCode: Record<ErrorFamily, Code> = {
  VALIDATION: Code.InvalidArgument,
  AUTHENTICATION: Code.Unauthenticated,
  AUTHORIZATION: Code.PermissionDenied,
  CONCURRENCY: Code.Aborted,
  AVAILABILITY: Code.Unavailable,
  PROVIDER: Code.ResourceExhausted,
  TOOL: Code.FailedPrecondition,
  LIFECYCLE: Code.FailedPrecondition,
  INTEGRITY: Code.DataLoss,
  INTERNAL: Code.Internal,
};

export function neryvaError(family: ErrorFamily, message: string, opts?: { code?: Code; details?: unknown }): ConnectError {
  const code = opts?.code ?? familyToCode[family];
  return new ConnectError(message, code, undefined, opts?.details ? [opts.details as never] : undefined);
}

export function validationError(message: string, details?: unknown) {
  return neryvaError("VALIDATION", message, { details });
}
export function authenticationError(message: string) {
  return neryvaError("AUTHENTICATION", message);
}
export function authorizationError(message: string) {
  return neryvaError("AUTHORIZATION", message);
}
export function concurrencyError(message: string) {
  return neryvaError("CONCURRENCY", message);
}
export function lifecycleError(message: string) {
  return neryvaError("LIFECYCLE", message);
}
export function integrityError(message: string) {
  return neryvaError("INTEGRITY", message);
}
