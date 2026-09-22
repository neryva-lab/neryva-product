/**
 * references.ts — Studio artifact references (claim-check)
 * Source: agent_studio_implementation_plan.md:325-340 (artifacts organization_id+purpose enum+object_key tenant-bound+sha256/byte_length/encryption_key_ref/retention_class),
 * 589-594 (max inline/artifact bytes), 674 (ArtifactRef 8 fields), 839-848 (workflow payload protection)
 * Common proto: neryva.mcp.common.v1.ArtifactRef (artifact_id, uri, media_type, byte_length, sha256 32B, encryption_key_id, purpose lowercase, expires_at)
 * Studio internal uses tenant/run scoped refs with re-auth on read; proto conversion handles purpose casing.
 */

export const ALLOWED_PURPOSES = new Set([
  'SOURCE_DOCUMENT',
  'CHECKPOINT',
  'TOOL_RESULT',
  'TRANSCRIPT',
  'EXPORT',
  'KNOWLEDGE_CHUNK',
  'DIAGNOSTIC',
] as const);

export type ArtifactPurpose = typeof ALLOWED_PURPOSES extends Set<infer T> ? T : never;

const PURPOSE_TO_PROTO: Record<ArtifactPurpose, string> = {
  SOURCE_DOCUMENT: 'source_document',
  CHECKPOINT: 'checkpoint',
  TOOL_RESULT: 'tool_result',
  TRANSCRIPT: 'transcript',
  EXPORT: 'export',
  KNOWLEDGE_CHUNK: 'knowledge_chunk',
  DIAGNOSTIC: 'diagnostic',
};

const PROTO_TO_PURPOSE: Record<string, ArtifactPurpose> = Object.fromEntries(
  Object.entries(PURPOSE_TO_PROTO).map(([k, v]) => [v, k as ArtifactPurpose]),
) as Record<string, ArtifactPurpose>;

export interface StudioArtifactRef {
  artifactId: string;
  organizationId: string;
  runId: string;
  purpose: ArtifactPurpose;
  mediaType: string;
  byteLength: number;
  sha256: Uint8Array; // 32B
  expiresAt: Date;
  uri?: string;
  encryptionKeyId?: string;
  retentionClass?: string;
}

export interface ProtoArtifactRef {
  artifactId: string;
  uri: string;
  mediaType: string;
  byteLength: bigint | number;
  sha256: Uint8Array;
  encryptionKeyId: string;
  purpose: string; // lowercase
  expiresAt: Date;
}

export function validatePurpose(purpose: string): asserts purpose is ArtifactPurpose {
  if (!ALLOWED_PURPOSES.has(purpose as ArtifactPurpose)) {
    throw new Error(
      `artifact purpose ${purpose} not allowlisted: ${[...ALLOWED_PURPOSES].join(',')}`,
    );
  }
}

export function validateArtifactRef(ref: StudioArtifactRef): void {
  if (!ref.artifactId || typeof ref.artifactId !== 'string') throw new Error('artifactId required');
  if (ref.artifactId.length > 64) throw new Error('artifactId must be <=64');
  if (!ref.organizationId || typeof ref.organizationId !== 'string')
    throw new Error('organizationId required');
  if (!ref.runId || typeof ref.runId !== 'string') throw new Error('runId required');
  validatePurpose(ref.purpose);
  if (!ref.mediaType || typeof ref.mediaType !== 'string') throw new Error('mediaType required');
  if (ref.mediaType.length > 127) throw new Error('mediaType must be <=127');
  if (!Number.isInteger(ref.byteLength) || ref.byteLength <= 0)
    throw new Error('byteLength must be >0 integer');
  // proto caps at 1GiB, Studio caps at 10MiB via size-policy but validate both
  if (ref.byteLength > 1_073_741_824) throw new Error('byteLength exceeds proto 1GiB cap');
  if (!(ref.sha256 instanceof Uint8Array) || ref.sha256.length !== 32) {
    throw new Error(
      `sha256 must be 32B, got ${ref.sha256 instanceof Uint8Array ? ref.sha256.length : String(ref.sha256)}`,
    );
  }
  if (!(ref.expiresAt instanceof Date) || Number.isNaN(ref.expiresAt.getTime())) {
    throw new Error('expiresAt must be valid Date');
  }
  if (ref.expiresAt.getTime() <= Date.now()) throw new Error('artifact expired');
}

export function isExpired(ref: StudioArtifactRef): boolean {
  return ref.expiresAt.getTime() <= Date.now();
}

export function isAuthorizedFor(
  ref: StudioArtifactRef,
  organizationId: string,
  runId?: string,
): boolean {
  if (ref.organizationId !== organizationId) return false;
  if (runId !== undefined && ref.runId !== runId) return false;
  if (isExpired(ref)) return false;
  return true;
}

export function toProtoPurpose(purpose: ArtifactPurpose): string {
  return PURPOSE_TO_PROTO[purpose];
}

export function fromProtoPurpose(purpose: string): ArtifactPurpose {
  const mapped = PROTO_TO_PURPOSE[purpose];
  if (!mapped) throw new Error(`proto purpose ${purpose} not in allowlist`);
  return mapped;
}

export function toProtoArtifactRef(ref: StudioArtifactRef): ProtoArtifactRef {
  validateArtifactRef(ref);
  return {
    artifactId: ref.artifactId,
    uri: ref.uri ?? `s3://artifacts/${ref.organizationId}/${ref.runId}/${ref.artifactId}`,
    mediaType: ref.mediaType,
    byteLength: BigInt(ref.byteLength),
    sha256: ref.sha256,
    encryptionKeyId: ref.encryptionKeyId ?? 'kms-default',
    purpose: toProtoPurpose(ref.purpose),
    expiresAt: ref.expiresAt,
  };
}

export function fromProtoArtifactRef(
  proto: ProtoArtifactRef,
  organizationId: string,
  runId: string,
): StudioArtifactRef {
  const purpose = fromProtoPurpose(proto.purpose);
  const ref: StudioArtifactRef = {
    artifactId: proto.artifactId,
    organizationId,
    runId,
    purpose,
    mediaType: proto.mediaType,
    byteLength: typeof proto.byteLength === 'bigint' ? Number(proto.byteLength) : proto.byteLength,
    sha256: proto.sha256,
    expiresAt: proto.expiresAt,
    uri: proto.uri,
    encryptionKeyId: proto.encryptionKeyId,
  };
  validateArtifactRef(ref);
  return ref;
}

export function createArtifactId(runId: string): string {
  // deterministic-ish, but Engine is source; for tests, use run prefix + random
  const rand = Math.random().toString(36).slice(2, 8);
  const base = runId.slice(0, 8).replace(/[^a-zA-Z0-9]/g, 'a');
  return `art_${base}_${Date.now()}_${rand}`;
}
