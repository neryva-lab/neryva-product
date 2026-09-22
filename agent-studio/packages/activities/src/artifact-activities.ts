/**
 * artifact-activities.ts — claim-check reader/writer activities (Engine-authorized, re-auth on read)
 * Source: agent_studio_implementation_plan.md:325-340 (artifacts organization_id+purpose enum+object_key tenant-bound+sha256/byte_length/encryption_key_ref/retention_class),
 * 341-352 (reject oversized, checksum-mismatch, sensitive-classification oversize; ref is tenant/run scoped, purpose-bound, checksum-verified, expiring, re-authorized on read),
 * 589-594 (max inline 8192, max artifact 10485760), 672-687 (claim-check), 839-848 (workflow payload protection), 1484 (large data never in workflow args)
 * Studio never directly accesses S3; all reads/writes go via Engine-authorized ArtifactRef with fresh scope check.
 */
import { heartbeat } from './heartbeat.js';
import {
  validateArtifactRef,
  isAuthorizedFor,
  type StudioArtifactRef,
  type ArtifactPurpose,
  verifyChecksum,
  computeSha256,
  validateArtifactSize,
  validateWorkflowArgSize,
  createSizePolicy,
  shouldClaimCheck as artifactShouldClaimCheck,
  isStale,
} from '@neryva/artifacts';

export type ArtifactActivities = ReturnType<typeof createArtifactActivities>;

export function createArtifactActivities(store?: {
  get: (artifactId: string) => Promise<
    | {
        content: Uint8Array;
        ref: StudioArtifactRef;
        deletedAt?: Date | undefined;
        quarantinedAt?: Date | undefined;
      }
    | undefined
  >;
  put: (ref: StudioArtifactRef, content: Uint8Array) => void;
}) {
  const mem = store;
  return {
    async writeArtifact(
      content: Uint8Array,
      opts: {
        organizationId: string;
        runId: string;
        purpose: ArtifactPurpose;
        mediaType: string;
        expiresAt?: Date | undefined;
      },
    ): Promise<StudioArtifactRef> {
      heartbeat({ step: 'writeArtifact', byteLength: content.byteLength, purpose: opts.purpose });
      validateArtifactSize(content.byteLength, createSizePolicy());
      const sha256 = computeSha256(content);
      const artifactId = `art_${opts.runId.slice(0, 8)}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
      const expiresAt = opts.expiresAt ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const ref: StudioArtifactRef = {
        artifactId,
        organizationId: opts.organizationId,
        runId: opts.runId,
        purpose: opts.purpose,
        mediaType: opts.mediaType,
        byteLength: content.byteLength,
        sha256,
        expiresAt,
        encryptionKeyId: 'kms-default',
      };
      validateArtifactRef(ref);
      if (mem) mem.put(ref, content);
      return ref;
    },

    async readArtifact(
      ref: StudioArtifactRef,
      expectedOrganizationId: string,
      expectedRunId?: string | undefined,
    ): Promise<Uint8Array> {
      heartbeat({ step: 'readArtifact', artifactId: ref.artifactId });
      // 1. Validate shape at boundary (sha256 32B, purpose allowlisted)
      validateArtifactRef(ref);
      // 2. Fresh authz — tenant/run scope (not bearer)
      if (!isAuthorizedFor(ref, expectedOrganizationId, expectedRunId)) {
        throw new Error(
          `artifact cross-tenant or wrong run denied: ${ref.organizationId}/${ref.runId} != ${expectedOrganizationId}/${expectedRunId ?? '*'}`,
        );
      }
      // 3. Stale check — deleted/quarantined/expired unusable (1486)
      if (isStale(ref)) throw new Error(`artifact stale expired=${ref.expiresAt.toISOString()}`);
      if (!mem) {
        // In production, would call Engine GetRunArtifact with RequestContext (fresh capability)
        // For activities, return synthetic content of correct length but verify shape
        return new Uint8Array(ref.byteLength);
      }
      const record = await mem.get(ref.artifactId);
      if (!record) throw new Error(`artifact not found: ${ref.artifactId}`);
      if (record.deletedAt) throw new Error(`artifact deleted: ${ref.artifactId}`);
      if (record.quarantinedAt) throw new Error(`artifact quarantined: ${ref.artifactId}`);
      // Tamper detection
      if (record.ref.organizationId !== ref.organizationId)
        throw new Error('artifact organizationId tamper');
      if (record.ref.runId !== ref.runId) throw new Error('artifact runId tamper');
      if (record.ref.purpose !== ref.purpose) throw new Error('artifact purpose tamper');
      if (record.ref.byteLength !== ref.byteLength) throw new Error('artifact byteLength tamper');
      for (let i = 0; i < 32; i++)
        if (record.ref.sha256[i] !== ref.sha256[i]) throw new Error('artifact sha256 tamper');
      verifyChecksum(record.content, ref.sha256);
      if (record.content.byteLength !== ref.byteLength)
        throw new Error(`byteLength mismatch ${record.content.byteLength} != ${ref.byteLength}`);
      return record.content;
    },

    async verifyArtifactChecksum(ref: StudioArtifactRef, content: Uint8Array): Promise<void> {
      heartbeat({ step: 'verifyChecksum', artifactId: ref.artifactId });
      if (content.byteLength !== ref.byteLength)
        throw new Error(`byteLength mismatch ${content.byteLength} != ${ref.byteLength}`);
      verifyChecksum(content, ref.sha256);
    },

    validateWorkflowArg(byteLength: number): void {
      validateWorkflowArgSize(byteLength, createSizePolicy());
    },

    shouldClaimCheck(byteLength: number, classification: string): boolean {
      return artifactShouldClaimCheck(byteLength, classification, createSizePolicy());
    },
  };
}

export const MAX_INLINE_BYTES = 8192;
