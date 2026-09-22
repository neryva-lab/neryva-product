/**
 * budgeting.test.ts — token budgeting, message ordering, tool selection, provider conversion, citation tracking
 * Source: ledger 5.1, agent_studio_architecture.md:448-462, 466, 772-790
 */

import { describe, it, expect } from 'vitest';
import { countTokensHeuristic, createBudget, reserve, canFit } from '../src/token-budget.js';
import { compileContext } from '../src/compiler.js';
import type { CompilerInput } from '../src/context-inputs.js';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';

function makeInput(overrides: Partial<CompilerInput> = {}): CompilerInput {
  return {
    organizationId: 'org1',
    conversationId: 'conv1',
    runId: 'run1',
    agentVersionId: 'agent_v1',
    agentDefinition: {
      agent_id: 'support-agent',
      version: 1,
      schema_version: 'v1',
      instructions: 'You are a helpful support agent.',
      model_policy: {
        allowed_models: ['openai/gpt-4o-mini'],
        fallback_enabled: false,
        max_output_tokens: 4096,
      },
      context_policy: {
        history_limit: 30,
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
    maxOutputTokens: 4096,
    userMessage: { content: 'hello', sequence: 1 },
    ...overrides,
  };
}

describe('budgeting', () => {
  it('countTokensHeuristic is deterministic', () => {
    expect(countTokensHeuristic('hello world')).toBe(countTokensHeuristic('hello world'));
    expect(countTokensHeuristic('hello')).toBeGreaterThan(0);
  });

  it('budget reserve and canFit', () => {
    const b = createBudget(100, 20);
    expect(b.remaining).toBe(80);
    const r = reserve(b, 30);
    expect(r.used).toBe(30);
    expect(r.remaining).toBe(50);
    expect(canFit(r, 40)).toBe(true);
    expect(canFit(r, 60)).toBe(false);
  });

  it('compile respects maxContextTokens via truncation', () => {
    const bigHistory = Array.from({ length: 20 }, (_, i) => ({
      messageId: `msg${i}`,
      organizationId: 'org1',
      conversationId: 'conv1',
      sequence: i + 1,
      role: 'user' as const,
      content: 'x'.repeat(1000),
      createdAt: new Date().toISOString(),
    }));
    const input = makeInput({
      history: bigHistory,
      maxContextTokens: 1000,
      userMessage: { content: 'hello', sequence: 100 },
    });
    const compiled = compileContext(input);
    // Should have truncated history
    expect(compiled.diagnostics.history.omitted).toBeGreaterThan(0);
    expect(compiled.providerRequest.messages.length).toBeGreaterThan(0);
    // System + user must still be present
    expect(compiled.providerRequest.messages[0]?.content).toContain('helpful support');
  });

  it('provider-format mapping for first provider (openai) includes tools and citations', () => {
    const input = makeInput({
      knowledge: [
        {
          sourceId: 'support-docs:doc1',
          documentVersionId: 'v1',
          organizationId: 'org1',
          content: 'knowledge content',
          citation: 'doc1#v1',
          status: 'READY',
          createdAt: new Date().toISOString(),
          version: 1,
          purpose: 'support-docs',
        },
      ],
    });
    const compiled = compileContext(input);
    expect(compiled.providerRequest.tools?.length).toBe(1);
    expect(compiled.providerRequest.tools?.[0]?.name).toBe('search_tickets');
    expect(compiled.citations.length).toBeGreaterThan(0);
    expect(compiled.citations[0]?.sourceId).toBeDefined();
    expect(compiled.citationMap.citations[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('budgeting includes knowledge and memories', () => {
    const input = makeInput({
      memories: [
        {
          memoryId: 'mem1',
          organizationId: 'org1',
          scope: 'user',
          scopeId: 'org1',
          content: 'remember my name is Alice',
          visibility: 'private',
          status: 'APPROVED',
          createdAt: new Date().toISOString(),
          version: 1,
        },
      ],
      knowledge: [
        {
          sourceId: 'support-docs:doc1',
          documentVersionId: 'v1',
          organizationId: 'org1',
          content: 'doc content',
          citation: 'doc1',
          status: 'READY',
          createdAt: new Date().toISOString(),
          version: 1,
          purpose: 'support-docs',
        },
      ],
    });
    const compiled = compileContext(input);
    expect(compiled.diagnostics.memories.selected).toBe(1);
    expect(compiled.diagnostics.knowledge.selected).toBe(1);
    expect(compiled.providerRequest.messages.some((m) => m.content.includes('Alice'))).toBe(true);
  });
});
