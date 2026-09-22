/**
 * litellm.test.ts — 11 conformance cases + 100+ provider unified interface
 * Source: https://docs.litellm.ai/docs/ (unified 100+ LLMs), https://docs.litellm.ai/docs/simple_proxy (AI Gateway), https://docs.litellm.ai/docs/providers (100+), https://docs.litellm.ai/docs/routing
 * LiteLLM proxy gives single OpenAI-compatible interface to 100+ providers (openai, anthropic, gemini, bedrock, azure, groq, mistral, cohere, together_ai, deepseek, perplexity, ollama, etc.) via baseUrl http://localhost:4000
 */
import { describe, it, expect } from 'vitest';
import { createLiteLLMAdapter } from '../../src/providers/litellm.js';
import { ModelGateway } from '../../src/model-gateway.js';
import { NeryvaProviderError } from '@neryva/contracts/provider/errors';
import { isRedacted } from '../../src/redaction.js';
import { LITELLM_CAPABILITIES } from '../../src/capabilities.js';

function makeGateway() {
  const adapter = createLiteLLMAdapter({ apiKey: 'test-key', baseUrl: 'http://localhost:4000' });
  const gw = new ModelGateway();
  gw.registerAdapter(adapter);
  return { gw, adapter };
}

describe('litellm provider — 11 conformance cases + unified 100+ providers', () => {
  it('unified interface supports 100+ provider models via same OpenAI format', () => {
    expect(LITELLM_CAPABILITIES.length).toBeGreaterThanOrEqual(10);
    const providers = [...new Set(LITELLM_CAPABILITIES.map((c) => c.modelId.split('/')[1]))];
    expect(providers.length).toBeGreaterThanOrEqual(5);
    // Examples from docs/providers
    expect(LITELLM_CAPABILITIES.some((c) => c.modelId === 'litellm/openai/gpt-4o')).toBe(true);
    expect(
      LITELLM_CAPABILITIES.some((c) => c.modelId === 'litellm/anthropic/claude-3-5-sonnet'),
    ).toBe(true);
    expect(LITELLM_CAPABILITIES.some((c) => c.modelId === 'litellm/groq/llama-3.3-70b')).toBe(true);
    expect(
      LITELLM_CAPABILITIES.some((c) => c.modelId === 'litellm/bedrock/anthropic.claude-3-5-sonnet'),
    ).toBe(true);
  });
  it('1 text — simple completion via proxy', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'litellm/openai/gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.text).toContain('LiteLLM proxy');
    expect(res.finishReason).toBe('stop');
    expect(res.usage.totalTokens).toBeGreaterThan(0);
    expect(res.providerId).toBe('litellm');
  });
  it('2 streaming — chunked deltas + finish', async () => {
    const { adapter } = makeGateway();
    const stream = await adapter.stream({
      model: 'litellm/anthropic/claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'stream me' }],
    });
    const events: unknown[] = [];
    for await (const e of stream.stream) events.push(e);
    const deltas = events.filter((e: unknown) => (e as { type: string }).type === 'text-delta');
    const finish = events.find((e: unknown) => (e as { type: string }).type === 'finish');
    expect(deltas.length).toBeGreaterThan(0);
    expect(finish).toBeDefined();
    expect((finish as { finishReason: string }).finishReason).toBe('stop');
  });
  it('3 tool round-trip — unified tool calling across providers', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'litellm/openai/gpt-4o',
      messages: [{ role: 'user', content: 'use-tool: search tickets' }],
      tools: [{ name: 'search_tickets', description: 'search', parameters: {} }],
    });
    expect(res.finishReason).toBe('tool-call');
    expect(res.toolCalls?.[0]?.name).toBe('search_tickets');
    expect(res.toolCalls?.[0]?.args).toEqual({ query: 'test' });
  });
  it('4 structured output success', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'litellm/google/gemini-1.5-flash',
      messages: [{ role: 'user', content: 'structured' }],
      structuredOutput: {
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
        name: 'answer',
      },
    });
    expect(res.structuredOutput).toBeDefined();
    expect(res.structuredOutputRefusal).not.toBe(true);
    expect(res.finishReason).toBe('stop');
  });
  it('5 structured output refusal', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'litellm/google/gemini-1.5-flash',
      messages: [{ role: 'user', content: 'structured:refusal' }],
      structuredOutput: { schema: { type: 'object', properties: { answer: { type: 'string' } } } },
    });
    expect(res.structuredOutputRefusal).toBe(true);
    expect(res.finishReason).toBe('content-filter');
  });
  it('6 timeout', async () => {
    const adapter = createLiteLLMAdapter({
      apiKey: 'test-key',
      baseUrl: 'http://localhost:4000',
      timeoutMs: 10,
    });
    await expect(
      adapter.generate({
        model: 'litellm/openai/gpt-4o',
        messages: [{ role: 'user', content: 'case:timeout' }],
        timeoutMs: 10,
        correlationId: 'case:timeout',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError &&
        (e as NeryvaProviderError).code === 'TIMEOUT' &&
        (e as NeryvaProviderError).retryable === true,
    );
  });
  it('7 rate-limit + retry-after', async () => {
    const { adapter } = makeGateway();
    try {
      await adapter.generate({
        model: 'litellm/openai/gpt-4o',
        messages: [{ role: 'user', content: 'case:rate-limit' }],
        correlationId: 'case:rate-limit',
      });
      expect.fail('should throw');
    } catch (e) {
      expect(e).toBeInstanceOf(NeryvaProviderError);
      expect((e as NeryvaProviderError).code).toBe('RATE_LIMITED');
      expect((e as NeryvaProviderError).retryable).toBe(true);
      expect((e as NeryvaProviderError).retryAfterMs).toBe(100);
    }
  });
  it('8 invalid request', async () => {
    const { adapter } = makeGateway();
    await expect(
      adapter.generate({
        model: 'litellm/openai/gpt-4o',
        messages: [{ role: 'user', content: 'case:invalid-request' }],
        correlationId: 'case:invalid-request',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError && (e as NeryvaProviderError).code === 'INVALID_REQUEST',
    );
  });
  it('9 auth failure — virtual key', async () => {
    const { adapter } = makeGateway();
    await expect(
      adapter.generate({
        model: 'litellm/openai/gpt-4o',
        messages: [{ role: 'user', content: 'case:auth-fail' }],
        correlationId: 'case:auth-fail',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError &&
        (e as NeryvaProviderError).code === 'AUTH_FAILED' &&
        (e as NeryvaProviderError).retryable === false,
    );
    expect(() => createLiteLLMAdapter({ simulate: false })).toThrow(/credentials required/);
  });
  it('10 usage — prompt/completion/total + cost normalized via same OpenAI format regardless of provider', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'litellm/groq/llama-3.3-70b',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.usage.promptTokens).toBeGreaterThan(0);
    expect(res.usage.completionTokens).toBeGreaterThan(0);
    expect(res.usage.totalTokens).toBe(res.usage.promptTokens + res.usage.completionTokens);
    expect(res.usage.costCents).toBeGreaterThanOrEqual(0);
    expect(res.usage.providerId).toBe('litellm');
    // Different underlying providers (groq vs openai) both normalized via same usage shape
    const res2 = await adapter.generate({
      model: 'litellm/mistral/mistral-large',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res2.usage.totalTokens).toBeGreaterThan(0);
  });
  it('11 cancellation — AbortSignal', async () => {
    const { adapter } = makeGateway();
    const ac = new AbortController();
    ac.abort();
    await expect(
      adapter.generate(
        { model: 'litellm/openai/gpt-4o', messages: [{ role: 'user', content: 'hello' }] },
        { signal: ac.signal },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError && (e as NeryvaProviderError).code === 'CANCELLED',
    );
    const ac2 = new AbortController();
    const streamPromise = adapter.stream(
      { model: 'litellm/openai/gpt-4o', messages: [{ role: 'user', content: 'hello' }] },
      { signal: ac2.signal },
    );
    ac2.abort();
    await expect(streamPromise).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError && (e as NeryvaProviderError).code === 'CANCELLED',
    );
  });
  it('redaction — virtual keys not logged', async () => {
    const { adapter } = makeGateway();
    const { redactObject } = await import('../../src/redaction.js');
    const redacted = redactObject(
      {
        messages: [{ role: 'user', content: 'secret prompt' }],
        apiKey: 'sk-litellm-virtual-key-123',
      },
      'strict',
    );
    expect(isRedacted(redacted)).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('secret prompt');
    expect(JSON.stringify(redacted)).not.toContain('sk-litellm');
    const res = await adapter.generate({
      model: 'litellm/openai/gpt-4o',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.text).toBeDefined();
  });
  it('gateway integration via LiteLLM — read-only, separate network boundary (config.yaml virtual keys)', async () => {
    const gw = new ModelGateway();
    const adapter = createLiteLLMAdapter({
      apiKey: 'test-virtual-key',
      baseUrl: 'http://localhost:4000',
    });
    gw.registerAdapter(adapter);
    const res = await gw.generate({
      model: 'litellm/anthropic/claude-3-5-sonnet',
      messages: [{ role: 'user', content: 'hello' }],
      policySnapshot: {
        organizationId: 'org1',
        allowedModels: ['litellm/anthropic/claude-3-5-sonnet'],
      },
      correlationId: 'run_litellm',
      runId: 'run1',
      organizationId: 'org1',
    });
    expect(res.finishReason).toBe('stop');
    expect(res.text).toContain('LiteLLM proxy');
    expect(res.usage.providerId).toBe('litellm');
  });
  it('provider-agnostic: same OpenAI-compatible call works for bedrock, azure, cohere via proxy', async () => {
    const { adapter } = makeGateway();
    for (const model of [
      'litellm/bedrock/anthropic.claude-3-5-sonnet',
      'litellm/azure/gpt-4o',
      'litellm/cohere/command-r-plus',
    ]) {
      const res = await adapter.generate({ model, messages: [{ role: 'user', content: 'hello' }] });
      expect(res.finishReason).toBe('stop');
      expect(res.providerId).toBe('litellm');
    }
  });
});
