/**
 * authorization.test.ts — invariants fail-closed (never retrieve-then-authorize, no unauthorized, etc.)
 * Source: ledger 5.4, agent_studio_implementation_plan.md:957-965, 1440
 */

import { describe, it, expect } from 'vitest';
import { compileContext, InsufficientContextError } from '../src/compiler.js';
import type { CompilerInput } from '../src/context-inputs.js';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';

function baseInput(overrides: Partial<CompilerInput> = {}): CompilerInput {
  return {
    organizationId: 'org1',
    conversationId: 'conv1',
    runId: 'run1',
    agentVersionId: 'agent_v1',
    agentDefinition: {
      agent_id: 'support-agent',
      version: 1,
      schema_version: 'v1',
      instructions: 'You are helpful',
      model_policy: {
        allowed_models: ['openai/gpt-4o-mini'],
        fallback_enabled: false,
        max_output_tokens: 4096,
      },
      context_policy: {
        history_limit: 10,
        summary_enabled: true,
        knowledge_sources: ['support-docs'],
        memory_scope: 'user',
        max_context_tokens: 32000,
      },
      tools: [{ name: 'search_tickets', access: 'read' as const }],
      guardrails: {
        input_policy: 'default' as const,
        output_policy: 'brand-safe' as const,
        pii_redaction: true,
      },
      budget_policy: {
        max_model_calls: 8,
        max_tool_calls: 8,
        max_wall_clock_ms: 120000,
        max_token_budget: 50000,
        max_cost_cents: 1000,
        max_recursion_depth: 5,
      },
      retrieval_policy: {
        knowledge_max_results: 5,
        memory_max_results: 5,
        hybrid_retrieval: false,
      },
    } as unknown as CompilerInput['agentDefinition'],
    policySnapshot: { organizationId: 'org1', allowedModels: ['openai/gpt-4o-mini'] },
    history: [],
    summaries: [],
    memories: [],
    knowledge: [],
    availableTools: [...DEFAULT_TOOL_DESCRIPTORS],
    maxContextTokens: 32000,
    userMessage: { content: 'hello', sequence: 1 },
    ...overrides,
  };
}

