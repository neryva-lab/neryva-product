/**
 * model-serialization.test.ts — the callModel activity boundary returns only
 * Temporal-serializable data.
 *
 * Regression for the Wave 4 smoke failure ("Unable to convert [object Object]
 * to payload"): Temporal's default payload converter accepts JSON values
 * only. A bigint, class instance, function, or circular reference anywhere in
 * an activity result (or arg) fails conversion — and when the failure is in
 * an activity ARG the error surfaces inside the workflow's scheduler, which
 * misdirects the diagnosis at the model-response boundary. callModel now
 * sanitizes via toTemporalSafeJson; these tests pin that contract against
 * the REAL converter (defaultPayloadConverter), not a reimplementation.
 */
import { describe, it, expect } from 'vitest';
import { defaultPayloadConverter } from '@temporalio/common';
import { callModel, projectModelCallResult, toTemporalSafeJson } from '../src/model-activities.js';

const converter = defaultPayloadConverter;

function assertConverterAccepts(value: unknown): void {
  // Throws "Unable to convert [object Object] to payload" on non-JSON values.
  const payload = converter.toPayload(value);
  expect(payload).toBeDefined();
  if (payload === undefined) throw new Error('expected a payload');
  expect(converter.fromPayload(payload)).toEqual(JSON.parse(JSON.stringify(value)));
}

describe('toTemporalSafeJson', () => {
  it('converts bigint to number, deeply', () => {
    const input = {
      usage: { promptTokens: 40n, completionTokens: 12n, costCents: 1n },
      toolCalls: [{ id: 'c1', args: { n: 3n } }],
    };
    const out = toTemporalSafeJson(input);
    expect(out.usage.promptTokens).toBe(40);
    expect(typeof out.usage.costCents).toBe('number');
    expect(out.toolCalls[0].args.n).toBe(3);
  });

  it('flattens class instances to plain objects', () => {
    class Usage {
      constructor(public promptTokens: number) {}
      total() {
        return this.promptTokens;
      }
    }
    const out = toTemporalSafeJson({ usage: new Usage(40) as unknown });
    expect(out.usage).toEqual({ promptTokens: 40 });
    expect(Object.getPrototypeOf(out.usage)).toBe(Object.prototype);
  });

  it('drops functions, symbols, and undefined object props', () => {
    const out = toTemporalSafeJson({
      text: 'hi',
      fn: (() => 1) as unknown,
      sym: Symbol('s') as unknown,
      missing: undefined,
      list: [undefined as unknown, 1],
    });
    expect(out).toEqual({ text: 'hi', list: [null, 1] });
    expect('fn' in out).toBe(false);
    expect('missing' in out).toBe(false);
  });

  it('throws a precise error on circular structures, not the converter message', () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => toTemporalSafeJson(circular)).toThrow(/NON_SERIALIZABLE_RESULT/);
    expect(() => toTemporalSafeJson(circular)).not.toThrow(/Unable to convert/);
  });

  it('tolerates shared (non-circular) references', () => {
    const shared = { n: 1 };
    const out = toTemporalSafeJson({ x: shared, y: shared });
    expect(out).toEqual({ x: { n: 1 }, y: { n: 1 } });
  });

  it('rejects bigint beyond MAX_SAFE_INTEGER instead of losing precision', () => {
    const unsafe = { usage: { promptTokens: BigInt(Number.MAX_SAFE_INTEGER) + 1n } };
    expect(() => toTemporalSafeJson(unsafe)).toThrow(/NON_SERIALIZABLE_RESULT/);
    expect(() => toTemporalSafeJson(unsafe)).not.toThrow(/Unable to convert/);
  });

  it('rejects negative-out-of-range bigint symmetrically', () => {
    const unsafe = { v: BigInt(Number.MIN_SAFE_INTEGER) - 1n };
    expect(() => toTemporalSafeJson(unsafe)).toThrow(/NON_SERIALIZABLE_RESULT/);
  });
});

