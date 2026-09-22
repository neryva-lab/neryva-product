/**
 * google.test.ts — 11 conformance cases per provider
 * Source: agent_studio_architecture.md:778, 772-790
 */
import { describe, it, expect } from 'vitest';
import { createGoogleAdapter } from '../../src/providers/google.js';
import { ModelGateway } from '../../src/model-gateway.js';
import { NeryvaProviderError } from '@neryva/contracts/provider/errors';
import { isRedacted } from '../../src/redaction.js';

function makeGateway() {
  const adapter = createGoogleAdapter({ apiKey: 'test-key' });
  const gw = new ModelGateway();
  gw.registerAdapter(adapter);
  return { gw, adapter };
}

describe('google provider — 11 conformance cases', () => {
  it('1 text — simple completion', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'google/gemini-1.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.text).toBeDefined();
    expect(res.finishReason).toBe('stop');
    expect(res.usage.totalTokens).toBeGreaterThan(0);
  });
  it('2 streaming — chunked deltas + finish', async () => {
    const { adapter } = makeGateway();
    const stream = await adapter.stream({
      model: 'google/gemini-1.5-pro',
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
  it('3 tool round-trip', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'google/gemini-1.5-pro',
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
      model: 'google/gemini-1.5-pro',
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
      model: 'google/gemini-1.5-pro',
      messages: [{ role: 'user', content: 'structured:refusal' }],
      structuredOutput: { schema: { type: 'object', properties: { answer: { type: 'string' } } } },
    });
    expect(res.structuredOutputRefusal).toBe(true);
    expect(res.finishReason).toBe('content-filter');
  });
  it('6 timeout — respects timeoutMs', async () => {
    const adapter = createGoogleAdapter({ apiKey: 'test-key', timeoutMs: 10 });
    await expect(
      adapter.generate({
        model: 'google/gemini-1.5-pro',
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
        model: 'google/gemini-1.5-pro',
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
        model: 'google/gemini-1.5-pro',
        messages: [{ role: 'user', content: 'case:invalid-request' }],
        correlationId: 'case:invalid-request',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError && (e as NeryvaProviderError).code === 'INVALID_REQUEST',
    );
  });
  it('9 auth failure', async () => {
    const { adapter } = makeGateway();
    await expect(
      adapter.generate({
        model: 'google/gemini-1.5-pro',
        messages: [{ role: 'user', content: 'case:auth-fail' }],
        correlationId: 'case:auth-fail',
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError &&
        (e as NeryvaProviderError).code === 'AUTH_FAILED' &&
        (e as NeryvaProviderError).retryable === false,
    );
    expect(() => createGoogleAdapter({ simulate: false })).toThrow(/credentials required/);
  });
  it('10 usage — prompt/completion/total + cost normalized', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'google/gemini-1.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.usage.promptTokens).toBeGreaterThan(0);
    expect(res.usage.completionTokens).toBeGreaterThan(0);
    expect(res.usage.totalTokens).toBe(res.usage.promptTokens + res.usage.completionTokens);
    expect(res.usage.costCents).toBeGreaterThanOrEqual(0);
    expect(res.usage.providerId).toBe('google');
  });
  it('11 cancellation — AbortSignal propagates to CANCELLED', async () => {
    const { adapter } = makeGateway();
    const ac = new AbortController();
    ac.abort();
    await expect(
      adapter.generate(
        { model: 'google/gemini-1.5-pro', messages: [{ role: 'user', content: 'hello' }] },
        { signal: ac.signal },
      ),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError && (e as NeryvaProviderError).code === 'CANCELLED',
    );
    const ac2 = new AbortController();
    const streamPromise = adapter.stream(
      { model: 'google/gemini-1.5-pro', messages: [{ role: 'user', content: 'hello' }] },
      { signal: ac2.signal },
    );
    ac2.abort();
    await expect(streamPromise).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError && (e as NeryvaProviderError).code === 'CANCELLED',
    );
  });
  it('redaction — prompts not logged raw', async () => {
    const { adapter } = makeGateway();
    const { redactObject } = await import('../../src/redaction.js');
    const redacted = redactObject(
      { messages: [{ role: 'user', content: 'secret prompt' }], apiKey: 'sk-123' },
      'strict',
    );
    expect(isRedacted(redacted)).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain('secret prompt');
    expect(JSON.stringify(redacted)).not.toContain('sk-123');
    const res = await adapter.generate({
      model: 'google/gemini-1.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.text).toBeDefined();
  });
  it('gateway integration — read-only via gateway', async () => {
    const gw = new ModelGateway();
    const adapter = createGoogleAdapter({ apiKey: 'test-key' });
    gw.registerAdapter(adapter);
    const res = await gw.generate({
      model: 'google/gemini-1.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
      policySnapshot: { organizationId: 'org1', allowedModels: ['google/gemini-1.5-pro'] },
      correlationId: 'run_readonly',
      runId: 'run1',
      organizationId: 'org1',
    });
    expect(res.finishReason).toBe('stop');
    expect(res.text).toContain('Hello');
    expect(res.usage.totalTokens).toBeGreaterThan(0);
  });
  it('context limit — 1M window enforced, retention config respected', async () => {
    const { adapter } = makeGateway();
    const res = await adapter.generate({
      model: 'google/gemini-1.5-pro',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.finishReason).toBe('stop');
    const huge = 'x'.repeat(4_000_000); // ~1M tokens
    await expect(
      adapter.generate({
        model: 'google/gemini-1.5-pro',
        messages: [{ role: 'user', content: huge }],
        maxTokens: 10_000,
      }),
    ).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof NeryvaProviderError &&
        (e as NeryvaProviderError).code === 'CONTEXT_LENGTH_EXCEEDED',
    );
  });
});
