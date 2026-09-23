/**
 * model-streaming.test.ts — A2-63: callModel streams the model response and
 * emits AssistantChunk run events as text arrives.
 *
 * Pinned behavior:
 * 1. Streaming path: text-deltas are batched into fixed-width chunks,
 *    emitted as AssistantChunk events with deterministic eventIds, and the
 *    activity still returns the canonical finalResponse (deltas never replace
 *    the durable result).
 * 2. Fallback: a failed stream falls back to generate() — the run is not failed.
 * 3. No chunk client / no conversationId / stream:false → generate() only.
 * 4. Chunk append failures are best-effort (model call still succeeds).
 * 5. Deterministic chunking: same input twice → identical eventIds (idempotent
 *    activity retry; Engine dedups on (run_id, event_id)).
 */
import { describe, it, expect } from 'vitest';
import { callModel } from '../src/model-activities.js';
import type { RuntimeEvent } from '@neryva/contracts/events/runtime-events';
import type { NeryvaModelResponse, NeryvaStreamEvent } from '@neryva/contracts/provider/model-response';

const BASE_PARAMS = {
  runId: 'run_stream_1',
  stepId: 'step_1',
  organizationId: 'org_1',
  conversationId: 'conv_1',
  agentVersionId: 'agent_v1',
  correlationId: 'corr_1',
  messages: [{ role: 'user', content: 'hello' }],
} as const;

function finalResponse(text: string): NeryvaModelResponse {
  return {
    id: 'chatcmpl_test',
    model: 'openai/gpt-4o-mini',
    providerId: 'openai',
    text,
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  };
}

function streamingGateway(text: string, opts?: { failStream?: boolean; noFinal?: boolean }) {
  const events: NeryvaStreamEvent[] = [];
  // Yield one text-delta per 50 chars so tests exercise multi-chunk batching
  // deterministically (chunk width is 400 chars).
  for (let i = 0; i < text.length; i += 50) {
    events.push({ type: 'text-delta', delta: text.slice(i, i + 50) });
  }
  events.push({
    type: 'finish',
    finishReason: 'stop',
    usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  });
  async function* gen(): AsyncIterable<NeryvaStreamEvent> {
    for (const e of events) yield e;
  }
  return {
    generate: async () => finalResponse(text),
    stream: async () => {
      if (opts?.failStream) throw new Error('stream boom');
      return {
        stream: gen(),
        ...(opts?.noFinal ? {} : { finalResponse: Promise.resolve(finalResponse(text)) }),
      };
    },
  };
}

function recordingChunkClient(failOn?: number) {
  const events: RuntimeEvent[] = [];
  let calls = 0;
  return {
    events,
    appendRunEvents: async (evts: RuntimeEvent[]) => {
      calls += 1;
      if (failOn !== undefined && calls === failOn) throw new Error('append failed');
      events.push(...evts);
      return {};
    },
  };
}

function chunkBodies(client: { events: RuntimeEvent[] }) {
  return client.events.map((e) => {
    if (e.body.kind !== 'AssistantChunk') throw new Error(`unexpected body kind ${e.body.kind}`);
    return { text: e.body.text, isFinal: e.body.isFinal, eventId: e.eventId, type: e.type };
  });
}

