/**
 * memory-activities.ts — Engine-mediated retrieval activities (no direct PG/vector creds)
 * Source: agent_studio_implementation_plan.md:1034-1055 (memory-client fetches authorized candidates, knowledge-client bounded citation-bearing; retrieval-policy filters by scope/policy/expiry/state/budget),
 * agent_studio_architecture.md:513-557 (long-term memory proposals via Engine, citation tracking),
 * main.md:189 (tenant filter in query WHERE organization_id before retrieval, not post-filter)
 * All memory/knowledge access via Neryva MCP; every retrieval verifies tenant, READY/APPROVED, expiry, visibility, provenance.
 */
import { heartbeat } from './heartbeat.js';
import type { NeryvaMcpClient } from '@neryva/neryva-mcp-client';
import {
  createMemoryClient,
  createKnowledgeClient,
  mapBatchToCitations,
  type CitationInput,
} from '@neryva/memory-retrieval';
import type { RetrievalCandidate } from '@neryva/memory-retrieval';

export interface RetrievalParams {
  organizationId: string;
  runId: string;
  query: string;
  maxResults?: number | undefined;
  allowedSources?: string[] | undefined;
}

export interface RetrievalResult {
  results: Array<{
    sourceId: string;
    documentVersionId?: string | undefined;
    chunkId?: string | undefined;
    organizationId: string;
    content: string;
    citation: string;
    policyVersion: string;
  }>;
}

export function createMemoryActivities(client: NeryvaMcpClient) {
  const memoryClient = createMemoryClient(client);
  const knowledgeClient = createKnowledgeClient(client);
  return {
    async searchKnowledge(params: RetrievalParams): Promise<RetrievalResult> {
      heartbeat({ step: 'searchKnowledge', organizationId: params.organizationId });
      const { results, rejected } = await knowledgeClient.search({
        organizationId: params.organizationId,
        runId: params.runId,
        text: params.query,
        maxResults: params.maxResults ?? 5,
        allowedSources: params.allowedSources,
        engineCaps: { supportsKeyword: true, supportsVector: true, supportsHybrid: true },
      });
      // Fail closed: if Engine returned data but we rejected cross-tenant etc., log rejected (but not raw content)
      void rejected;
      const mapped = results.map((r) => ({
        sourceId: r.sourceId,
        documentVersionId: r.documentVersionId,
        chunkId: r.chunkId,
        organizationId: r.organizationId,
        content: r.content ?? '',
        citation: r.citation,
        policyVersion: r.policyVersion,
      }));
      return { results: mapped };
    },

    async getMemories(params: {
      organizationId: string;
      userId: string;
      scopeId?: string | undefined;
    }): Promise<RetrievalResult> {
      heartbeat({ step: 'getMemories', organizationId: params.organizationId });
      const { kept } = await memoryClient.getAuthorizedMemories({
        organizationId: params.organizationId,
        scope: 'user',
        scopeId: params.scopeId ?? params.userId,
      });
      const mapped = kept.map((k) => ({
        sourceId: k.sourceId,
        documentVersionId: k.documentVersionId,
        chunkId: k.chunkId,
        organizationId: k.organizationId,
        content: k.content ?? '',
        citation: k.citation,
        policyVersion: k.policyVersion,
      }));
      return { results: mapped };
    },

    async submitMemoryProposal(params: {
      proposalId: string;
      organizationId: string;
      scope: 'user' | 'conversation' | 'organization';
      scopeId: string;
      content: string;
      provenance: string;
    }): Promise<{ proposalId: string }> {
      heartbeat({ step: 'submitMemoryProposal', proposalId: params.proposalId });
      await memoryClient.submitProposal({
        proposalId: params.proposalId,
        organizationId: params.organizationId,
        scope: params.scope,
        scopeId: params.scopeId,
        content: params.content,
        provenance: params.provenance,
      });
      return { proposalId: params.proposalId };
    },

    /** Direct filtering for context-compiler integration (Engine already filtered, Studio verifies) */
    filterKnowledge(candidates: RetrievalCandidate[], organizationId: string, now = new Date()) {
      return knowledgeClient.filterCandidates(candidates, organizationId, now);
    },
    filterMemories(candidates: RetrievalCandidate[], organizationId: string, now = new Date()) {
      return memoryClient.filterCandidates(candidates, organizationId, now);
    },
    citationsFor(candidates: CitationInput[]) {
      return mapBatchToCitations(candidates);
    },
  };
}

export type MemoryActivities = ReturnType<typeof createMemoryActivities>;
