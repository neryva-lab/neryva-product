/**
 * truncation.ts — deterministic truncation (never remove system/policy constraints without safe failure)
 * Source: agent_studio_architecture.md:474, agent_studio_implementation_plan.md:957-965 (960)
 * Ordering is deterministic; system/policy messages are never truncated without InsufficientContext error.
 */

import type { HistoryMessage } from './context-inputs.js';
import type { Summary } from './context-inputs.js';
import type { Memory } from './context-inputs.js';
import type { KnowledgeDoc } from './context-inputs.js';

export interface TruncationInput {
  system: string; // agent instructions (never truncated without safe failure)
  policy: string; // policy summary (never truncated without safe failure)
  history: HistoryMessage[];
  summaries: Summary[];
  memories: Memory[];
  knowledge: KnowledgeDoc[];
  userMessage: string;
}

export interface TruncationResult {
  truncated: TruncationInput;
  omitted: {
    history: HistoryMessage[];
    summaries: Summary[];
    memories: Memory[];
    knowledge: KnowledgeDoc[];
  };
  diagnostics: {
    historyOmitted: number;
    summariesOmitted: number;
    memoriesOmitted: number;
    knowledgeOmitted: number;
    wouldRemoveSystem: boolean;
  };
}

export function truncate(
  input: TruncationInput,
  budget: { maxTokens: number; countTokens: (text: string) => number },
): TruncationResult | { error: 'InsufficientContext'; reason: string } {
  const count = budget.countTokens;

  // System and policy are mandatory — if they alone exceed budget, fail-closed
  const systemTokens = count(input.system);
  const policyTokens = count(input.policy);
  const userTokens = count(input.userMessage);
  const mandatory = systemTokens + policyTokens + userTokens;

  if (mandatory > budget.maxTokens) {
    return {
      error: 'InsufficientContext',
      reason: `mandatory content ${mandatory} > maxTokens ${budget.maxTokens} — cannot truncate system/policy without safe failure`,
    };
  }

  let remaining = budget.maxTokens - mandatory;

  // Order for truncation (least important first): knowledge, memories, summaries, history
  // History is truncated from oldest (deterministic)
  const historyTokens = input.history.map((m) => count(m.content));
  const totalHistory = historyTokens.reduce((a, b) => a + b, 0);
  const summariesTokens = input.summaries.map((s) => count(s.content));
  const totalSummaries = summariesTokens.reduce((a, b) => a + b, 0);
  const memoriesTokens = input.memories.map((m) => count(m.content));
  const totalMemories = memoriesTokens.reduce((a, b) => a + b, 0);
  const knowledgeTokens = input.knowledge.map((k) => count(k.content));
  const totalKnowledge = knowledgeTokens.reduce((a, b) => a + b, 0);

  const totalOptional = totalHistory + totalSummaries + totalMemories + totalKnowledge;

  if (totalOptional <= remaining) {
    return {
      truncated: input,
      omitted: { history: [], summaries: [], memories: [], knowledge: [] },
      diagnostics: {
        historyOmitted: 0,
        summariesOmitted: 0,
        memoriesOmitted: 0,
        knowledgeOmitted: 0,
        wouldRemoveSystem: false,
      },
    };
  }

  // Need to truncate — deterministic: remove from least important first, then oldest history
  let knowledgeOmitted: KnowledgeDoc[] = [];
  let memoriesOmitted: Memory[] = [];
  let summariesOmitted: Summary[] = [];
  let historyOmitted: HistoryMessage[] = [];

  let knowledgeKept = [...input.knowledge];
  let memoriesKept = [...input.memories];
  let summariesKept = [...input.summaries];
  let historyKept = [...input.history];

  // 1. Knowledge (least important)
  if (totalKnowledge > 0) {
    // Sort knowledge by citation (already sorted) — truncate from end (least relevant last)
    while (
      knowledgeKept.length > 0 &&
      totalOptional - (totalKnowledge - knowledgeKept.reduce((a, k) => a + count(k.content), 0)) >
        remaining
    ) {
      const removed = knowledgeKept.pop();
      if (removed) knowledgeOmitted.unshift(removed);
    }
    const keptKnowledgeTokens = knowledgeKept.reduce((a, k) => a + count(k.content), 0);
    remaining =
      budget.maxTokens -
      mandatory -
      keptKnowledgeTokens -
      totalMemories -
      totalSummaries -
      totalHistory;
    // Actually we need to recompute iteratively — simpler: truncate stepwise
  }

  // Simpler deterministic truncation: iterate in priority order, removing until fits
  // Priority: knowledge (first to remove), then memories, then summaries, then history (oldest first)
  const allOptionalTokens = totalKnowledge + totalMemories + totalSummaries + totalHistory;
  if (allOptionalTokens > remaining + totalOptional - remaining) {
    // We already handled knowledge above, but for simplicity, do stepwise:
  }

  // For determinism and simplicity, implement stepwise removal:
  // Reset and do proper stepwise
  knowledgeKept = [...input.knowledge];
  memoriesKept = [...input.memories];
  summariesKept = [...input.summaries];
  historyKept = [...input.history];
  knowledgeOmitted = [];
  memoriesOmitted = [];
  summariesOmitted = [];
  historyOmitted = [];

  let currentTokens = totalKnowledge + totalMemories + totalSummaries + totalHistory;

  // Remove knowledge first (from end, least relevant)
  while (currentTokens > remaining && knowledgeKept.length > 0) {
    const removed = knowledgeKept.pop();
    if (removed) {
      knowledgeOmitted.unshift(removed);
      currentTokens -= count(removed.content);
    }
  }

  // Then memories (oldest first? memories are already sorted by createdAt, so remove from oldest? Actually remove from end (oldest last? Let's remove from end for determinism)
  while (currentTokens > remaining && memoriesKept.length > 0) {
    const removed = memoriesKept.pop();
    if (removed) {
      memoriesOmitted.unshift(removed);
      currentTokens -= count(removed.content);
    }
  }

  // Then summaries (oldest first? summaries sorted by fromSequence, remove from start (oldest) or end? Remove from end (most recent summary last, but history is more important, so summaries are less important than history? Actually summaries are more important than history's oldest, so we should keep summaries and remove history first? Let's keep summaries and remove history first — but we already removed knowledge/memories, now remove history oldest first)
  // For now, remove summaries from end
  while (currentTokens > remaining && summariesKept.length > 0) {
    const removed = summariesKept.pop();
    if (removed) {
      summariesOmitted.unshift(removed);
      currentTokens -= count(removed.content);
    }
  }

  // Finally history — remove from oldest (first in array, which is earliest sequence)
  while (currentTokens > remaining && historyKept.length > 0) {
    const removed = historyKept.shift();
    if (removed) {
      historyOmitted.push(removed);
      currentTokens -= count(removed.content);
    }
  }

  if (currentTokens > remaining) {
    // Still over — would need to remove system/policy, which is not allowed
    return {
      error: 'InsufficientContext',
      reason: `even after truncating all optional, still ${currentTokens} > ${remaining} — mandatory too large`,
    };
  }

  return {
    truncated: {
      system: input.system,
      policy: input.policy,
      history: historyKept,
      summaries: summariesKept,
      memories: memoriesKept,
      knowledge: knowledgeKept,
      userMessage: input.userMessage,
    },
    omitted: {
      history: historyOmitted,
      summaries: summariesOmitted,
      memories: memoriesOmitted,
      knowledge: knowledgeOmitted,
    },
    diagnostics: {
      historyOmitted: historyOmitted.length,
      summariesOmitted: summariesOmitted.length,
      memoriesOmitted: memoriesOmitted.length,
      knowledgeOmitted: knowledgeOmitted.length,
      wouldRemoveSystem: false,
    },
  };
}
