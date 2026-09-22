/**
 * query-planner.ts — keyword/vector/hybrid mode selection supported by Engine
 * Source: agent_studio_implementation_plan.md:1039 (query-planner selects keyword/vector/hybrid supported by Engine),
 * 938 (hybrid where improves recall), agent_studio_architecture.md:471 (hybrid retrieval combining vector + lexical), 556 (pgvector + full-text hybrid initially)
 * Planner is deterministic and does not bypass tenant predicates; Engine applies WHERE organization_id.
 */

export type RetrievalMode = 'keyword' | 'vector' | 'hybrid';
export type EngineCapabilities = {
  supportsKeyword: boolean;
  supportsVector: boolean;
  supportsHybrid: boolean;
};

export interface QueryPlan {
  mode: RetrievalMode;
  query: string;
  maxResults: number;
  filters: {
    organizationId: string;
    runId?: string | undefined;
    allowedSources?: string[] | undefined;
    visibility?: string[] | undefined;
  };
  reason: string;
}

export function planRetrieval(query: {
  text: string;
  maxResults: number;
  organizationId: string;
  runId?: string | undefined;
  allowedSources?: string[] | undefined;
  preferredMode?: RetrievalMode | undefined;
  engineCaps: EngineCapabilities;
}): QueryPlan {
  if (!query.text || typeof query.text !== 'string') throw new Error('query text required');
  if (!query.organizationId) throw new Error('organizationId required');
  if (query.maxResults <= 0 || query.maxResults > 20) throw new Error('maxResults must be 1..20');
  // Deterministic mode selection
  let mode: RetrievalMode;
  let reason: string;
  if (query.preferredMode && isModeSupported(query.preferredMode, query.engineCaps)) {
    mode = query.preferredMode;
    reason = `preferred ${mode} supported`;
  } else if (query.engineCaps.supportsHybrid) {
    mode = 'hybrid';
    reason = 'hybrid improves recall, Engine supports hybrid (full-text + pgvector)';
  } else if (query.engineCaps.supportsVector) {
    mode = 'vector';
    reason = 'vector supported, hybrid unavailable';
  } else if (query.engineCaps.supportsKeyword) {
    mode = 'keyword';
    reason = 'keyword only';
  } else {
    throw new Error('Engine reports no retrieval modes');
  }
  return {
    mode,
    query: query.text,
    maxResults: query.maxResults,
    filters: {
      organizationId: query.organizationId,
      runId: query.runId,
      allowedSources: query.allowedSources,
      visibility: undefined,
    },
    reason,
  };
}

function isModeSupported(mode: RetrievalMode, caps: EngineCapabilities): boolean {
  if (mode === 'hybrid') return caps.supportsHybrid;
  if (mode === 'vector') return caps.supportsVector;
  return caps.supportsKeyword;
}
