/**
 * ordering.test.ts — history by sequence, summaries with source_range/version, deterministic ordering
 * Source: ledger 5.2, agent_studio_architecture.md:212-218, 467
 */

import { describe, it, expect } from 'vitest';
import { selectHistory } from '../src/history-selector.js';
import { selectSummaries } from '../src/summary-selector.js';
import { selectMemories } from '../src/memory-selector.js';
import { selectKnowledge } from '../src/knowledge-selector.js';
import { selectTools } from '../src/tool-selector.js';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';

describe('ordering', () => {
  it('history ordering by sequence, not timestamp', () => {
    const history = [
      {
        messageId: 'm3',
        organizationId: 'org1',
        conversationId: 'conv1',
        sequence: 3,
        role: 'assistant' as const,
        content: 'third',
        createdAt: '2024-01-03T00:00:00Z',
      },
      {
        messageId: 'm1',
        organizationId: 'org1',
        conversationId: 'conv1',
        sequence: 1,
        role: 'user' as const,
        content: 'first',
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        messageId: 'm2',
        organizationId: 'org1',
        conversationId: 'conv1',
        sequence: 2,
        role: 'user' as const,
        content: 'second',
        createdAt: '2024-01-02T00:00:00Z',
      },
    ];
    const sel = selectHistory(history, {
      organizationId: 'org1',
      conversationId: 'conv1',
      historyLimit: 10,
      currentSequence: 10,
    });
    expect(sel.selected.map((m) => m.sequence)).toEqual([1, 2, 3]);
  });

  it('history respects history_limit most recent', () => {
    const history = Array.from({ length: 5 }, (_, i) => ({
      messageId: `m${i}`,
      organizationId: 'org1',
      conversationId: 'conv1',
      sequence: i + 1,
      role: 'user' as const,
      content: `msg${i}`,
      createdAt: new Date().toISOString(),
    }));
    const sel = selectHistory(history, {
      organizationId: 'org1',
      conversationId: 'conv1',
      historyLimit: 2,
      currentSequence: 10,
    });
    expect(sel.selected.length).toBe(2);
    expect(sel.selected[0]?.sequence).toBe(4);
    expect(sel.omitted.length).toBe(3);
  });

  it('summary selection with source_range/version dedup', () => {
    const summaries = [
      {
        summaryId: 's1',
        organizationId: 'org1',
        conversationId: 'conv1',
        sourceRange: { fromSequence: 1, toSequence: 5 },
        version: 1,
        content: 'old',
        createdAt: '2024-01-01T00:00:00Z',
      },
      {
        summaryId: 's2',
        organizationId: 'org1',
        conversationId: 'conv1',
        sourceRange: { fromSequence: 1, toSequence: 5 },
        version: 2,
        content: 'new',
        createdAt: '2024-01-02T00:00:00Z',
      },
    ];
    const sel = selectSummaries(summaries, {
      organizationId: 'org1',
      conversationId: 'conv1',
      historySequences: [6, 7],
    });
    expect(sel.selected.length).toBe(1);
    expect(sel.selected[0]?.version).toBe(2);
  });

  it('memory selection deterministic by createdAt then memoryId', () => {
    const now = new Date('2024-01-10T00:00:00Z');
    const memories = [
      {
        memoryId: 'mem2',
        organizationId: 'org1',
        scope: 'user' as const,
        scopeId: 'org1',
        content: 'b',
        visibility: 'private' as const,
        status: 'APPROVED' as const,
        createdAt: '2024-01-02T00:00:00Z',
        version: 1,
      },
      {
        memoryId: 'mem1',
        organizationId: 'org1',
        scope: 'user' as const,
        scopeId: 'org1',
        content: 'a',
        visibility: 'private' as const,
        status: 'APPROVED' as const,
        createdAt: '2024-01-01T00:00:00Z',
        version: 1,
      },
    ];
    const sel = selectMemories(memories, {
      organizationId: 'org1',
      scope: 'user',
      scopeId: 'org1',
      now,
    });
    expect(sel.selected[0]?.memoryId).toBe('mem1');
  });

  it('knowledge selection deterministic by citation', () => {
    const now = new Date('2024-01-10T00:00:00Z');
    const docs = [
      {
        sourceId: 'doc2',
        documentVersionId: 'v1',
        organizationId: 'org1',
        content: 'b',
        citation: 'b',
        status: 'READY' as const,
        createdAt: new Date().toISOString(),
        version: 1,
      },
      {
        sourceId: 'doc1',
        documentVersionId: 'v1',
        organizationId: 'org1',
        content: 'a',
        citation: 'a',
        status: 'READY' as const,
        createdAt: new Date().toISOString(),
        version: 1,
      },
    ];
    const sel = selectKnowledge(docs, {
      organizationId: 'org1',
      allowedSources: ['doc1', 'doc2'],
      now,
      maxResults: 10,
    });
    expect(sel.selected[0]?.citation).toBe('a');
  });

  it('tool selection deterministic by toolId', () => {
    const sel = selectTools([...DEFAULT_TOOL_DESCRIPTORS].reverse(), {
      allowedTools: [
        { name: 'search_tickets', access: 'read' },
        { name: 'create_ticket', access: 'write', approval: 'required' },
      ],
    });
    expect(sel.selected[0]?.toolId).toBe('create_ticket');
    expect(sel.selected[1]?.toolId).toBe('search_tickets');
  });
});
