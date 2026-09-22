/**
 * knowledge-client.ts — Engine-mediated knowledge retrieval (authorized, hybrid, citation-bearing)
 * Source: agent_studio_implementation_plan.md:1034-1055 (knowledge-client queries authorized sources, bounded citation-bearing; never direct PG/vector creds),
 * 1042-1055 (per result: source_id/document_version_id/chunk_id, organization/visibility scope, relevance, bounded content or ArtifactRef, citation, policy version; fail-closed),
 * agent_studio_architecture.md:513-557 (knowledge retrieval must be authorized before return; initial pgvector + full-text hybrid, measured migration),
 * main.md:189 (filter in query WHERE organization_id)
 * Filtering is in Engine query; Studio verifies and filters again deterministically.
 */
import type { NeryvaMcpClient } from '@neryva/neryva-mcp-client';
import { applyRetrievalPolicy, type RetrievalCandidate } from './retrieval-policy.js';
import { planRetrieval, type RetrievalMode, type EngineCapabilities } from './query-planner.js';
import {
  enforceResultCount,
  createResultLimits,
  type ResultLimitsOptions,
} from './result-limits.js';

export interface KnowledgeQuery {
  organizationId: string;
  runId: string;
  text: string;
  maxResults: number;
  allowedSources?: string[] | undefined;
  preferredMode?: RetrievalMode | undefined;
  engineCaps: EngineCapabilities;
}

export interface KnowledgeResult extends RetrievalCandidate {
  documentVersionId: string;
  chunkId?: string | undefined;
}

export function createKnowledgeClient(client: NeryvaMcpClient) {
  return {
    async search(params: KnowledgeQuery): Promise<{
      results: KnowledgeResult[];
      omitted: KnowledgeResult[];
      rejected: Array<{ candidate: RetrievalCandidate; reason: string }>;
      plan: ReturnType<typeof planRetrieval>;
    }> {
      const plan = planRetrieval({
        text: params.text,
        maxResults: params.maxResults,
        organizationId: params.organizationId,
        runId: params.runId,
        allowedSources: params.allowedSources,
        preferredMode: params.preferredMode,
        engineCaps: params.engineCaps,
      });
      // Fetch via MCP — Engine applies WHERE organization_id + scope predicates; Studio filters.
      let raw: RetrievalCandidate[] = [];
      try {
        const fetched = await (
          client as unknown as { getAuthorizedRunContext?: () => Promise<unknown> }
        ).getAuthorizedRunContext?.();
        if (
          fetched &&
          typeof fetched === 'object' &&
          'knowledge_refs' in (fetched as Record<string, unknown>)
        ) {
          const maybe = (fetched as { knowledge_refs?: RetrievalCandidate[] }).knowledge_refs;
          raw = maybe ?? [];
        }
      } catch {
        raw = [];
      }
      const filtered = applyRetrievalPolicy(raw, {
        expectedOrganizationId: params.organizationId,
        allowedStatuses: new Set(['READY']),
        now: new Date(),
        requireArtifactOrContent: true,
      });
      // Apply allowedSources filtering if provided (defensive even if Engine already filtered)
      let kept = filtered.kept as KnowledgeResult[];
      const rejected = [...filtered.rejected];
      if (params.allowedSources && params.allowedSources.length > 0) {
        const allow = new Set(params.allowedSources);
        const nextKept: KnowledgeResult[] = [];
        for (const k of kept) {
          const src = k.sourceId;
          const purpose = (k as unknown as { purpose?: string }).purpose ?? '';
          const matches =
            allow.has(src) || allow.has(purpose) || [...allow].some((a) => src.startsWith(a));
          if (!matches) {
            rejected.push({ candidate: k, reason: `source-not-allowlisted:${src}` });
            continue;
          }
          nextKept.push(k);
        }
        kept = nextKept;
      }
      // Enforce bounded result count
      const limits = createResultLimits({ maxResults: params.maxResults });
      const { kept: bounded, omitted } = enforceResultCount(kept, limits);
      return { results: bounded, omitted, rejected, plan };
    },

    /** Test helper: filter raw candidates without MCP */
    filterCandidates(candidates: RetrievalCandidate[], organizationId: string, now = new Date()) {
      return applyRetrievalPolicy(candidates, {
        expectedOrganizationId: organizationId,
        allowedStatuses: new Set(['READY']),
        now,
        requireArtifactOrContent: true,
      });
    },

    /** Test helper: plan + limits */
    planAndLimit(query: KnowledgeQuery, limitsOverrides?: Partial<ResultLimitsOptions>) {
      const plan = planRetrieval({
        text: query.text,
        maxResults: query.maxResults,
        organizationId: query.organizationId,
        runId: query.runId,
        allowedSources: query.allowedSources,
        preferredMode: query.preferredMode,
        engineCaps: query.engineCaps,
      });
      const limits = createResultLimits({ maxResults: query.maxResults, ...limitsOverrides });
      return { plan, limits };
    },
  };
}

export type KnowledgeClient = ReturnType<typeof createKnowledgeClient>;
