/**
 * summary-selector.ts — selects summaries with source_range/version
 * Source: agent_studio_architecture.md:212-218, agent_studio_implementation_plan.md:943-955 step 4
 * Summaries are inserted with source_range/version for citation; they are not raw history.
 */

import type { Summary } from './context-inputs.js';

export interface SummarySelection {
  selected: Summary[];
  omitted: Summary[];
}

export function selectSummaries(
  summaries: Summary[],
  options: {
    organizationId: string;
    conversationId: string;
    historySequences: number[]; // sequences of selected history, to avoid overlap
  },
): SummarySelection {
  // Filter by tenant/conversation
  const scoped = summaries.filter(
    (s) =>
      s.organizationId === options.organizationId && s.conversationId === options.conversationId,
  );

  // Sort by sourceRange.fromSequence ascending, then version descending (latest version for same range)
  const sorted = [...scoped].sort((a, b) => {
    if (a.sourceRange.fromSequence !== b.sourceRange.fromSequence)
      return a.sourceRange.fromSequence - b.sourceRange.fromSequence;
    return b.version - a.version;
  });

  // Deduplicate by sourceRange — keep latest version per range
  const byRange = new Map<string, Summary>();
  for (const s of sorted) {
    const key = `${s.sourceRange.fromSequence}-${s.sourceRange.toSequence}`;
    const existing = byRange.get(key);
    if (!existing || s.version > existing.version) byRange.set(key, s);
  }
  const deduped = [...byRange.values()].sort(
    (a, b) => a.sourceRange.fromSequence - b.sourceRange.fromSequence,
  );

  // Only keep summaries that are not overlapped by selected history
  // If summary covers sequences that are all in selected history, it's redundant (history is more detailed)
  // For now, keep all deduped — compiler will order them before history
  // Omit summaries that are entirely before selected history's earliest sequence (already summarized)
  if (options.historySequences.length === 0) {
    return { selected: deduped, omitted: [] };
  }

  const earliestHistory = Math.min(...options.historySequences);
  const selected: Summary[] = [];
  const omitted: Summary[] = [];
  for (const s of deduped) {
    // If summary's toSequence < earliestHistory, it's for older history that's already truncated — keep it as context
    // If summary's fromSequence >= earliestHistory, it's overlapping with selected history — omit (history is fresher)
    if (s.sourceRange.toSequence >= earliestHistory) {
      // Overlapping — prefer history, omit summary unless summary covers gap
      // For determinism, keep summary only if it covers a gap not in history
      const isCovered = options.historySequences.some(
        (seq) => seq >= s.sourceRange.fromSequence && seq <= s.sourceRange.toSequence,
      );
      if (isCovered) omitted.push(s);
      else selected.push(s);
    } else {
      selected.push(s);
    }
  }

  return { selected, omitted };
}
