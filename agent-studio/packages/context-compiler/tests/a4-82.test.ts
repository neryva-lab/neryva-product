/**
 * a4-82.test.ts — user-scoped memories must reach the provider payload.
 * Regression: the runtime worker mapped manifest scope='user' with
 * scopeId=conversationId and the compiler matched user scope against the
 * organization id, so user memories were silently dropped (scope-mismatch).
 * The engine resolves user scope to the run actor's account id and serves it
 * as scopeId; the worker preserves it and threads runUserId into the compiler.
 */
import { describe, it, expect } from 'vitest';
import { compileContext } from '../src/compiler.js';
import type { CompilerInput } from '../src/context-inputs.js';
import { DEFAULT_TOOL_DESCRIPTORS } from '@neryva/contracts/tool/descriptor';

function userScopeInput(overrides: Partial<CompilerInput> = {}): CompilerInput {
  return {
    organizationId: 'org1',
    conversationId: 'conv1',
    runId: 'run1',
    agentVersionId: 'agent_v1',
    userId: 'user-1',
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
        summary_enabled: false,
        knowledge_sources: [],
        memory_scope: 'user',
        max_context_tokens: 32000,
      },
      tools: [],
      guardrails: {
        input_policy: 'default' as const,
        output_policy: 'brand-safe' as const,
        pii_redaction: false,
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

function userMemory(scopeId: string) {
  return {
    memoryId: `mem-${scopeId}`,
    organizationId: 'org1',
    scope: 'user' as const,
    scopeId,
    content: `preference of ${scopeId}`,
    visibility: 'private' as const,
    status: 'APPROVED' as const,
    createdAt: new Date().toISOString(),
    version: 1,
  };
}

describe('A4-82 — user-scoped memories reach the provider', () => {
  it('selects the run user\'s memory when scopeId matches runUserId', () => {
    const input = userScopeInput({ memories: [userMemory('user-1')] });
    const compiled = compileContext(input);
    expect(compiled.diagnostics.memories.selected).toBe(1);
    expect(compiled.diagnostics.memories.rejected).toBe(0);
    expect(
      compiled.providerRequest.messages.some((m) => m.content.includes('preference of user-1')),
    ).toBe(true);
  });

  it('rejects another user\'s memory (isolation preserved)', () => {
    const input = userScopeInput({ memories: [userMemory('user-2')] });
    const compiled = compileContext(input);
    expect(compiled.diagnostics.memories.selected).toBe(0);
    expect(compiled.diagnostics.memories.rejected).toBe(1);
    expect(
      compiled.providerRequest.messages.some((m) => m.content.includes('preference of user-2')),
    ).toBe(false);
  });

  it('fails closed when runUserId is absent — no user memory leaks in', () => {
    const input = userScopeInput({ userId: undefined, memories: [userMemory('org1')] });
    const compiled = compileContext(input);
    // legacy org-as-proxy fallback: only memories literally scoped to the org id match
    expect(compiled.diagnostics.memories.selected).toBe(1);
    const noProxy = userScopeInput({ userId: undefined, memories: [userMemory('user-1')] });
    const compiled2 = compileContext(noProxy);
    expect(compiled2.diagnostics.memories.selected).toBe(0);
  });
});
