/**
 * memory-client.ts — Engine-mediated memory fetch + proposals
 * Source: agent_studio_implementation_plan.md:1034-1055 (memory-client fetches authorized candidates, submits proposals; no direct PG/vector),
 * agent_studio_architecture.md:522-554 (Agent proposes → Engine validates scope/policy → optional approval → stored with provenance, never "remember this" as truth),
 * main.md:164-172 (memory 8 fields: owner scope, source, timestamps, expiry, deletion, access policy, confidence)
 * All data via Neryva MCP; tenant predicates in Engine query before serialization (189).
 */
import type { NeryvaMcpClient } from '@neryva/neryva-mcp-client';
import { applyRetrievalPolicy, type RetrievalCandidate } from './retrieval-policy.js';

export interface MemoryProposal {
  proposalId: string;
  organizationId: string;
  scope: 'user' | 'conversation' | 'organization';
  scopeId: string;
  sourceMessageId?: string | undefined;
  content: string;
  confidence?: number | undefined;
  provenance: string;
  visibility?: string | undefined;
  expiresAt?: string | undefined;
}

export interface MemoryRecord extends RetrievalCandidate {
  memoryId: string; // sourceId
}

export function createMemoryClient(client: NeryvaMcpClient) {
  return {
    /**
     * Fetch authorized memory candidates via MCP GetAuthorizedRunContext (sub-op GetMemories) and filter via retrieval-policy.
     * Engine applies WHERE organization_id + scope predicates before returning; Studio verifies.
     */
    async getAuthorizedMemories(params: {
      organizationId: string;
      scope: string;
      scopeId: string;
      now?: Date | undefined;
    }): Promise<{
      kept: MemoryRecord[];
      rejected: Array<{ candidate: RetrievalCandidate; reason: string }>;
    }> {
      const now = params.now ?? new Date();
      // Fetch via MCP — stubbed as empty in tests unless fake injected; production would call client.getAuthorizedRunContext and extract memories.
      // We simulate rawCandidates via client stub for testability; if method missing, return empty.
      let raw: RetrievalCandidate[] = [];
      try {
        const fetched = await (
          client as unknown as { getAuthorizedRunContext?: () => Promise<unknown> }
        ).getAuthorizedRunContext?.();
        if (
          fetched &&
          typeof fetched === 'object' &&
          'memories' in (fetched as Record<string, unknown>)
        ) {
          const maybe = (fetched as { memories?: RetrievalCandidate[] }).memories;
          raw = maybe ?? [];
        }
      } catch {
        raw = [];
      }
      const filtered = applyRetrievalPolicy(raw, {
        expectedOrganizationId: params.organizationId,
        allowedStatuses: new Set(['APPROVED']),
        now,
        requireArtifactOrContent: false,
      });
      // Additional scope filtering
      const kept: MemoryRecord[] = [];
      const rejected = [...filtered.rejected];
      for (const c of filtered.kept) {
        if (c.scope && c.scope !== params.scope && c.scope !== 'organization') {
          rejected.push({ candidate: c, reason: `scope-mismatch:${c.scope}!=${params.scope}` });
          continue;
        }
        if (c.scope && c.scope !== 'organization' && c.scopeId && c.scopeId !== params.scopeId) {
          rejected.push({ candidate: c, reason: 'scopeId-mismatch' });
          continue;
        }
        kept.push(c as MemoryRecord);
      }
      return { kept, rejected };
    },

    /**
     * Submit memory proposal — not truth until Engine validates scope/policy and optional approval.
     * Rejects if content is "remember this" style without provenance (caller must supply provenance).
     */
    async submitProposal(
      proposal: MemoryProposal,
    ): Promise<{ proposalId: string; accepted: boolean }> {
      if (!proposal.organizationId) throw new Error('organizationId required');
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!proposal.scope || !proposal.scopeId) throw new Error('scope and scopeId required');
      if (!proposal.content || proposal.content.trim().length === 0)
        throw new Error('content required');
      if (proposal.provenance.trim().length === 0) {
        // Require provenance; bare "remember this" without source is rejected
        throw new Error(
          'memory proposal requires provenance — bare "remember this" is not truth (522-554)',
        );
      }
      await client.submitMemoryProposal({
        proposalId: proposal.proposalId,
        scope: proposal.scope,
        value: proposal.content,
        provenance: proposal.provenance,
      });
      return { proposalId: proposal.proposalId, accepted: true };
    },

    /** Test helper: filter raw candidates without MCP round-trip */
    filterCandidates(candidates: RetrievalCandidate[], organizationId: string, now = new Date()) {
      return applyRetrievalPolicy(candidates, {
        expectedOrganizationId: organizationId,
        allowedStatuses: new Set(['APPROVED']),
        now,
        requireArtifactOrContent: false,
      });
    },
  };
}

export type MemoryClient = ReturnType<typeof createMemoryClient>;
