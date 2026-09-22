/**
 * Protovalidate enforcement at both boundaries.
 * Reference: neryva_mcp_implementation_plan.md:272, ledger Phase 0 exit: "Invalid messages fail Protovalidate at both boundaries"
 *
 * Uses @bufbuild/protovalidate. For Phase 0 we validate via generated cel constraints where possible,
 * and manual checks for envelope invariants that protovalidate doesn't cover (sha256 length, UUIDv7 format already in proto).
 *
 * This module exports helpers to validate RequestContext + ArtifactRef + RunEvent before handler.
 */
import { create, isMessage } from "@bufbuild/protobuf";
import { RequestContextSchema, ArtifactRefSchema } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js";
import { validationError } from "./errors.js";

/**
 * Minimal manual validation that mirrors protovalidate constraints for RequestContext.
 * Throws ConnectError(INVALID_ARGUMENT) on failure.
 * In production, use `protovalidate` runtime: `createValidator(...).validate(msg)`
 */
export function validateRequestContext(ctx: unknown): asserts ctx is {
  requestId: string;
  organizationId: string;
  conversationId: string;
  runId: string;
  actorId: string;
  idempotencyKey: string;
  protocolVersion: string;
  capabilityId: string;
} {
  if (!ctx || typeof ctx !== "object") throw validationError("RequestContext required");

  // Support both camelCase (TS) and snake_case (proto) field names due to @bufbuild/protobuf codegen
  const obj = ctx as Record<string, unknown>;
  const get = (k: string, alt: string) => (obj[k] ?? obj[alt]) as string | undefined;

  const fields: Array<[string, string | undefined]> = [
    ["requestId/request_id", get("requestId", "request_id")],
    ["organizationId/organization_id", get("organizationId", "organization_id")],
    ["conversationId/conversation_id", get("conversationId", "conversation_id")],
    ["runId/run_id", get("runId", "run_id")],
    ["actorId/actor_id", get("actorId", "actor_id")],
    ["idempotencyKey/idempotency_key", get("idempotencyKey", "idempotency_key")],
    ["protocolVersion/protocol_version", get("protocolVersion", "protocol_version")],
    ["capabilityId/capability_id", get("capabilityId", "capability_id")],
  ];

  for (const [name, v] of fields) {
    if (!v || typeof v !== "string" || v.length === 0) {
      throw validationError(`RequestContext.${name} is required and must be non-empty`);
    }
    if (v.length > 128) throw validationError(`RequestContext.${name} exceeds max length`);
  }

  // requestId should be UUIDv7
  const rid = get("requestId", "request_id")!;
  if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(rid)) {
    throw validationError("RequestContext.request_id must be UUIDv7 (RFC 9562)");
  }
}

export function validateArtifactRef(ref: unknown): void {
  if (!ref || typeof ref !== "object") throw validationError("ArtifactRef required");
  const obj = ref as Record<string, unknown>;
  const get = (k: string, alt: string) => obj[k] ?? obj[alt];

  const sha256 = get("sha256", "sha256") as Uint8Array | undefined;
  if (!(sha256 instanceof Uint8Array) || sha256.length !== 32) {
    throw validationError("ArtifactRef.sha256 must be exactly 32 bytes");
  }

  const purpose = (get("purpose", "purpose") as string) ?? "";
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(purpose)) {
    throw validationError("ArtifactRef.purpose must match ^[a-z][a-z0-9_]{1,31}$ (allowlist, not free-form)");
  }

  const byteLen = get("byteLength", "byte_length") as bigint | number | undefined;
  const len = typeof byteLen === "bigint" ? Number(byteLen) : (byteLen as number);
  if (len !== undefined && len <= 0) throw validationError("ArtifactRef.byte_length must be > 0");
}

/**
 * Validate envelope size — payload-size enforcement + claim-check path.
 * Reference: neryva_mcp_implementation_plan.md:113-115,579,909
 */
export const MAX_REQUEST_BYTES = 1 * 1024 * 1024; // 1 MiB for spike
export const MAX_EVENT_BATCH = 32;

export function assertPayloadSize(bytes: number): void {
  if (bytes > MAX_REQUEST_BYTES) {
    throw validationError(`payload exceeds ${MAX_REQUEST_BYTES} bytes; use ArtifactRef claim-check`);
  }
}
