/**
 * claim-check.ts — bounded claim-check adapter
 * Source: agent_studio_implementation_plan.md:672-687, neryva_mcp_implementation_plan.md:113-115, 595
 * Inline only below threshold/classification; larger/sensitive uses Engine-authorized ArtifactRef.
 * Every read does fresh authorization — ref is not bearer token.
 */

export interface StudioArtifactRef {
  artifactId: string;
  organizationId: string;
  runId: string;
  purpose: string;
  mediaType: string;
  byteLength: number;
  sha256: Uint8Array;
  expiresAt: Date;
  uri?: string;
  encryptionKeyId?: string;
}

const ALLOWED_PURPOSES = new Set([
  'SOURCE_DOCUMENT',
  'CHECKPOINT',
  'TOOL_RESULT',
  'TRANSCRIPT',
  'EXPORT',
  'KNOWLEDGE_CHUNK',
]);

export function validateArtifactRef(ref: StudioArtifactRef): void {
  if (!ref.artifactId || typeof ref.artifactId !== 'string') throw new Error('artifactId required');
  if (!ref.organizationId) throw new Error('organizationId required');
  if (!ref.runId) throw new Error('runId required');
  if (!ALLOWED_PURPOSES.has(ref.purpose))
    throw new Error(`purpose not allowlisted: ${ref.purpose}`);
  if (!ref.mediaType) throw new Error('mediaType required');
  if (ref.byteLength <= 0) throw new Error('byteLength must be >0');
  if (!(ref.sha256 instanceof Uint8Array) || ref.sha256.length !== 32) {
    throw new Error(`sha256 must be 32B, got ${String(ref.sha256)}`);
  }
  if (!(ref.expiresAt instanceof Date) || Number.isNaN(ref.expiresAt.getTime()))
    throw new Error('expiresAt must be valid Date');
  if (ref.expiresAt.getTime() <= Date.now()) throw new Error('artifact expired');
}

export function shouldUseClaimCheck(
  byteLength: number,
  maxInlineBytes: number = 8192,
  classification: string = 'standard',
): boolean {
  if (classification === 'sensitive') return true;
  return byteLength > maxInlineBytes;
}

export function createClaimCheckAdapter(maxInlineBytes: number) {
  return {
    wrap<T>(value: T, ref: StudioArtifactRef): T | StudioArtifactRef {
      // Byte-accurate sizing — JSON.stringify().length counts UTF-16 code units, not bytes
      const json = JSON.stringify(value ?? null);
      const byteLength = Buffer.byteLength(json, 'utf8');
      if (byteLength <= maxInlineBytes) return value;
      validateArtifactRef(ref);
      return ref;
    },
    unwrap<T>(value: T | StudioArtifactRef): T {
      if (
        typeof value === 'object' &&
        value !== null &&
        'artifactId' in (value as Record<string, unknown>)
      ) {
        validateArtifactRef(value as StudioArtifactRef);
        throw new Error(
          'claim-check unwrap requires Engine authorization — not implemented in Phase 2 skeleton',
        );
      }
      return value as T;
    },
  };
}
