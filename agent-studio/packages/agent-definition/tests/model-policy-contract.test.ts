/**
 * model-policy-contract.test.ts — DEFINITION_INVALID regression for model aliases.
 *
 * Regression (wave-4 smoke): an Engine publish pipeline bug served a manifest
 * whose model_policy.allowed_models contained the bare alias `gpt-4o-mini`.
 * Studio requires provider-qualified references (`provider/model`, see the
 * MCP proto and contracts/agent-definition/v1.schema.json), so the console
 * run failed with DEFINITION_INVALID.
 *
 * Contract boundary (deliberate): Studio keeps failing closed on bare
 * aliases — the Engine must qualify them before publish (see engine
 * qualifyModelAliases). These tests pin that boundary so neither side can
 * silently drift.
 */
import { describe, it, expect } from 'vitest';
import { parseAgentDefinition } from '../src/parser.js';

const base = {
  agent_id: 'support-agent',
  version: 17,
  instructions: 'You are helpful support assistant.',
  context_policy: {
    history_limit: 30,
    summary_enabled: true,
    knowledge_sources: ['support-docs'],
    memory_scope: 'user',
  },
  tools: [{ name: 'search_tickets', access: 'read' }],
  guardrails: { input_policy: 'default', output_policy: 'brand-safe', pii_redaction: true },
};

describe('model_policy.allowed_models — contract boundary', () => {
  it('rejects a bare model alias (wave-4 DEFINITION_INVALID regression)', () => {
    const raw = {
      ...base,
      model_policy: { allowed_models: ['gpt-4o-mini'], fallback_enabled: false },
    };
    const parsed = parseAgentDefinition(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.message).toMatch(/allowed_models/);
    }
  });

  it('accepts a provider-qualified model reference', () => {
    const raw = {
      ...base,
      model_policy: { allowed_models: ['openai/gpt-4o-mini'], fallback_enabled: false },
    };
    const parsed = parseAgentDefinition(raw);
    expect(parsed.ok).toBe(true);
  });

  it('rejects mixed lists containing a bare alias', () => {
    const raw = {
      ...base,
      model_policy: {
        allowed_models: ['openai/gpt-4o-mini', 'gpt-4o'],
        fallback_enabled: false,
      },
    };
    const parsed = parseAgentDefinition(raw);
    expect(parsed.ok).toBe(false);
  });
});
