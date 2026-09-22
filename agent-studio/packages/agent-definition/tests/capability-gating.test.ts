/**
 * capability-gating.test.ts — allowed_models must reference Model Gateway capability registry
 * Source: agent_studio_architecture.md:405-414, ledger 4.7
 * Agent cannot select arbitrary provider string; must be in registry.
 */

import { describe, it, expect } from 'vitest';
import { validateAgentDefinition } from '../src/validator.js';
import type { AgentDefinitionV1 } from '../src/schema.js';

// Local mirror of DEFAULT_CAPABILITIES (avoid DAG violation: agent-definition must not depend on model-gateway)
// Source: packages/model-gateway/src/capabilities.ts:DEFAULT_CAPABILITIES
const REGISTRY_MODELS = [
  'openai/gpt-4o-mini',
  'openai/gpt-4o',
  'anthropic/claude-3-5-sonnet',
  'google/gemini-1.5-pro',
];
const GLOBAL_REGISTRY_SET = new Set(REGISTRY_MODELS);

function makeDef(overrides: Partial<AgentDefinitionV1> = {}): AgentDefinitionV1 {
  return {
    agent_id: 'support-agent',
    version: 1,
    instructions: 'You are a helpful support agent.',
    model_policy: {
      allowed_models: ['openai/gpt-4o-mini'],
      fallback_enabled: false,
    },
    context_policy: {
      history_limit: 30,
      summary_enabled: true,
      knowledge_sources: ['support-docs'],
      memory_scope: 'user',
    },
    tools: [{ name: 'search_tickets', access: 'read' as const }],
    guardrails: {
      input_policy: 'default',
      output_policy: 'brand-safe',
      pii_redaction: true,
    },
    budget_policy: {
      max_model_calls: 8,
      max_tool_calls: 8,
      max_wall_clock_ms: 120_000,
      max_token_budget: 50_000,
      max_cost_cents: 1000,
      max_recursion_depth: 5,
    },
    retrieval_policy: {
      hybrid_retrieval: false,
      max_results: 5,
    },
    ...overrides,
  } as AgentDefinitionV1;
}

describe('capability gating — allowed_models must reference registry', () => {
  it('accepts model in registry', () => {
    const def = makeDef({
      model_policy: { allowed_models: ['openai/gpt-4o-mini'], fallback_enabled: false },
    });
    const res = validateAgentDefinition(def, { modelRegistry: GLOBAL_REGISTRY_SET });
    expect(res.ok).toBe(true);
  });

  it('rejects arbitrary provider string not in registry', () => {
    const def = makeDef({
      model_policy: { allowed_models: ['evil/provider-x'], fallback_enabled: false },
    });
    const res = validateAgentDefinition(def, { modelRegistry: GLOBAL_REGISTRY_SET });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.message).toContain('unknown model capability');
  });

  it('rejects model not in org allowlist via gateway catalog (routing level)', () => {
    const def = makeDef({
      model_policy: { allowed_models: ['openai/gpt-4o'], fallback_enabled: false },
    });
    const registry = new Set(['openai/gpt-4o-mini']); // only mini allowed in this org's registry view
    const res = validateAgentDefinition(def, { modelRegistry: registry });
    expect(res.ok).toBe(false);
  });

  it('registry is source of truth — not arbitrary string', () => {
    expect([...GLOBAL_REGISTRY_SET]).toContain('openai/gpt-4o-mini');
    expect([...GLOBAL_REGISTRY_SET]).not.toContain('openai/gpt-unknown');
  });
});
