/**
 * schema.test.ts — schema validation
 * Source: contracts/agent-definition/v1.schema.json, ledger.md:1.3
 */

import { describe, it, expect } from 'vitest';
import { AgentDefinitionV1Schema } from '../src/schema.js';

describe('AgentDefinitionV1Schema', () => {
  const base = {
    agent_id: 'support-agent',
    version: 17,
    instructions: 'You are helpful.',
    model_policy: { allowed_models: ['openai/gpt-4o-mini'], fallback_enabled: true },
    context_policy: {
      history_limit: 30,
      summary_enabled: true,
      knowledge_sources: ['support-docs'],
      memory_scope: 'user' as const,
    },
    tools: [
      { name: 'search_tickets', access: 'read' as const },
      { name: 'create_ticket', access: 'write' as const, approval: 'required' as const },
    ],
    guardrails: {
      input_policy: 'default' as const,
      output_policy: 'brand-safe' as const,
      pii_redaction: true,
    },
  };

  it('valid definition passes', () => {
    expect(AgentDefinitionV1Schema.safeParse(base).success).toBe(true);
  });

  it('rejects missing agent_id', () => {
    const { agent_id: _omit, ...rest } = base as Record<string, unknown>;
    expect(AgentDefinitionV1Schema.safeParse(rest).success).toBe(false);
  });

  it('rejects invalid model pattern', () => {
    const bad = { ...base, model_policy: { allowed_models: ['bad-model'] } };
    expect(AgentDefinitionV1Schema.safeParse(bad).success).toBe(false);
  });

  it('one definition produces one stable parse', () => {
    const r1 = AgentDefinitionV1Schema.safeParse(base);
    const r2 = AgentDefinitionV1Schema.safeParse(base);
    expect(r1.success && r2.success && JSON.stringify(r1.data) === JSON.stringify(r2.data)).toBe(
      true,
    );
  });
});
