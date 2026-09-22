/**
 * history-selector.ts — selects history by conversation sequence (not timestamp)
 * Source: agent_studio_implementation_plan.md:943-955 step 3, agent_studio_architecture.md:212-218
 * Ordering is deterministic: sorted by sequence ascending, then truncated from oldest.
 */

import type { HistoryMessage } from './context-inputs.js';

export interface HistorySelection {
  selected: HistoryMessage[];
  omitted: HistoryMessage[]; // for diagnostics (hashes/sizes, not raw)
  truncated: boolean;
}

export function selectHistory(
  history: HistoryMessage[],
  options: {
    organizationId: string;
    conversationId: string;
    historyLimit: number;
    currentSequence: number; // userMessage.sequence
  },
): HistorySelection {
  // 1. Filter by tenant/conversation (defense in depth — even though Engine already scoped)
  const scoped = history.filter(
    (m) =>
      m.organizationId === options.organizationId && m.conversationId === options.conversationId,
  );

  // 2. Sort by sequence ascending (deterministic, not timestamp)
  const sorted = [...scoped].sort((a, b) => a.sequence - b.sequence);

  // 3. Only include messages before current user message (sequence < currentSequence)
  //    Current user message will be appended last
  const beforeCurrent = sorted.filter((m) => m.sequence < options.currentSequence);

  // 4. Apply history_limit — take most recent N
  if (beforeCurrent.length <= options.historyLimit) {
    return { selected: beforeCurrent, omitted: [], truncated: false };
  }

  const omitted = beforeCurrent.slice(0, beforeCurrent.length - options.historyLimit);
  const selected = beforeCurrent.slice(beforeCurrent.length - options.historyLimit);
  return { selected, omitted, truncated: true };
}
