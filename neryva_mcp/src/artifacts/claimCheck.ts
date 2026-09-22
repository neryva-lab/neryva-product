/**
 * Claim-check service + payload-size enforcement.
 * Reference: neryva_mcp_implementation_plan.md:113-115, 569-597, 595 sha256==32B
 *
 * Spike: in-memory artifact store with 7 checks.
 */

import { createHash } from "node:crypto";
import { validationError, integrityError } from "../shared/errors.js";
import { create } from "@bufbuild/protobuf";
import { ArtifactRefSchema } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js";
import type { ArtifactRef } from "../../neryva-mcp-contract/gen/ts/neryva/mcp/common/v1/common_pb.js";

export const MAX_INLINE_BYTES = 64 * 1024; // 64 KiB spike limit; larger must use claim-check per 113-115
export const ALLOWED_PURPOSES = new Set(["checkpoint", "kb_document", "tool_output", "assistant_output", "memory_proposal", "knowledge_chunk", "citation"]);
export const ALLOWED_MEDIA_TYPES = new Set(["application/json", "text/plain", "application/octet-stream", "text/markdown"]);

export interface ArtifactRecord {
  ref: ArtifactRef;
  data: Uint8Array;
  organizationId: string;
  runId: string;
  purpose: string;
  createdAt: Date;
  deletedAt?: Date; // retention/deletion tombstone per 1166
}

const store = new Map<string, ArtifactRecord>();

