/**
 * compiler.ts — Context Compiler (pure, deterministic, fail-closed)
 * Source: agent_studio_architecture.md:464-477, 479, agent_studio_implementation_plan.md:935-956, 943-955, 957-965
 *
 * Responsibilities (464-477):
 * - 466 token budgeting
 * - 467 message ordering
 * - 468 summary insertion
 * - 469 memory selection
 * - 470 retrieval filtering
 * - 471 hybrid retrieval (note)
 * - 472 tool schema selection
 * - 473 provider format conversion
 * - 474 context truncation
 * - 476 prompt-cache prep
 * - 477 citation tracking
 *
 * 11 Steps (943-955):
 * 1 validate scope
 * 2 load immutable def/snapshot
 * 3 select history by conversation sequence (not timestamp)
 * 4 add summaries with source_range/version
 * 5 select approved memories with visibility/expiry
 * 6 retrieve knowledge via MCP (here: select from already-authorized docs)
 * 7 select tools allowed for step+policy
 * 8 reserve token/cost budget
 * 9 deterministic ordering/truncation
 * 10 map to provider format
 * 11 produce citation/source mapping + diagnostics
 *
 * Invariants (957-965) — fail-closed, never truncated unsafe prompt:
 * 958 never retrieve-then-authorize
 * 959 never include expired/deleted/quarantined/unauthorized
 * 960 never let truncation remove system/policy without InsufficientContext
 * 961 never treat model "memory" as approved
 * 962 never depend on provider-managed conversation ID
 * 963 record source IDs/versions not just prompt
 * Final prompt is derived artifact (479), canonical stays in Engine.
 */

import type { CompilerInput, CompilerOptions } from './context-inputs.js';
import { selectHistory } from './history-selector.js';
import { selectSummaries } from './summary-selector.js';
import { selectMemories } from './memory-selector.js';
import { selectKnowledge } from './knowledge-selector.js';
import { selectTools } from './tool-selector.js';
import {
  countTokensHeuristic,
  createBudget,
  reserve,
  toDiagnostics as budgetDiagnostics,
} from './token-budget.js';
import { truncate } from './truncation.js';
import { toProviderFormat } from './provider-format.js';
import {
  createCitationMap,
  createCitation,
  addCitation,
  toDiagnostics as citationDiagnostics,
} from './citations.js';
import type { NeryvaModelRequest } from '@neryva/contracts/provider/model-request';

export interface CompiledContext {
  // Provider-ready request (derived artifact)
  providerRequest: NeryvaModelRequest;
  // Citations (source IDs/versions, hashes/sizes, not raw)
  citations: ReturnType<typeof citationDiagnostics>;
  citationMap: ReturnType<typeof createCitationMap>;
  // Diagnostics (hashes/sizes, not raw)
  diagnostics: {
    history: { selected: number; omitted: number; truncated: boolean };
    summaries: { selected: number; omitted: number };
    memories: { selected: number; rejected: number };
    knowledge: { selected: number; rejected: number };
    tools: { selected: number; rejected: number };
    budget: ReturnType<typeof budgetDiagnostics>;
    truncation:
      | {
          historyOmitted: number;
          summariesOmitted: number;
          memoriesOmitted: number;
          knowledgeOmitted: number;
        }
      | { error: string };
    providerFormat: { messageCount: number; toolCount: number; promptCachePrepared: boolean };
  };
  // For rebuildability: record source IDs/versions
  sources: {
    agentVersionId: string;
    policySnapshotId: string;
    historyIds: string[];
    summaryIds: string[];
    memoryIds: string[];
    knowledgeIds: string[];
    toolIds: string[];
  };
  // Prompt cache key (476)
  promptCacheKey?: string | undefined;
}

export class InsufficientContextError extends Error {
  constructor(
    message: string,
    public readonly diagnostics: CompiledContext['diagnostics'],
  ) {
    super(message);
    this.name = 'InsufficientContext';
  }
}

