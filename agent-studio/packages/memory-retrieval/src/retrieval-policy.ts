/**
 * retrieval-policy.ts — filtering by scope, policy, expiry, source state, budget
 * Source: agent_studio_implementation_plan.md:1034-1055 (retrieval-policy filters by scope/policy/expiry/source state/budget),
 * 1042-1055 (each result: source_id/document_version_id/chunk_id, organization/visibility scope, relevance, bounded content or ArtifactRef, citation, policy version; fail-closed if Engine omits scope/provenance),
 * agent_studio_architecture.md:556 (filter in query WHERE organization_id, not post-filter)
 * Studio must not accept unscoped results; fail closed if scope/provenance missing.
 */
import type { StudioArtifactRef } from '@neryva/artifacts';

export interface RetrievalCandidate {
  sourceId: string; // document id / memory id
  documentVersionId?: string | undefined;
  chunkId?: string | undefined;
  organizationId: string;
  visibility?: 'private' | 'shared' | 'public' | string | undefined;
  scope?: string | undefined;
  scopeId?: string | undefined;
  status: string; // READY, APPROVED, PROCESSING, etc.
  expiresAt?: string | Date | undefined;
  content?: string | undefined;
  artifactRef?: StudioArtifactRef | undefined;
  citation: string;
  sourceRange?: { fromSequence: number; toSequence: number } | undefined;
  policyVersion: string;
  relevance?: number | undefined;
  createdAt?: string | undefined;
  deletedAt?: string | Date | undefined;
  quarantinedAt?: string | Date | undefined;
}

export interface PolicyFilterOptions {
  expectedOrganizationId: string;
  allowedStatuses: Set<string>; // e.g., READY for knowledge, APPROVED for memory
  allowedVisibilities?: Set<string> | undefined;
  now: Date;
  allowedSources?: string[] | undefined; // knowledge_sources allowlist
  requireArtifactOrContent: boolean;
}

export function isExpired(expiresAt: string | Date | undefined, now: Date): boolean {
  if (!expiresAt) return false;
  const exp = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(exp.getTime())) throw new Error('invalid expiresAt');
  return exp.getTime() <= now.getTime();
}

export function applyRetrievalPolicy(
  candidates: RetrievalCandidate[],
  opts: PolicyFilterOptions,
): {
  kept: RetrievalCandidate[];
  rejected: Array<{ candidate: RetrievalCandidate; reason: string }>;
} {
  const kept: RetrievalCandidate[] = [];
  const rejected: Array<{ candidate: RetrievalCandidate; reason: string }> = [];

  for (const c of candidates) {
    // Fail-closed if Engine omits required scope/provenance (1055)
    if (!c.organizationId || typeof c.organizationId !== 'string') {
      rejected.push({ candidate: c, reason: 'missing organizationId — fail closed' });
      continue;
    }
    if (!c.sourceId || typeof c.sourceId !== 'string') {
      rejected.push({ candidate: c, reason: 'missing sourceId — fail closed' });
      continue;
    }
    if (!c.policyVersion) {
      rejected.push({ candidate: c, reason: 'missing policyVersion — fail closed' });
      continue;
    }
    if (!c.citation) {
      rejected.push({ candidate: c, reason: 'missing citation — fail closed' });
      continue;
    }
    // Tenant predicate must be in query (WHERE organization_id), but verify
    if (c.organizationId !== opts.expectedOrganizationId) {
      rejected.push({
        candidate: c,
        reason: `cross-tenant ${c.organizationId} != ${opts.expectedOrganizationId}`,
      });
      continue;
    }
    // Status must be READY/APPROVED
    if (!opts.allowedStatuses.has(c.status)) {
      rejected.push({
        candidate: c,
        reason: `status:${c.status} not in ${[...opts.allowedStatuses].join(',')}`,
      });
      continue;
    }
    // Visibility check if constrained
    if (opts.allowedVisibilities && c.visibility && !opts.allowedVisibilities.has(c.visibility)) {
      rejected.push({ candidate: c, reason: `visibility:${c.visibility} not allowed` });
      continue;
    }
    // Expiry
    if (isExpired(c.expiresAt, opts.now)) {
      rejected.push({ candidate: c, reason: 'expired' });
      continue;
    }
    // Deleted/quarantined
    if (c.deletedAt) {
      rejected.push({ candidate: c, reason: 'deleted' });
      continue;
    }
    if (c.quarantinedAt) {
      rejected.push({ candidate: c, reason: 'quarantined' });
      continue;
    }
    // Must have bounded content or artifactRef
    const hasContent = typeof c.content === 'string' && c.content.length > 0;
    const hasArtifact = Boolean(c.artifactRef);
    if (opts.requireArtifactOrContent && !hasContent && !hasArtifact) {
      rejected.push({ candidate: c, reason: 'missing content and artifactRef' });
      continue;
    }
    // Artifact ref if present must be same tenant and not expired (reader will re-auth, but policy filters early)
    if (c.artifactRef) {
      if (c.artifactRef.organizationId !== opts.expectedOrganizationId) {
        rejected.push({ candidate: c, reason: 'artifact cross-tenant' });
        continue;
      }
      if (c.artifactRef.expiresAt.getTime() <= opts.now.getTime()) {
        rejected.push({ candidate: c, reason: 'artifact expired' });
        continue;
      }
    }
    kept.push(c);
  }

  return { kept, rejected };
}
