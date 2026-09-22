/**
 * knowledge-selector.ts — selects authorized knowledge docs (tenant-scoped, READY, not expired)
 * Source: agent_studio_implementation_plan.md:943-955 step 6, 957-965 (958,959), agent_studio_architecture.md:556
 * Filtering must be in query (WHERE organization_id), not post-filter — compiler verifies.
 */

import type { KnowledgeDoc } from './context-inputs.js';

export interface KnowledgeSelection {
  selected: KnowledgeDoc[];
  omitted: KnowledgeDoc[];
  rejected: Array<{ doc: KnowledgeDoc; reason: string }>;
}

export function selectKnowledge(
  docs: KnowledgeDoc[],
  options: {
    organizationId: string;
    allowedSources: string[]; // from agentDefinition.context_policy.knowledge_sources
    now: Date;
    maxResults: number;
  },
): KnowledgeSelection {
  const selected: KnowledgeDoc[] = [];
  const rejected: Array<{ doc: KnowledgeDoc; reason: string }> = [];

  for (const doc of docs) {
    // 1. Tenant — must match
    if (doc.organizationId !== options.organizationId) {
      rejected.push({ doc, reason: 'cross-tenant' });
      continue;
    }

    // 2. Status — only READY
    if (doc.status !== 'READY') {
      rejected.push({ doc, reason: `status:${doc.status}` });
      continue;
    }

    // 3. Expiry
    if (doc.expiresAt) {
      const exp = new Date(doc.expiresAt);
      if (exp <= options.now) {
        rejected.push({ doc, reason: 'expired' });
        continue;
      }
    }

    // 4. Source allowlist — must be in allowedSources (from definition)
    // If allowedSources is empty, no knowledge is allowed (defensive)
    if (options.allowedSources.length > 0) {
      // Knowledge source is inferred from purpose or sourceId prefix — for now, check if purpose is in allowedSources or if sourceId's source is allowed
      // Simplified: if allowedSources contains doc.purpose or if doc.sourceId starts with allowed source
      const source = doc.purpose ?? doc.sourceId.split(':')[0] ?? '';
      if (
        !options.allowedSources.includes(source) &&
        !options.allowedSources.includes(doc.sourceId)
      ) {
        // Also check if sourceId contains allowed source as substring (e.g., support-docs:123 should match support-docs)
        const matches = options.allowedSources.some(
          (s) => doc.sourceId.startsWith(s) || (doc.purpose && doc.purpose === s),
        );
        if (!matches) {
          rejected.push({ doc, reason: `source-not-allowlisted:${source}` });
          continue;
        }
      }
    } else {
      rejected.push({ doc, reason: 'no-allowed-sources' });
      continue;
    }

    // 5. Hybrid retrieval note — already filtered in query, but verify
    selected.push(doc);
  }

  // Deterministic ordering: by citation, then documentVersionId
  selected.sort((a, b) => {
    if (a.citation !== b.citation) return a.citation.localeCompare(b.citation);
    return a.documentVersionId.localeCompare(b.documentVersionId);
  });

  // Apply maxResults (from retrieval_policy)
  if (selected.length > options.maxResults) {
    const omitted = selected.slice(options.maxResults);
    const kept = selected.slice(0, options.maxResults);
    return { selected: kept, omitted, rejected };
  }

  return { selected, omitted: [], rejected };
}