describe('callModel streaming chunks (A2-63)', () => {
  it('emits deterministic AssistantChunk events and returns the final response', async () => {
    const text = 'x'.repeat(950); // 400 + 400 + 150 → 3 chunks
    const gateway = streamingGateway(text);
    const client = recordingChunkClient();
    const res = await callModel({
      ...BASE_PARAMS,
      messages: [...BASE_PARAMS.messages],
      __gateway: gateway,
      __chunkClient: client,
    } as never);

    expect(res.text).toBe(text);
    expect(res.finishReason).toBe('stop');

    const chunks = chunkBodies(client);
    expect(chunks).toHaveLength(3);
    expect(chunks.map((c) => c.text.length)).toEqual([400, 400, 150]);
    expect(chunks.map((c) => c.text).join('')).toBe(text);
    expect(chunks.map((c) => c.isFinal)).toEqual([false, false, true]);
    expect(chunks.every((c) => c.type === 'AssistantChunk')).toBe(true);
    // Deterministic eventIds: stable logical key per chunk index.
    expect(new Set(chunks.map((c) => c.eventId)).size).toBe(3);
  });

  it('produces identical eventIds on replay (idempotent retry)', async () => {
    const text = 'y'.repeat(500);
    const first = recordingChunkClient();
    const second = recordingChunkClient();
    const mkParams = (client: unknown) =>
      ({
        ...BASE_PARAMS,
        messages: [...BASE_PARAMS.messages],
        __gateway: streamingGateway(text),
        __chunkClient: client,
      }) as never;
    await callModel(mkParams(first));
    await callModel(mkParams(second));
    const ids1 = chunkBodies(first).map((c) => c.eventId);
    const ids2 = chunkBodies(second).map((c) => c.eventId);
    expect(ids1).toEqual(ids2);
  });

  it('falls back to generate() when the stream fails', async () => {
    const text = 'fallback text';
    const gateway = streamingGateway(text, { failStream: true });
    const client = recordingChunkClient();
    const res = await callModel({
      ...BASE_PARAMS,
      messages: [...BASE_PARAMS.messages],
      __gateway: gateway,
      __chunkClient: client,
    } as never);
    expect(res.text).toBe(text);
    expect(client.events).toHaveLength(0);
  });

  it('uses generate() without chunks when stream is explicitly disabled', async () => {
    const text = 'no stream';
    const client = recordingChunkClient();
    const res = await callModel({
      ...BASE_PARAMS,
      stream: false,
      messages: [...BASE_PARAMS.messages],
      __gateway: streamingGateway(text),
      __chunkClient: client,
    } as never);
    expect(res.text).toBe(text);
    expect(client.events).toHaveLength(0);
  });

  it('uses generate() without chunks when no chunk client is wired', async () => {
    const text = 'no client';
    const res = await callModel({
      ...BASE_PARAMS,
      messages: [...BASE_PARAMS.messages],
      __gateway: streamingGateway(text),
    } as never);
    expect(res.text).toBe(text);
  });

  it('tolerates chunk append failures (best-effort)', async () => {
    const text = 'z'.repeat(450); // 2 chunks; fail the first append
    const client = recordingChunkClient(1);
    const res = await callModel({
      ...BASE_PARAMS,
      messages: [...BASE_PARAMS.messages],
      __gateway: streamingGateway(text),
      __chunkClient: client,
    } as never);
    expect(res.text).toBe(text);
    // First chunk lost, second still emitted — the model call itself succeeded.
    expect(client.events).toHaveLength(1);
  });

  it('emits a single final chunk for short text', async () => {
    const text = 'short';
    const client = recordingChunkClient();
    await callModel({
      ...BASE_PARAMS,
      messages: [...BASE_PARAMS.messages],
      __gateway: streamingGateway(text),
      __chunkClient: client,
    } as never);
    const chunks = chunkBodies(client);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe(text);
    expect(chunks[0].isFinal).toBe(true);
  });

  it('merges streamed tool calls when finalResponse drops them (lossy adapter)', async () => {
    const toolCall = { id: 'tc_1', name: 'search_tickets', args: { query: 'x' } };
    const events: NeryvaStreamEvent[] = [
      { type: 'tool-call', toolCall },
      {
        type: 'finish',
        finishReason: 'tool-call',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      },
    ];
    async function* gen(): AsyncIterable<NeryvaStreamEvent> {
      for (const e of events) yield e;
    }
    // finalResponse WITHOUT toolCalls — the lossy real-path shape before the fix.
    const lossyFinal: NeryvaModelResponse = {
      id: 'chatcmpl_tool',
      model: 'openai/gpt-4o-mini',
      providerId: 'openai',
      finishReason: 'tool-call',
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    };
    const gateway = {
      generate: async () => lossyFinal,
      stream: async () => ({ stream: gen(), finalResponse: Promise.resolve(lossyFinal) }),
    };
    const res = await callModel({
      ...BASE_PARAMS,
      messages: [...BASE_PARAMS.messages],
      __gateway: gateway,
      __chunkClient: recordingChunkClient(),
    } as never);
    expect(res.finishReason).toBe('tool-call');
    expect(res.toolCalls).toEqual([{ id: 'tc_1', name: 'search_tickets', args: { query: 'x' } }]);
  });

  it('keeps tool calls from finalResponse when the adapter includes them', async () => {
    const toolCall = { id: 'tc_2', name: 'create_ticket', args: { title: 'y' } };
    const events: NeryvaStreamEvent[] = [
      { type: 'tool-call', toolCall },
      {
        type: 'finish',
        finishReason: 'tool-call',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      },
    ];
    async function* gen(): AsyncIterable<NeryvaStreamEvent> {
      for (const e of events) yield e;
    }
    const fullFinal: NeryvaModelResponse = {
      id: 'chatcmpl_tool2',
      model: 'openai/gpt-4o-mini',
      providerId: 'openai',
      finishReason: 'tool-call',
      toolCalls: [toolCall],
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
    };
    const gateway = {
      generate: async () => fullFinal,
      stream: async () => ({ stream: gen(), finalResponse: Promise.resolve(fullFinal) }),
    };
    const res = await callModel({
      ...BASE_PARAMS,
      messages: [...BASE_PARAMS.messages],
      __gateway: gateway,
      __chunkClient: recordingChunkClient(),
    } as never);
    expect(res.toolCalls).toEqual([toolCall]);
  });
});
