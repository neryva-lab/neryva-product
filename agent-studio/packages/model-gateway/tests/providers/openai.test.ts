/**
 * openai.test.ts — 11 conformance cases per provider
 * Source: agent_studio_implementation_plan.md:890-903, agent_studio_architecture.md:772-790
 * Cases: text, streaming termination, tool round-trip, structured success/refusal, timeout, rate-limit+retry-after, invalid request, auth failure, usage, cancellation, redaction
 */

import { describe, it, expect } from 'vitest';
import { createOpenAIAdapter } from '../../src/providers/openai.js';
import { ModelGateway } from '../../src/model-gateway.js';
import { NeryvaProviderError } from '@neryva/contracts/provider/errors';
import { isRedacted } from '../../src/redaction.js';

function makeGateway() {
  const adapter = createOpenAIAdapter({ apiKey: 'test-key' });
  const gw = new ModelGateway();
  gw.registerAdapter(adapter);
  return { gw, adapter };
}

describe('openai provider — 11 conformance cases', () => {
  it('1 text — simple completion', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.text).toBeDefined();
    expect(res.finishReason).toBe('stop');
    expect(res.usage.totalTokens).toBeGreaterThan(0);
  });

  it('2 streaming — chunked deltas + finish', async () => {
    const { adapter } = makeGateway();
    const stream = await adapter.stream({
      model: 'openai/gpt-4o-mini',
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

  it('3 tool round-trip — model proposes tool, gateway returns toolCall', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'openai/gpt-4o-mini',
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
      model: 'openai/gpt-4o-mini',
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

  it('5 structured output refusal (safety)', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'structured:refusal' }],
      structuredOutput: { schema: { type: 'object', properties: { answer: { type: 'string' } } } },
    });
    expect(res.structuredOutputRefusal).toBe(true);
    expect(res.finishReason).toBe('content-filter');
  });

  it('6 timeout — respects timeoutMs and maps to TIMEOUT', async () => {
    const adapter = createOpenAIAdapter({ apiKey: 'test-key', timeoutMs: 10 });
    await expect(
      adapter.generate({
        model: 'openai/gpt-4o-mini',
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
        model: 'openai/gpt-4o-mini',
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

  it('8 invalid request — schema/validation', async () => {
    const { adapter } = makeGateway();
    await expect(
      adapter.generate({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'case:invalid-request' }],
        correlationId: 'case:invalid-request',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError && (e as NeryvaProviderError).code === 'INVALID_REQUEST',
    );
  });

  it('9 auth failure — 401/403 mapped', async () => {
    const { adapter } = makeGateway();
    await expect(
      adapter.generate({
        model: 'openai/gpt-4o-mini',
        messages: [{ role: 'user', content: 'case:auth-fail' }],
        correlationId: 'case:auth-fail',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError &&
        (e as NeryvaProviderError).code === 'AUTH_FAILED' &&
        (e as NeryvaProviderError).retryable === false,
    );
    // Also construction without key fails
    expect(() => createOpenAIAdapter({ simulate: false })).toThrow(/credentials required/);
  });

  it('10 usage — prompt/completion/total + cost normalized', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.usage.promptTokens).toBeGreaterThan(0);
    expect(res.usage.completionTokens).toBeGreaterThan(0);
    expect(res.usage.totalTokens).toBe(res.usage.promptTokens + res.usage.completionTokens);
    expect(res.usage.costCents).toBeGreaterThanOrEqual(0);
    expect(res.usage.providerId).toBe('openai');
  });

  it('11 cancellation — AbortSignal propagates to CANCELLED', async () => {
    const { adapter } = makeGateway();
    const ac = new AbortController();
    ac.abort();
    await expect(
      adapter.generate(
        { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] },
        { signal: ac.signal },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError && (e as NeryvaProviderError).code === 'CANCELLED',
    );
    // Streaming cancellation
    const ac2 = new AbortController();
    const streamPromise = adapter.stream(
      { model: 'openai/gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }] },
      { signal: ac2.signal },
    );
    ac2.abort();
    await expect(streamPromise).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError && (e as NeryvaProviderError).code === 'CANCELLED',
    );
  });

  it('redaction — prompts not logged raw (strict mode)', async () => {
    const { adapter } = makeGateway();
    // Gateway redaction is separate; adapter itself should not log raw, but we verify redaction util
    const { redactObject } = await import('../../src/redaction.js');
    const redacted = redactObject(
      { messages: [{ role: 'user', content: 'secret prompt' }], apiKey: 'sk-123' },
      'strict',
    );
    expect(isRedacted(redacted)).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('secret prompt');
    expect(JSON.stringify(redacted)).not.toContain('sk-123');
    // Still generates
    const res = await adapter.generate({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.text).toBeDefined();
  });

  it('gateway integration — read-only agent run via gateway (bounded loop)', async () => {
    const gw = new ModelGateway();
    const adapter = createOpenAIAdapter({ apiKey: 'test-key' });
    gw.registerAdapter(adapter);
    // Simulate agent run: user message → model → final answer (no tools)
    const res = await gw.generate({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
      policySnapshot: { organizationId: 'org1', allowedModels: ['openai/gpt-4o-mini'] },
      correlationId: 'run_readonly',
      runId: 'run1',
      organizationId: 'org1',
    });
    expect(res.finishReason).toBe('stop');
    expect(res.text).toContain('Hello');
    expect(res.usage.totalTokens).toBeGreaterThan(0);
  });
});
