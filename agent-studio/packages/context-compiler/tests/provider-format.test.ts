/**
 * provider-format.test.ts — mapping to NeryvaModelRequest for first provider (openai)
 * Source: ledger 5.3, agent_studio_architecture.md:472-473, 476
 */

import { describe, it, expect } from 'vitest';
import { toProviderFormat } from '../src/provider-format.js';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';

describe('provider-format', () => {
  it('maps to NeryvaModelRequest with system first, user last', () => {
    const res = toProviderFormat(
      {
        system: 'You are helpful',
        policy: 'org1',
        history: [{ role: 'user', content: 'hi', sequence: 1 }],
        summaries: [],
        memories: [],
        knowledge: [],
        tools: [...DEFAULT_TOOL_DESCRIPTORS],
        userMessage: 'hello',
      },
      { model: 'openai/gpt-4o-mini' },
    );
    expect(res.request.messages[0]?.role).toBe('system');
    expect(res.request.messages[0]?.content).toBe('You are helpful');
    expect(res.request.messages[res.request.messages.length - 1]?.content).toBe('hello');
    // 1:1 mapping — every descriptor becomes exactly one provider tool, no
    // drops, no extras. (Count is derived from the registry, not hardcoded:
    // TPL-3.2 added the platform built-ins to DEFAULT_TOOL_DESCRIPTORS, which
    // broke the old literal expectation of 2.)
    expect(res.request.tools?.length).toBe(DEFAULT_TOOL_DESCRIPTORS.length);
    expect(res.diagnostics.toolCount).toBe(DEFAULT_TOOL_DESCRIPTORS.length);
    // FL-2.15: deterministic ordering — sorted by toolId for a byte-stable
    // provider prefix, independent of registry order.
    const sortedIds = [...DEFAULT_TOOL_DESCRIPTORS]
      .map((d) => d.toolId)
      .sort((a, b) => a.localeCompare(b));
    expect(res.request.tools?.map((t) => t.name)).toEqual(sortedIds);
  });

  it('includes summaries with source_range/version', () => {
    const res = toProviderFormat(
      {
        system: 'sys',
        policy: 'pol',
        history: [],
        summaries: [
          { content: 'summary', sourceRange: { fromSequence: 1, toSequence: 5 }, version: 2 },
        ],
        memories: [],
        knowledge: [],
        tools: [],
        userMessage: 'hi',
      },
      { model: 'openai/gpt-4o-mini' },
    );
    const summaryMsg = res.request.messages.find((m) => m.content.includes('Summary v2'));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg?.content).toContain('1-5');
  });

  it('prompt-cache prep hashes stable prefix', () => {
    const input = {
      system: 'sys',
      policy: 'pol',
      history: [],
      summaries: [],
      memories: [{ content: 'mem', memoryId: 'mem1' }],
      knowledge: [{ content: 'know', citation: 'doc1' }],
      tools: [],
      userMessage: 'hi',
    };
    const r1 = toProviderFormat(input, { model: 'openai/gpt-4o-mini' });
    const r2 = toProviderFormat(input, { model: 'openai/gpt-4o-mini' });
    expect(r1.promptCacheKey).toBe(r2.promptCacheKey);
    expect(r1.promptCacheKey).toMatch(/^pc_/);
    expect(r1.diagnostics.promptCachePrepared).toBe(true);
  });

  it('structured output only if provider supports', () => {
    const withSupport = toProviderFormat(
      {
        system: 's',
        policy: 'p',
        history: [],
        summaries: [],
        memories: [],
        knowledge: [],
        tools: [],
        userMessage: 'hi',
        outputSchema: { type: 'object' },
        providerCapabilities: { supportsStructuredOutput: true },
      },
      { model: 'openai/gpt-4o-mini' },
    );
    expect(withSupport.request.structuredOutput).toBeDefined();

    const without = toProviderFormat(
      {
        system: 's',
        policy: 'p',
        history: [],
        summaries: [],
        memories: [],
        knowledge: [],
        tools: [],
        userMessage: 'hi',
        outputSchema: { type: 'object' },
        providerCapabilities: { supportsStructuredOutput: false },
      },
      { model: 'openai/gpt-4o-mini' },
    );
    expect(without.request.structuredOutput).toBeUndefined();
  });
});
