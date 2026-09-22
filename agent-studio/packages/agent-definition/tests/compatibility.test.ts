/**
 * compatibility.test.ts — one immutable definition → one stable hash
 * Source: ledger.md:1.4, agent_studio_implementation_plan.md:703-722
 */

import { describe, it, expect } from 'vitest';
import { compileDefinition, hashDefinition } from '../src/compiler.js';
import { mustParseAgentDefinition } from '../src/parser.js';

describe('compiler — stable hash', () => {
  const raw = {
    agent_id: 'support-agent',
    version: 17,
    instructions: 'Helpful.',
    model_policy: { allowed_models: ['openai/gpt-4o-mini'] },
    context_policy: {
      history_limit: 30,
      summary_enabled: true,
      knowledge_sources: [],
      memory_scope: 'user',
    },
    tools: [],
    guardrails: { input_policy: 'default', output_policy: 'brand-safe', pii_redaction: true },
  };

  it('same definition produces same hash', () => {
    const def1 = mustParseAgentDefinition(raw);
    const def2 = mustParseAgentDefinition(raw);
    expect(hashDefinition(def1)).toBe(hashDefinition(def2));
    const c1 = compileDefinition(def1, { agentVersionId: 'asst_v17' });
    const c2 = compileDefinition(def2, { agentVersionId: 'asst_v17' });
    expect(c1.hash).toBe(c2.hash);
    expect(c1.instructionsHash).toBe(c2.instructionsHash);
  });

  it('compiled output has 11+ fields and no secrets', () => {
    const def = mustParseAgentDefinition(raw);
    const compiled = compileDefinition(def, { agentVersionId: 'asst_v17' });
    expect(compiled.agentVersionId).toBe('asst_v17');
    expect(compiled.definitionSchemaVersion).toBe('v1');
    expect(compiled.instructionsRef).toMatch(/^hash:/);
    expect(compiled.compilerVersion).toBe('1.0.0');
    expect(compiled.policySnapshotRef).toBeDefined();
    expect(compiled.hash).toHaveLength(64);
    // No secrets/mutable pointers
    const json = JSON.stringify(compiled);
    expect(json).not.toMatch(/api_key|secret|credential/i);
    expect(json).not.toContain('mutable');
  });

  it('different version → different hash', () => {
    const def1 = mustParseAgentDefinition({ ...raw, version: 17 });
    const def2 = mustParseAgentDefinition({ ...raw, version: 18 });
    expect(hashDefinition(def1)).not.toBe(hashDefinition(def2));
  });
});
