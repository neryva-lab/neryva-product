/**
 * reader.ts — claim-check reader with fresh authorization on every read
 * Source: agent_studio_implementation_plan.md:672-687 (fresh auth on read, ref != bearer), 341-352 (checksum-verified, tenant/run scoped, purpose-bound, expiring, re-authorized),
 * 1486 (deletion/expiry makes stale refs unusable)
 * Studio must not treat artifact ref as bearer token; every read verifies scope, expiry, purpose, checksum, deletion/quarantine, and classification.
 */
import { validateArtifactRef, isAuthorizedFor, type StudioArtifactRef } from './references.js';
import { verifyChecksum } from './checksums.js';
import { isStale } from './retention.js';

export interface ReadOptions {
  expectedOrganizationId: string;
  expectedRunId?: string;
  expectedPurpose?: string;
  allowExpired?: boolean;
}

export interface ArtifactStore {
  get(artifactId: string): Promise<
    | {
        content: Uint8Array;
        ref: StudioArtifactRef;
        deletedAt?: Date | undefined;
        quarantinedAt?: Date | undefined;
      }
    | undefined
  >;
}

/**
 * In-memory store for tests; production store would call Engine GetRunArtifact with fresh capability.
 * Reader always re-authorizes: checks tenant/run, expiry, purpose, deleted/quarantined, sha256.
 */
export class ArtifactReader {
  constructor(private readonly store: ArtifactStore) {}

  async read(ref: StudioArtifactRef, opts: ReadOptions): Promise<Uint8Array> {
    // 1. Validate ref shape at boundary (sha256 32B, purpose allowlisted)
    validateArtifactRef(ref);

    // 2. Fresh authorization — tenant/run scope (scope != bearer)
    if (!isAuthorizedFor(ref, opts.expectedOrganizationId, opts.expectedRunId)) {
      throw new Error(
        `artifact read denied: cross-tenant or wrong run ${ref.organizationId}/${ref.runId} != ${opts.expectedOrganizationId}/${opts.expectedRunId ?? '*'}`,
      );
    }

    // 3. Purpose binding
    if (opts.expectedPurpose && ref.purpose !== opts.expectedPurpose) {
      throw new Error(
        `artifact purpose mismatch expected ${opts.expectedPurpose} got ${ref.purpose}`,
      );
    }

    // 4. Expiry / deletion / quarantine — stale refs unusable (1486)
    if (isStale(ref) && !opts.allowExpired) {
      throw new Error(`artifact stale: expired=${ref.expiresAt.toISOString()} deleted/quarantined`);
    }

    // 5. Fetch from store (Engine-authorized path)
    const record = await this.store.get(ref.artifactId);
    if (!record) throw new Error(`artifact not found: ${ref.artifactId}`);
    if (record.deletedAt) throw new Error(`artifact deleted: ${ref.artifactId}`);
    if (record.quarantinedAt) throw new Error(`artifact quarantined: ${ref.artifactId}`);
    if (record.ref.expiresAt.getTime() <= Date.now() && !opts.allowExpired) {
      throw new Error(`artifact expired in store: ${ref.artifactId}`);
    }

    // 6. Cross-check stored ref matches requested ref (tamper detection)
    if (record.ref.organizationId !== ref.organizationId)
      throw new Error('artifact organizationId tamper detected');
    if (record.ref.runId !== ref.runId) throw new Error('artifact runId tamper detected');
    if (record.ref.purpose !== ref.purpose) throw new Error('artifact purpose tamper detected');
    if (record.ref.byteLength !== ref.byteLength)
      throw new Error('artifact byteLength tamper detected');
    if (record.ref.sha256.length !== 32 || ref.sha256.length !== 32)
      throw new Error('sha256 length invalid');
    for (let i = 0; i < 32; i++)
      if (record.ref.sha256[i] !== ref.sha256[i])
        throw new Error('artifact sha256 tamper detected');

    // 7. Checksum verification
    verifyChecksum(record.content, ref.sha256);

    // 8. Byte length consistency
    if (record.content.byteLength !== ref.byteLength)
      throw new Error(
        `byteLength mismatch content ${record.content.byteLength} != ref ${ref.byteLength}`,
      );

    return record.content;
  }

  async readText(ref: StudioArtifactRef, opts: ReadOptions): Promise<string> {
    const bytes = await this.read(ref, opts);
    return new TextDecoder().decode(bytes);
  }
}

export function createInMemoryArtifactStore(): ArtifactStore & {
  put(
    ref: StudioArtifactRef,
    content: Uint8Array,
    meta?: { deletedAt?: Date; quarantinedAt?: Date },
  ): void;
  delete(artifactId: string): void;
  quarantine(artifactId: string): void;
} {
  const map = new Map<
    string,
    {
      content: Uint8Array;
      ref: StudioArtifactRef;
      deletedAt?: Date | undefined;
      quarantinedAt?: Date | undefined;
    }
  >();
  return {
    async get(artifactId: string) {
      return map.get(artifactId);
    },
    put(
      ref: StudioArtifactRef,
      content: Uint8Array,
      meta?: { deletedAt?: Date; quarantinedAt?: Date },
    ) {
      map.set(ref.artifactId, {
        content,
        ref,
        deletedAt: meta?.deletedAt,
        quarantinedAt: meta?.quarantinedAt,
      });
    },
    delete(artifactId: string) {
      const rec = map.get(artifactId);
      if (rec) rec.deletedAt = new Date();
    },
    quarantine(artifactId: string) {
      const rec = map.get(artifactId);
      if (rec) rec.quarantinedAt = new Date();
    },
  };
}