export function hashSha256(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

export function createArtifact(opts: {
  data: Uint8Array;
  mediaType: string;
  purpose: string;
  organizationId: string;
  runId: string;
  expiresInMs?: number;
  encryptionKeyId?: string;
}): ArtifactRef {
  if (!ALLOWED_PURPOSES.has(opts.purpose)) throw validationError(`purpose ${opts.purpose} not allowlisted`);
  if (!ALLOWED_MEDIA_TYPES.has(opts.mediaType)) throw validationError(`media_type ${opts.mediaType} not allowlisted`);
  const sha256 = hashSha256(opts.data);
  const artifactId = `art_${Buffer.from(sha256).toString("hex").slice(0, 12)}`;
  const uri = `artifact://${opts.organizationId}/${artifactId}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (opts.expiresInMs ?? 3600_000));
  const ref = create(ArtifactRefSchema, {
    artifactId,
    uri,
    mediaType: opts.mediaType,
    byteLength: BigInt(opts.data.length),
    sha256,
    encryptionKeyId: opts.encryptionKeyId ?? "key-default",
    purpose: opts.purpose,
    expiresAt: { seconds: BigInt(Math.floor(expiresAt.getTime() / 1000)), nanos: (expiresAt.getTime() % 1000) * 1_000_000 } as never,
  });

  store.set(artifactId, { ref, data: opts.data, organizationId: opts.organizationId, runId: opts.runId, purpose: opts.purpose, createdAt: new Date() });
  return ref;
}

/**
 * 7 checks per neryva_mcp_implementation_plan.md:569-577 + 584-593
 * 1. artifact ID and purpose (purpose enum/allowlist, not arbitrary)
 * 2. run and organization scope (fresh auth, ref != bearer)
 * 3. short expiry
 * 4. checksum sha256 exactly 32B
 * 5. byte range (max 1 GiB, matches stored)
 * 6. content-type allowlist
 * 7. encryption key policy
 * Plus deletion/retention check: deleted artifact inaccessible even to old refs (1166)
 */
export function verifyArtifact(ref: ArtifactRef, opts: { organizationId: string; runId: string }): Uint8Array {
  // 1. artifact ID and purpose — purpose must be allowlisted enum, not arbitrary caller string (595)
  if (!ref.artifactId || !ref.purpose) throw validationError("artifact ref missing id/purpose");
  if (!ALLOWED_PURPOSES.has(ref.purpose)) throw validationError(`purpose ${ref.purpose} not allowed (must be enum allowlist)`);
  // Also validate sha256 exactly 32B at boundary (595) — support Uint8Array, Buffer, hex string, or base64
  let shaBytes: Uint8Array;
  if (ref.sha256 instanceof Uint8Array) {
    shaBytes = ref.sha256;
  } else if (typeof (ref.sha256 as unknown) === "string") {
    const s = ref.sha256 as unknown as string;
    if (s.length === 64) shaBytes = new Uint8Array(Buffer.from(s, "hex"));
    else shaBytes = new Uint8Array(Buffer.from(s, "base64"));
  } else if (Array.isArray(ref.sha256)) {
    shaBytes = new Uint8Array(ref.sha256 as number[]);
  } else {
    throw validationError("ArtifactRef.sha256 must be exactly 32 bytes");
  }
  if (shaBytes.length !== 32) throw validationError("ArtifactRef.sha256 must be exactly 32 bytes");

  // 2. run and org scope — fresh auth: ref is opaque capability, not bearer; every read re-authorizes scope (675)
  const rec = store.get(ref.artifactId);
  if (!rec) throw validationError(`artifact ${ref.artifactId} not found`);
  if (rec.deletedAt) throw validationError(`artifact ${ref.artifactId} deleted (retention enforced)`);
  if (rec.organizationId !== opts.organizationId) throw validationError("artifact scope mismatch: organization (fresh auth)");
  if (rec.runId !== opts.runId) {
    // Allow same org different run only if purpose is shared knowledge? For spike, strict run scope
    throw validationError("artifact scope mismatch: run (fresh auth)");
  }
  // Also verify purpose matches stored (caller cannot swap purpose)
  if (rec.purpose !== ref.purpose) throw validationError(`artifact purpose mismatch stored=${rec.purpose} vs ref=${ref.purpose}`);
  // Opaque capability check: uri must be artifact:// not general object-storage URL (595)
  if (!ref.uri.startsWith("artifact://")) throw validationError("ArtifactRef.uri must be opaque artifact:// capability, not general URL");
  // 3. short expiry
  const exp = rec.ref.expiresAt as unknown as { seconds: bigint; nanos: number } | undefined;
  if (exp) {
    const ms = Number(exp.seconds) * 1000 + Math.floor(Number(exp.nanos ?? 0) / 1_000_000);
    if (ms < Date.now()) throw validationError("artifact expired");
  }
  // 4. checksum
  const expected = hashSha256(rec.data);
  if (shaBytes.length !== expected.length || !shaBytes.every((b, i) => b === expected[i])) {
    throw integrityError("artifact sha256 mismatch");
  }
  // 5. byte range
  const len = Number(ref.byteLength as unknown as bigint | number);
  if (len !== rec.data.length) throw integrityError("artifact byte_length mismatch");
  if (len > 1 * 1024 * 1024 * 1024) throw validationError("artifact too large");
  if (len <= 0) throw validationError("artifact byte_length must be >0");
  // 6. content-type allowlist
  if (!ALLOWED_MEDIA_TYPES.has(ref.mediaType)) throw validationError("artifact media_type not allowed");
  // 7. encryption key policy (stub: must be non-empty, would check KMS in prod)
  if (!ref.encryptionKeyId) throw validationError("artifact encryption_key_id required");
  // deletion already checked above
  return rec.data;
}

export function assertInlineOrClaimCheck(data: Uint8Array, purpose: string): ArtifactRef | undefined {
  if (data.length <= MAX_INLINE_BYTES) return undefined;
  // caller should create artifact instead — never put raw docs/secrets/unbounded prompts into Temporal args (597)
  throw validationError(`payload ${data.length} > ${MAX_INLINE_BYTES} requires ArtifactRef with purpose=${purpose}`);
}

export function deleteArtifact(artifactId: string, opts: { organizationId: string }): void {
  const rec = store.get(artifactId);
  if (!rec) throw validationError(`artifact ${artifactId} not found`);
  if (rec.organizationId !== opts.organizationId) throw validationError("artifact delete scope mismatch");
  rec.deletedAt = new Date();
  store.set(artifactId, rec);
}

export function getArtifactRecord(artifactId: string): ArtifactRecord | undefined {
  return store.get(artifactId);
}

export function clearArtifacts() {
  store.clear();
}