describe('projectModelCallResult', () => {
  const base = {
    model: 'openai/gpt-4o-mini',
    providerId: 'openai',
    finishReason: 'stop' as const,
    usage: { promptTokens: 40, completionTokens: 12, totalTokens: 52, costCents: 1 },
  };

  it('strips SDK-internal fields that are not on the contract', () => {
    const withInternals = {
      ...base,
      rawResponse: { choices: [{ index: 0 }] },
      _providerSecret: 'must-not-cross',
      toolCalls: [
        { id: 'call_1', name: 'search_tickets', args: { query: 'smoke' }, providerCallId: 'call_1' },
      ],
    };
    const out = projectModelCallResult(withInternals as never, 's1');
    expect(out).not.toHaveProperty('rawResponse');
    expect(out).not.toHaveProperty('_providerSecret');
    expect(out.toolCalls?.[0]).not.toHaveProperty('providerCallId');
    expect(out.toolCalls?.[0]).toEqual({ id: 'call_1', name: 'search_tickets', args: { query: 'smoke' } });
    expect(out.stepId).toBe('s1');
    expect(out.model).toBe('openai/gpt-4o-mini');
  });

  it('fails loudly on contract violations (missing required field)', () => {
    const missing = { ...base, usage: undefined };
    expect(() => projectModelCallResult(missing as never, 's1')).toThrow();
  });

  it('converts safe bigints inside tool args during projection', () => {
    const withBigintArgs = {
      ...base,
      toolCalls: [{ id: 'c1', name: 'search_tickets', args: { limit: 5n } }],
    };
    const out = projectModelCallResult(withBigintArgs as never, 's1');
    expect(out.toolCalls?.[0]?.args).toEqual({ limit: 5 });
  });

  it('rejects unsafe bigint inside tool args during projection', () => {
    const withUnsafe = {
      ...base,
      toolCalls: [{ id: 'c1', name: 'search_tickets', args: { n: BigInt(Number.MAX_SAFE_INTEGER) + 1n } }],
    };
    expect(() => projectModelCallResult(withUnsafe as never, 's1')).toThrow(/NON_SERIALIZABLE_RESULT/);
  });

  it('projected results are accepted by the real Temporal converter', () => {
    const out = projectModelCallResult(
      { ...base, id: 'gen_1', text: 'done', providerFinishReason: 'stop', latencyMs: 3 } as never,
      's9',
    );
    const payload = converter.toPayload(out);
    expect(payload).toBeDefined();
    if (payload === undefined) throw new Error('expected a payload');
    expect(converter.fromPayload(payload)).toEqual(JSON.parse(JSON.stringify(out)));
  });
});

describe('Temporal payload converter acceptance', () => {
  it('rejects a raw bigint arg — the documented root cause', () => {
    // Characterization of the SDK: this is exactly what failed in the Wave 4
    // smoke run when the workflow scheduled commitRunResult with a bigint
    // expectedVersion. Guards the "numbers only" invariant above.
    expect(() => converter.toPayload({ expectedVersion: 3n })).toThrow(/Unable to convert/);
  });

  it('rejects a raw bigint leaseEpoch arg as well', () => {
    // Same root cause on the lease-release path: _releaseRunLease scheduled
    // with a bigint leaseEpoch fails inside scheduleActivityNextHandler.
    expect(() => converter.toPayload({ leaseEpoch: 3n })).toThrow(/Unable to convert/);
  });

  it('accepts the sanitized exact fake-provider response shape', () => {
    // Mirrors the shape realGenerate produces against the local fake:
    // tool call with parsed args object + usage with costCents.
    const sanitized = toTemporalSafeJson({
      id: 'gen_repro-serialize',
      model: 'openai/gpt-4o-mini',
      providerId: 'openai',
      text: '',
      toolCalls: [
        {
          id: 'call_1',
          name: 'search_tickets',
          args: { query: 'smoke', limit: 5 },
          providerCallId: 'call_1',
        },
      ],
      finishReason: 'tool-call',
      usage: {
        promptTokens: 40,
        completionTokens: 12,
        totalTokens: 52,
        cachedTokens: undefined,
        providerId: undefined,
        modelId: undefined,
        costCents: 1,
      },
      providerFinishReason: 'stop',
      latencyMs: 0,
    });
    assertConverterAccepts(sanitized);
  });

  it('accepts a bigint-poisoned gateway result after sanitization', () => {
    const poisoned = {
      id: 'gen_x',
      model: 'openai/gpt-4o-mini',
      providerId: 'openai',
      text: 'done',
      toolCalls: [],
      finishReason: 'stop' as const,
      usage: { promptTokens: 40n, completionTokens: 12n, totalTokens: 52n, costCents: 1n },
      providerFinishReason: 'stop' as const,
      latencyMs: 0,
    };
    // Before the fix this is what crossed the boundary and failed conversion:
    expect(() => converter.toPayload(poisoned)).toThrow(/Unable to convert/);
    assertConverterAccepts(toTemporalSafeJson(poisoned));
  });
});

describe('callModel boundary', () => {
  it('returns a converter-acceptable result even when the gateway returns bigints', async () => {
    const poisonedGateway = {
      generate: async () => ({
        id: 'gen_x',
        model: 'openai/gpt-4o-mini',
        providerId: 'openai',
        text: 'done',
        toolCalls: [],
        finishReason: 'stop' as const,
        usage: { promptTokens: 40n, completionTokens: 12n, totalTokens: 52n, costCents: 1n },
        providerFinishReason: 'stop' as const,
        latencyMs: 0,
      }),
    };
    const res = await callModel({
      runId: 'run1',
      stepId: 's1',
      organizationId: 'org1',
      agentVersionId: 'agent_v1',
      messages: [{ role: 'user', content: 'hello' }],
      __gateway: poisonedGateway,
    } as never);
    expect(res.finishReason).toBe('stop');
    assertConverterAccepts(res);
    expect(res.usage.costCents).toBe(1);
  });
});