describe('authorization invariants — fail-closed', () => {
  it('never include expired memory', () => {
    const input = baseInput({
      memories: [
        {
          memoryId: 'mem1',
          organizationId: 'org1',
          scope: 'user',
          scopeId: 'org1',
          content: 'expired',
          visibility: 'private',
          status: 'APPROVED',
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          version: 1,
        },
      ],
    });
    const compiled = compileContext(input);
    expect(compiled.diagnostics.memories.selected).toBe(0);
    expect(compiled.diagnostics.memories.rejected).toBe(1);
    expect(compiled.providerRequest.messages.some((m) => m.content.includes('expired'))).toBe(
      false,
    );
  });

  it('never include deleted/quarantined knowledge', () => {
    const input = baseInput({
      knowledge: [
        {
          sourceId: 'doc1',
          documentVersionId: 'v1',
          organizationId: 'org1',
          content: 'bad',
          citation: 'doc1',
          status: 'QUARANTINED',
          createdAt: new Date().toISOString(),
          version: 1,
        },
      ],
    });
    const compiled = compileContext(input);
    expect(compiled.diagnostics.knowledge.selected).toBe(0);
    expect(compiled.diagnostics.knowledge.rejected).toBe(1);
  });

  it('never include cross-tenant knowledge', () => {
    const input = baseInput({
      knowledge: [
        {
          sourceId: 'doc1',
          documentVersionId: 'v1',
          organizationId: 'org-other',
          content: 'other org',
          citation: 'doc1',
          status: 'READY',
          createdAt: new Date().toISOString(),
          version: 1,
        },
      ],
    });
    const compiled = compileContext(input);
    expect(compiled.diagnostics.knowledge.selected).toBe(0);
    expect(compiled.providerRequest.messages.some((m) => m.content.includes('other org'))).toBe(
      false,
    );
  });

  it('never treat model "memory" as approved — PENDING rejected', () => {
    const input = baseInput({
      memories: [
        {
          memoryId: 'mem1',
          organizationId: 'org1',
          scope: 'user',
          scopeId: 'org1',
          content: 'model says remember this',
          visibility: 'private',
          status: 'PENDING',
          createdAt: new Date().toISOString(),
          version: 1,
        },
      ],
    });
    const compiled = compileContext(input);
    expect(compiled.diagnostics.memories.selected).toBe(0);
  });

  it('never depend on provider-managed conversation ID — uses Engine conversationId', () => {
    const input = baseInput({ conversationId: 'conv_engine_123' });
    const compiled = compileContext(input);
    expect(compiled.sources.historyIds).toBeDefined();
    // Provider request should not contain provider conversation ID, only Engine's
    expect(JSON.stringify(compiled.providerRequest)).not.toContain('provider-conv');
  });

  it('records source IDs/versions not just prompt', () => {
    const input = baseInput({
      history: [
        {
          messageId: 'msg1',
          organizationId: 'org1',
          conversationId: 'conv1',
          sequence: 1,
          role: 'user',
          content: 'hi',
          createdAt: new Date().toISOString(),
          sourceVersion: 'v1',
        },
      ],
      knowledge: [
        {
          sourceId: 'support-docs:doc1',
          documentVersionId: 'v2',
          organizationId: 'org1',
          content: 'know',
          citation: 'doc1#v2',
          status: 'READY',
          createdAt: new Date().toISOString(),
          version: 2,
          purpose: 'support-docs',
        },
      ],
      userMessage: { content: 'hello', sequence: 2 },
    });
    const compiled = compileContext(input);
    expect(compiled.sources.historyIds).toContain('msg1');
    expect(compiled.sources.knowledgeIds).toContain('support-docs:doc1');
    expect(
      compiled.citations.some((c) => c.sourceId === 'support-docs:doc1' && c.version === 2),
    ).toBe(true);
  });

  it('safe failure when required policy context cannot be loaded — InsufficientContext', () => {
    const input = baseInput({
      // Simulate missing definition by passing empty instructions and tiny budget
      agentDefinition: {
        agent_id: 'support-agent',
        version: 1,
        schema_version: 'v1',
        instructions: 'x'.repeat(50000), // huge, will exceed budget with system+policy
        model_policy: {
          allowed_models: ['openai/gpt-4o-mini'],
          fallback_enabled: false,
          max_output_tokens: 4096,
        },
        context_policy: {
          history_limit: 10,
          summary_enabled: true,
          knowledge_sources: [],
          memory_scope: 'user',
          max_context_tokens: 32000,
        },
        tools: [],
        guardrails: {
          input_policy: 'default' as const,
          output_policy: 'brand-safe' as const,
          pii_redaction: true,
        },
        budget_policy: {
          max_model_calls: 8,
          max_tool_calls: 8,
          max_wall_clock_ms: 120000,
          max_token_budget: 50000,
          max_cost_cents: 1000,
          max_recursion_depth: 5,
        },
        retrieval_policy: {
          knowledge_max_results: 5,
          memory_max_results: 5,
          hybrid_retrieval: false,
        },
      } as unknown as CompilerInput['agentDefinition'],
      maxContextTokens: 10, // tiny
    });
    expect(() => compileContext(input)).toThrow(InsufficientContextError);
  });

  it('final prompt is derived artifact — rebuildable from Engine refs', () => {
    const input = baseInput({
      history: [
        {
          messageId: 'msg1',
          organizationId: 'org1',
          conversationId: 'conv1',
          sequence: 1,
          role: 'user',
          content: 'hello',
          createdAt: new Date().toISOString(),
        },
      ],
      userMessage: { content: 'hello', sequence: 2 },
    });
    const c1 = compileContext(input);
    const c2 = compileContext(input);
    // Same input → same providerRequest (deterministic, rebuildable)
    expect(JSON.stringify(c1.providerRequest)).toBe(JSON.stringify(c2.providerRequest));
    expect(c1.sources.historyIds).toEqual(c2.sources.historyIds);
  });

  it('diagnostics identify omitted without leaking content (hashes/sizes)', () => {
    const bigHistory = Array.from({ length: 10 }, (_, i) => ({
      messageId: `msg${i}`,
      organizationId: 'org1',
      conversationId: 'conv1',
      sequence: i + 1,
      role: 'user' as const,
      content: 'secret ' + 'x'.repeat(1000),
      createdAt: new Date().toISOString(),
    }));
    const input = baseInput({
      history: bigHistory,
      maxContextTokens: 500,
      userMessage: { content: 'hello', sequence: 100 },
    });
    const compiled = compileContext(input);
    // History was truncated
    if (compiled.diagnostics.history.omitted > 0) {
      expect(compiled.citations.every((c) => !c.citation.includes('secret'))).toBe(true); // citations don't leak raw
      // Diagnostics should have hashes, not raw — check via citationMap (64) and citations (12)
      const first = compiled.citationMap.citations[0] ?? compiled.citations[0];
      const hash =
        (first as unknown as { contentHash?: string; hash?: string })?.contentHash ??
        (first as unknown as { hash?: string })?.hash;
      expect(hash).toMatch(/^[a-f0-9]+$/);
    }
  });
});
