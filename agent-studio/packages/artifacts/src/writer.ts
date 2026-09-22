/**
 * writer.ts — Engine-authorized artifact writer for large/sensitive payloads
 * Source: agent_studio_implementation_plan.md:325-340, 674 (Engine-authorized artifact ref), 1478 (long tool results/transcripts via ArtifactRef)
 * Studio never writes directly to object storage; it requests Engine-authorized claim-check and receives ArtifactRef.
 * For tests, we synthesize refs deterministically with checksums; production path would call Neryva MCP (SaveCheckpointRef / GetRunArtifact).
 */
import {
  validateArtifactRef,
  type StudioArtifactRef,
  type ArtifactPurpose,
  ALLOWED_PURPOSES,
  createArtifactId,
} from './references.js';
import { computeSha256 } from './checksums.js';
import { validateArtifactSize, type SizePolicy, createSizePolicy } from './size-policy.js';
import { computeExpiry, type RetentionClass } from './retention.js';

export interface WriteArtifactOptions {
  organizationId: string;
  runId: string;
  purpose: ArtifactPurpose;
  mediaType: string;
  retentionClass?: RetentionClass;
  expiresAt?: Date;
  encryptionKeyId?: string;
  sizePolicy?: SizePolicy;
}

export async function writeArtifact(
  content: Uint8Array,
  opts: WriteArtifactOptions,
): Promise<StudioArtifactRef> {
  if (!ALLOWED_PURPOSES.has(opts.purpose))
    throw new Error(`purpose not allowlisted: ${opts.purpose}`);
  if (!opts.organizationId) throw new Error('organizationId required');
  if (!opts.runId) throw new Error('runId required');
  if (!opts.mediaType) throw new Error('mediaType required');
  const policy = opts.sizePolicy ?? createSizePolicy();
  validateArtifactSize(content.byteLength, policy);
  const sha256 = computeSha256(content);
  const artifactId = createArtifactId(opts.runId);
  const expiresAt = opts.expiresAt ?? computeExpiry(opts.retentionClass ?? 'STANDARD');
  const ref: StudioArtifactRef = {
    artifactId,
    organizationId: opts.organizationId,
    runId: opts.runId,
    purpose: opts.purpose,
    mediaType: opts.mediaType,
    byteLength: content.byteLength,
    sha256,
    expiresAt,
    encryptionKeyId: opts.encryptionKeyId ?? 'kms-default',
    retentionClass: opts.retentionClass ?? 'STANDARD',
  };
  validateArtifactRef(ref);
  return ref;
}

export async function writeTextArtifact(
  text: string,
  opts: WriteArtifactOptions,
): Promise<StudioArtifactRef> {
  const bytes = new TextEncoder().encode(text);
  return writeArtifact(bytes, opts);
}

export function wrapIfNeeded<T>(
  value: T,
  asBytes: Uint8Array,
  opts: WriteArtifactOptions,
  maxInlineBytes?: number,
): T | StudioArtifactRef {
  const policy = opts.sizePolicy ?? createSizePolicy();
  const threshold = maxInlineBytes ?? policy.maxInlineBytes;
  if (asBytes.byteLength > threshold) {
    throw new Error(
      `wrapIfNeeded: byteLength ${asBytes.byteLength} exceeds inline threshold ${threshold} — must use writeArtifact`,
    );
  }
  return value;
}