export function compileContext(input: CompilerInput, opts: CompilerOptions = {}): CompiledContext {
  const countTokens = opts.countTokens ?? countTokensHeuristic;
  // Injectable clock — deterministic for the same (input, now) pair; expiry checks use it
  const now = opts.now ?? new Date();

  // 1. Validate scope — fail-closed if organizationId/conversationId mismatch
  if (!input.organizationId || !input.conversationId || !input.runId || !input.agentVersionId) {
    throw new InsufficientContextError('missing scope', {
      history: { selected: 0, omitted: 0, truncated: false },
      summaries: { selected: 0, omitted: 0 },
      memories: { selected: 0, rejected: 0 },
      knowledge: { selected: 0, rejected: 0 },
      tools: { selected: 0, rejected: 0 },
      budget: budgetDiagnostics(createBudget(input.maxContextTokens)),
      truncation: {
        historyOmitted: 0,
        summariesOmitted: 0,
        memoriesOmitted: 0,
        knowledgeOmitted: 0,
      },
      providerFormat: { messageCount: 0, toolCount: 0, promptCachePrepared: false },
    });
  }

  // 2. Load immutable def/snapshot — validate
  const def = input.agentDefinition;
  if (!def.agent_id || !def.instructions) {
    throw new InsufficientContextError('invalid agent definition', {
      history: { selected: 0, omitted: 0, truncated: false },
      summaries: { selected: 0, omitted: 0 },
      memories: { selected: 0, rejected: 0 },
      knowledge: { selected: 0, rejected: 0 },
      tools: { selected: 0, rejected: 0 },
      budget: budgetDiagnostics(createBudget(input.maxContextTokens)),
      truncation: {
        historyOmitted: 0,
        summariesOmitted: 0,
        memoriesOmitted: 0,
        knowledgeOmitted: 0,
      },
      providerFormat: { messageCount: 0, toolCount: 0, promptCachePrepared: false },
    });
  }

  // Never depend on provider-managed conversation ID (962) — we use Engine's conversationId
  // Record source IDs/versions (963)
  const agentVersionId = input.agentVersionId;
  const policySnapshotId = input.policySnapshot.version ?? 'unknown';

  // 3. Select history by sequence
  const historySel = selectHistory(input.history, {
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    historyLimit: def.context_policy.history_limit,
    currentSequence: input.userMessage.sequence,
  });

  // 4. Add summaries with source_range/version
  const summarySel = selectSummaries(input.summaries, {
    organizationId: input.organizationId,
    conversationId: input.conversationId,
    historySequences: historySel.selected.map((h) => h.sequence),
  });

  // 5. Select approved memories with visibility/expiry (never model "memory" as approved)
  const memorySel = selectMemories(input.memories, {
    organizationId: input.organizationId,
    scope: def.context_policy.memory_scope as 'user' | 'conversation' | 'organization' | 'none',
    scopeId:
      def.context_policy.memory_scope === 'user'
        ? // A4-82: the engine resolves user scope to the run actor's account id;
          // the org-as-proxy fallback keeps legacy tests green but matches nothing
          // real, so a missing userId fails closed (zero user memories selected).
          (input.userId ?? input.organizationId)
        : def.context_policy.memory_scope === 'conversation'
          ? input.conversationId
          : input.organizationId,
    now,
  });

  // 6. Retrieve knowledge via MCP — here: select from already-authorized docs (never retrieve-then-authorize)
  const knowledgeSel = selectKnowledge(input.knowledge, {
    organizationId: input.organizationId,
    allowedSources: def.context_policy.knowledge_sources,
    now,
    maxResults: def.retrieval_policy.knowledge_max_results,
  });

  // 7. Select tools allowed for step+policy
  const toolSel = selectTools(input.availableTools, {
    allowedTools: def.tools,
  });

  // 8. Reserve token/cost budget
  const budget = createBudget(input.maxContextTokens, input.maxOutputTokens ?? 4096);
  // Count mandatory: system + policy + user
  const systemTokens = countTokens(def.instructions);
  const policyTokens = countTokens(JSON.stringify(input.policySnapshot));
  const userTokens = countTokens(input.userMessage.content);
  let reserved = reserve(budget, systemTokens + policyTokens + userTokens);
  // Reserve for selected history/summaries/memories/knowledge (will be checked in truncation)
  const historyTokens = historySel.selected.reduce((a, m) => a + countTokens(m.content), 0);
  const summariesTokens = summarySel.selected.reduce((a, s) => a + countTokens(s.content), 0);
  const memoriesTokens = memorySel.selected.reduce((a, m) => a + countTokens(m.content), 0);
  const knowledgeTokens = knowledgeSel.selected.reduce((a, k) => a + countTokens(k.content), 0);
  reserved = reserve(reserved, historyTokens + summariesTokens + memoriesTokens + knowledgeTokens);
  // Tools
  const toolsTokens = toolSel.selected.reduce(
    (a, t) => a + countTokens(JSON.stringify(t.inputSchema)),
    0,
  );
  reserved = reserve(reserved, toolsTokens);

  // 9. Deterministic ordering/truncation — never remove system/policy without safe failure (960)
  const truncInput = {
    system: def.instructions,
    policy: JSON.stringify(input.policySnapshot),
    history: historySel.selected,
    summaries: summarySel.selected,
    memories: memorySel.selected,
    knowledge: knowledgeSel.selected,
    userMessage: input.userMessage.content,
  };
  const truncResult = truncate(truncInput, { maxTokens: input.maxContextTokens, countTokens });
  if ('error' in truncResult) {
    throw new InsufficientContextError(truncResult.reason, {
      history: {
        selected: historySel.selected.length,
        omitted: historySel.omitted.length,
        truncated: historySel.truncated,
      },
      summaries: { selected: summarySel.selected.length, omitted: summarySel.omitted.length },
      memories: { selected: memorySel.selected.length, rejected: memorySel.rejected.length },
      knowledge: { selected: knowledgeSel.selected.length, rejected: knowledgeSel.rejected.length },
      tools: { selected: toolSel.selected.length, rejected: toolSel.rejected.length },
      budget: budgetDiagnostics(reserved),
      truncation: {
        historyOmitted: 0,
        summariesOmitted: 0,
        memoriesOmitted: 0,
        knowledgeOmitted: 0,
      },
      providerFormat: { messageCount: 0, toolCount: 0, promptCachePrepared: false },
    });
  }

  // 10. Map to provider format
  const formatResult = toProviderFormat(
    {
      system: truncResult.truncated.system,
      policy: truncResult.truncated.policy,
      history: truncResult.truncated.history.map((h) => ({
        role: h.role as 'user' | 'assistant',
        content: h.content,
        sequence: h.sequence,
      })),
      summaries: truncResult.truncated.summaries.map((s) => ({
        content: s.content,
        sourceRange: s.sourceRange,
        version: s.version,
      })),
      memories: truncResult.truncated.memories.map((m) => ({
        content: m.content,
        memoryId: m.memoryId,
      })),
      knowledge: truncResult.truncated.knowledge.map((k) => ({
        content: k.content,
        citation: k.citation,
      })),
      tools: toolSel.selected,
      userMessage: truncResult.truncated.userMessage,
      outputSchema: input.outputSchema,
      providerCapabilities: input.providerCapabilities,
    },
    {
      model: input.agentDefinition.model_policy.allowed_models[0] as string,
      maxOutputTokens: input.maxOutputTokens,
    },
  );

  // 11. Produce citation/source mapping + diagnostics (hashes/sizes, not raw)
  const citationMap = createCitationMap();
  // Add citations for each source
  for (const h of truncResult.truncated.history) {
    addCitation(
      citationMap,
      createCitation({
        sourceId: h.messageId,
        content: h.content,
        citation: `history#${h.sequence}`,
        version: h.sourceVersion ? Number(h.sourceVersion) : undefined,
      }),
    );
  }
  for (const s of truncResult.truncated.summaries) {
    addCitation(
      citationMap,
      createCitation({
        sourceId: s.summaryId,
        content: s.content,
        citation: `summary#v${s.version} ${s.sourceRange.fromSequence}-${s.sourceRange.toSequence}`,
        version: s.version,
      }),
    );
  }
  for (const m of truncResult.truncated.memories) {
    addCitation(
      citationMap,
      createCitation({
        sourceId: m.memoryId,
        content: m.content,
        citation: `memory#${m.memoryId}`,
        version: m.version,
      }),
    );
  }
  for (const k of truncResult.truncated.knowledge) {
    addCitation(
      citationMap,
      createCitation({
        sourceId: k.sourceId,
        documentVersionId: k.documentVersionId,
        chunkId: k.chunkId,
        content: k.content,
        citation: k.citation,
        version: k.version,
      }),
    );
  }
  for (const t of toolSel.selected) {
    addCitation(
      citationMap,
      createCitation({
        sourceId: t.toolId,
        content: JSON.stringify(t.inputSchema),
        citation: `tool#${t.toolId}@${t.version}`,
        version: Number(t.version.split('.')[0] ?? 1),
      }),
    );
  }

  const citations = citationDiagnostics(citationMap);

  return {
    providerRequest: formatResult.request,
    citations,
    citationMap,
    diagnostics: {
      history: {
        selected: truncResult.truncated.history.length,
        omitted: truncResult.omitted.history.length + historySel.omitted.length,
        truncated: historySel.truncated || truncResult.omitted.history.length > 0,
      },
      summaries: {
        selected: truncResult.truncated.summaries.length,
        omitted: truncResult.omitted.summaries.length + summarySel.omitted.length,
      },
      memories: {
        selected: truncResult.truncated.memories.length,
        rejected: memorySel.rejected.length,
      },
      knowledge: {
        selected: truncResult.truncated.knowledge.length,
        rejected: knowledgeSel.rejected.length,
      },
      tools: { selected: toolSel.selected.length, rejected: toolSel.rejected.length },
      budget: budgetDiagnostics(reserved),
      truncation: truncResult.diagnostics,
      providerFormat: formatResult.diagnostics,
    },
    sources: {
      agentVersionId,
      policySnapshotId,
      historyIds: truncResult.truncated.history.map((h) => h.messageId),
      summaryIds: truncResult.truncated.summaries.map((s) => s.summaryId),
      memoryIds: truncResult.truncated.memories.map((m) => m.memoryId),
      knowledgeIds: truncResult.truncated.knowledge.map((k) => k.sourceId),
      toolIds: toolSel.selected.map((t) => t.toolId),
    },
    promptCacheKey: formatResult.promptCacheKey,
  };
}
