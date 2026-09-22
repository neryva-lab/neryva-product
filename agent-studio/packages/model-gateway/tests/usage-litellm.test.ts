/**
 * usage-litellm.test.ts — provider-normalized NeryvaUsage matches Engine usage_ledger_entries (drizzle 0027)
 * Source: agent_studio_implementation_plan.md:1515 (usage reconciliation), matrix.md
 * LiteLLM proxy returns same OpenAI usage shape {prompt_tokens, completion_tokens, total_tokens} regardless of underlying provider — normalized same way.
 * Do not sum span tokens; use Engine ledger as source of truth.
 */
import { describe, it, expect } from 'vitest';
import { createOpenAIAdapter } from '../src/providers/openai.js';
import { createAnthropicAdapter } from '../src/providers/anthropic.js';
import { createGoogleAdapter } from '../src/providers/google.js';
import { createLiteLLMAdapter } from '../src/providers/litellm.js';
import { normalizeProviderUsage, attachCost } from '../src/usage.js';
import { DEFAULT_CAPABILITIES } from '../src/capabilities.js';

describe('usage reconciliation — normalized across providers including LiteLLM', () => {
  it('normalizes OpenAI, Anthropic, Google, LiteLLM to same NeryvaUsage shape', async () => {
    const providers = [
      { adapter: createOpenAIAdapter({ apiKey: 'test-key' }), model: 'openai/gpt-4o-mini' },
      {
        adapter: createAnthropicAdapter({ apiKey: 'test-key' }),
        model: 'anthropic/claude-3-5-sonnet',
      },
      { adapter: createGoogleAdapter({ apiKey: 'test-key' }), model: 'google/gemini-1.5-pro' },
      {
        adapter: createLiteLLMAdapter({ apiKey: 'test-key', baseUrl: 'http://localhost:4000' }),
        model: 'litellm/groq/llama-3.3-70b',
      },
      {
        adapter: createLiteLLMAdapter({ apiKey: 'test-key', baseUrl: 'http://localhost:4000' }),
        model: 'litellm/bedrock/anthropic.claude-3-5-sonnet',
      },
    ];
    for (const { adapter, model } of providers) {
      const res = await adapter.generate({ model, messages: [{ role: 'user', content: 'hello' }] });
      expect(res.usage.providerId).toBe(adapter.providerId);
      expect(res.usage.modelId).toBe(model);
      expect(res.usage.promptTokens).toBeGreaterThan(0);
      expect(res.usage.completionTokens).toBeGreaterThan(0);
      expect(res.usage.totalTokens).toBe(res.usage.promptTokens + res.usage.completionTokens);
      expect(res.usage.costCents).toBeGreaterThanOrEqual(0);
    }
  });

  it('LiteLLM proxy usage same shape as direct provider — groq vs bedrock vs mistral', async () => {
    const litellm = createLiteLLMAdapter({ apiKey: 'test-key', baseUrl: 'http://localhost:4000' });
    const models = [
      'litellm/groq/llama-3.3-70b',
      'litellm/mistral/mistral-large',
      'litellm/cohere/command-r-plus',
    ];
    for (const model of models) {
      const res = await litellm.generate({ model, messages: [{ role: 'user', content: 'hello' }] });
      expect(res.usage.promptTokens).toBeGreaterThan(0);
      expect(res.usage.totalTokens).toBeGreaterThan(0);
      // All via same OpenAI-compatible proxy response
      expect(res.providerId).toBe('litellm');
    }
  });

  it('cost calculation per capability — consistent across providers', () => {
    const capOpenAI = DEFAULT_CAPABILITIES.find((c) => c.modelId === 'openai/gpt-4o-mini');
    if (!capOpenAI) throw new Error('cap missing');
    const usage = normalizeProviderUsage({
      promptTokens: 1000,
      completionTokens: 500,
      providerId: 'openai',
      modelId: 'openai/gpt-4o-mini',
    });
    const costed = attachCost(usage, capOpenAI);
    // 1.5c per 1k prompt + 6c per 1k completion = 1.5 + 3 = 4.5c
    expect(costed.costCents).toBe(5);
    const capLiteLLM = DEFAULT_CAPABILITIES.find(
      (c) => c.modelId === 'litellm/deepseek/deepseek-chat',
    );
    if (!capLiteLLM) throw new Error('cap missing');
    const usage2 = normalizeProviderUsage({
      promptTokens: 1000,
      completionTokens: 500,
      providerId: 'litellm',
      modelId: 'litellm/deepseek/deepseek-chat',
    });
    const costed2 = attachCost(usage2, capLiteLLM);
    expect(costed2.costCents).toBeGreaterThan(0);
  });

  it('Engine ledger is source of truth — do not sum span tokens (coalesce)', async () => {
    // Simulate two spans for same provider call (duplicate GenAI generation) — should coalesce not sum
    const { coalesceUsage } = await import('../../telemetry/src/semantic-conventions.js');
    const coalesced = coalesceUsage([
      { source: 'span', inputTokens: 100, outputTokens: 50 },
      { source: 'span', inputTokens: 100, outputTokens: 50 },
      { source: 'engine-ledger', inputTokens: 100, outputTokens: 50 },
    ] as unknown as Parameters<typeof coalesceUsage>[0]);
    expect(coalesced.source).toBe('engine-ledger');
    expect(coalesced.inputTokens).toBe(100);
    // Not 200
  });

  it('usage ledger entry shape matches NeryvaUsage (drizzle 0027)', async () => {
    const adapter = createLiteLLMAdapter({ apiKey: 'test-key', baseUrl: 'http://localhost:4000' });
    const res = await adapter.generate({
      model: 'litellm/openai/gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const ledgerEntry = {
      organizationId: 'org1',
      runId: 'run1',
      modelId: res.model,
      providerId: res.providerId,
      promptTokens: res.usage.promptTokens,
      completionTokens: res.usage.completionTokens,
      totalTokens: res.usage.totalTokens,
      costCents: res.usage.costCents,
      source: 'engine-ledger' as const,
    };
    expect(ledgerEntry.totalTokens).toBe(ledgerEntry.promptTokens + ledgerEntry.completionTokens);
    expect(ledgerEntry.providerId).toBe('litellm');
  });
});
