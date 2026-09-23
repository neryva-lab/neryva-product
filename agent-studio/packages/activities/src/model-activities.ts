/**
 * model-activities.ts — Model Gateway invocation as Activity (credentials only here)
 * Source: agent_studio_implementation_plan.md:862-886, 408-426, 1427
 * Credentials via @neryva/security secret-provider, never in workflow/logs/definitions/capability claims.
 * Usage via Engine/MCP, not local ledger (gateway normalizes, activities record).
 */

import { heartbeat, isActivityCancelled } from './heartbeat.js';
import { ModelGateway } from '@neryva/model-gateway';
import type { NeryvaModelRequest } from '@neryva/contracts/provider/model-request';
import {
  NeryvaModelResponseSchema,
  type NeryvaModelResponse,
} from '@neryva/contracts/provider/model-response';
import type { NeryvaToolCall } from '@neryva/contracts/provider/tool-call';
import type { SecretProvider, SecretRef } from '@neryva/security';
import {
  createRuntimeEvent,
  type RuntimeEvent,
} from '@neryva/contracts/events/runtime-events';
import { incrementCounter } from '@neryva/telemetry';

export interface ModelActivitiesOptions {
  gateway: ModelGateway;
  secretProvider?: SecretProvider | undefined;
}

/**
 * Structural surface for emitting assistant-chunk events — satisfied by
 * NeryvaMcpClient and by the runtime-worker's run-scoped client proxy (no
 * package dependency needed, same pattern as EngineCredentialClient below).
 */
export interface AssistantChunkClient {
  appendRunEvents(events: RuntimeEvent[]): Promise<unknown>;
}

export interface ModelCallParams extends Omit<NeryvaModelRequest, 'model'> {
  model?: string | undefined;
  runId: string;
  stepId: string;
  organizationId: string;
  /** Required for AssistantChunk emission (Engine event scope). */
  conversationId?: string | undefined;
  agentVersionId: string;
  correlationId?: string | undefined;
  // Policy snapshot for routing (org allowlist)
  policySnapshot?: { organizationId: string; allowedModels: string[] } | undefined;
}

export interface ModelCallResult extends NeryvaModelResponse {
  stepId: string;
}

/**
 * Deep-convert a gateway result into plain JSON-safe data BEFORE it crosses
 * the activity→workflow boundary. Temporal's default payload converter only
 * handles JSON values: a bigint anywhere (e.g. a provider SDK usage counter),
 * a class instance, a function, or a circular reference fails the activity
 * with "Unable to convert [object Object] to payload" — a cryptic,
 * non-retryable-looking error that actually originates at the boundary, not
 * in the provider call. Sanitizing here fails loudly with a precise message
 * instead, and guarantees the workflow only ever sees contract-shaped data.
 *
 * Rules: bigint → number ONLY inside the safe integer range; a bigint past
 * MAX_SAFE_INTEGER is rejected loudly (silent precision loss is corruption);
 * class instances → plain objects with their own enumerable props;
 * functions/symbols/undefined → dropped from objects, null in arrays;
 * circular → throws NON_SERIALIZABLE_RESULT.
 */
export function toTemporalSafeJson<T>(value: T): T {
  return cloneJsonSafe(value, new WeakSet()) as T;
}

function cloneJsonSafe(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new Error(
        `NON_SERIALIZABLE_RESULT: bigint ${value.toString()} is outside the safe integer ` +
          'range — refusing to lose precision at the workflow boundary',
      );
    }
    return Number(value);
  }
  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'object') return undefined; // functions, symbols — dropped
  if (seen.has(value)) {
    throw new Error(
      'NON_SERIALIZABLE_RESULT: circular structure in model gateway response — ' +
        'the workflow boundary only accepts plain JSON',
    );
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((entry) => {
        const cloned = cloneJsonSafe(entry, seen);
        return cloned === undefined ? null : cloned;
      });
    }
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const cloned = cloneJsonSafe(entry, seen);
      if (cloned !== undefined) out[key] = cloned;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Project a gateway result onto the explicit ModelCallResult contract BEFORE
 * it crosses the activity→workflow boundary. Two layers:
 *
 * 1. toTemporalSafeJson — recursive normalization (bigint→number with unsafe
 *    rejection, class→plain, circular→throw). Handles the open-ended contract
 *    fields (tool args, structured output) where the gateway may hand us
 *    provider-SDK-shaped data.
 * 2. NeryvaModelResponseSchema.parse — validates the normalized result and
 *    strips any unknown keys, so SDK internals (rawResponse, provider extras)
 *    can never leak across, no matter what the gateway returned.
 * 3. Explicit field-by-field projection — the return object names every
 *    contract field; nothing crosses by spread.
 *
 * Any violation fails loudly here instead of as "Unable to convert
 * [object Object] to payload" inside Temporal's converter.
 */
export function projectModelCallResult(
  result: NeryvaModelResponse,
  stepId: string,
): ModelCallResult {
  const normalized = toTemporalSafeJson(result);
  const parsed = NeryvaModelResponseSchema.parse(normalized);
  const projectToolCall = (tc: NeryvaToolCall): NeryvaToolCall => ({
    id: tc.id,
    name: tc.name,
    args: tc.args,
    ...(tc.argsJson !== undefined ? { argsJson: tc.argsJson } : {}),
  });
  return {
    id: parsed.id,
    model: parsed.model,
    providerId: parsed.providerId,
    text: parsed.text,
    toolCalls: parsed.toolCalls?.map(projectToolCall),
    structuredOutput: parsed.structuredOutput,
    structuredOutputRefusal: parsed.structuredOutputRefusal,
    finishReason: parsed.finishReason,
    usage: {
      promptTokens: parsed.usage.promptTokens,
      completionTokens: parsed.usage.completionTokens,
      totalTokens: parsed.usage.totalTokens,
      cachedTokens: parsed.usage.cachedTokens,
      reasoningTokens: parsed.usage.reasoningTokens,
      costCents: parsed.usage.costCents,
      currency: parsed.usage.currency,
      providerId: parsed.usage.providerId,
      modelId: parsed.usage.modelId,
    },
    providerFinishReason: parsed.providerFinishReason,
    latencyMs: parsed.latencyMs,
    isTruncated: parsed.isTruncated,
    stepId,
  };
}
/**
 * Single Model Gateway Activity — gateway handles routing, redaction, retry, usage normalization, cost.
 * Workflow calls this via proxyActivities; Activity handles network + credentials + heartbeat.
 * The result crosses the boundary only via projectModelCallResult (explicit
 * contract projection), never by spreading the raw gateway result.
 */
export async function callModel(params: ModelCallParams): Promise<ModelCallResult> {
  heartbeat({ step: 'callModel:start', runId: params.runId, stepId: params.stepId });
  if (isActivityCancelled()) {
    const { NeryvaProviderError } = await import('@neryva/contracts/provider/errors');
    throw new NeryvaProviderError({
      code: 'CANCELLED',
      message: 'cancelled before model call',
      retryable: false,
      providerId: undefined,
    });
  }

  // Build gateway request — merge NeryvaModelRequest with routing context
  // In production, gateway would resolve secret via secretProvider at call time (not in workflow)
  // For tests, gateway is created with dummy key; secretProvider is optional
  const gateway = getGateway(params);
  const effectiveModel = params.model ?? 'openai/gpt-4o-mini';
  const request: NeryvaModelRequest & Record<string, unknown> = {
    model: effectiveModel,
    messages: params.messages,
    tools: params.tools,
    toolChoice: params.toolChoice,
    structuredOutput: params.structuredOutput,
    temperature: params.temperature,
    topP: params.topP,
    maxTokens: params.maxTokens,
    stream: params.stream,
    timeoutMs: params.timeoutMs,
    correlationId: params.correlationId ?? params.runId,
    runId: params.runId,
    organizationId: params.organizationId,
    policySnapshot: params.policySnapshot,
  } as NeryvaModelRequest & Record<string, unknown>;

  // Heartbeat during generation
  const result = await generateWithChunkStreaming(gateway, request, params);
  heartbeat({ step: 'callModel:done', runId: params.runId, finishReason: result.finishReason });

  // Usage is normalized by gateway (costCents attached); activities will RecordUsage via MCP separately
  // Here we just return result; caller (workflow) will appendRunEvents and Activities will recordUsage in next step.
  // Boundary: explicit contract projection — the workflow must never see SDK
  // internals that Temporal cannot serialize (see projectModelCallResult).
  return projectModelCallResult(result, params.stepId);
}

/**
 * Fixed chunk width for AssistantChunk emission. Chunk boundaries are
 * deterministic (character count, never timing): an activity retry replays
 * the same stream into the same chunks, and chunk eventIds derive from
 * (runId, stepId, chunk index) — Engine dedups on (run_id, event_id), so
 * retried streams are idempotent. 400 chars is far under the 8192-char
 * AssistantChunkBody limit and keeps per-event DB rows small.
 */
const ASSISTANT_CHUNK_FLUSH_CHARS = 400;

/**
 * A2-63 — stream the model response and emit AssistantChunk run events as
 * text arrives, so the Engine's SSE `delta` channel carries live tokens
 * (ENGINE SSE_EVENT_NAMES['2'] = 'delta' ← EVENT_TYPE_ASSISTANT_CHUNK).
 *
 * Invariants:
 * - The streamed deltas are progressive hints only. The canonical result is
 *   ALWAYS gateway.finalResponse (or generate() on fallback); the durable
 *   assistant message goes through commitRunResult, never through deltas.
 * - Chunk emission is best-effort: a failed append never fails the model call.
 * - If streaming is unavailable (explicit opt-out, no chunk client, or no
 *   conversationId for event scope), or the stream errors, fall back to the
 *   previous non-streaming generate() behavior — the ModelCallResult contract
 *   is unchanged either way.
 */
async function generateWithChunkStreaming(
  gateway: ModelGateway,
  request: NeryvaModelRequest & Record<string, unknown>,
  params: ModelCallParams,
): Promise<NeryvaModelResponse> {
  const chunkClient =
    (params as unknown as { __chunkClient?: AssistantChunkClient }).__chunkClient ??
    globalChunkClient;
  const conversationId = params.conversationId;
  if (params.stream === false || !chunkClient || !conversationId) {
    return gateway.generate(request, { signal: undefined });
  }
  const producerId =
    (params as unknown as { __chunkProducerId?: string }).__chunkProducerId ??
    globalChunkProducerId ??
    'runtime-worker';
  const correlationId = params.correlationId ?? params.runId;
  try {
    const streamResult = await gateway.stream(request, { signal: undefined });
    let pending = '';
    let chunkIndex = 0;
    // Tool calls observed on the stream — merged into the result below as
    // defense-in-depth (finalResponse is adapter-dependent and optional).
    const streamedToolCalls: Array<{ id: string; name: string; args: unknown }> = [];
    const emitChunk = async (text: string, isFinal: boolean): Promise<void> => {
      if (!text) return;
      const event = createRuntimeEvent(
        {
          runId: params.runId,
          organizationId: params.organizationId,
          conversationId,
          stepId: params.stepId,
          type: 'AssistantChunk',
          producerId,
          correlationId,
          // Deterministic logical key → deterministic eventId → idempotent replay.
          idempotencyLogical: `chunk:${chunkIndex}`,
        },
        { kind: 'AssistantChunk', runId: params.runId, text, isFinal },
      );
      chunkIndex += 1;
      try {
        await chunkClient.appendRunEvents([event]);
        incrementCounter('run_events_appended_total', { type: 'AssistantChunk', outcome: 'success' });
      } catch {
        // Progressive hint only; the durable final message is committed
        // separately. Never fail the model call because a chunk append failed.
        incrementCounter('run_events_appended_total', { type: 'AssistantChunk', outcome: 'error' });
      }
      heartbeat({ step: 'callModel:stream', runId: params.runId, chunkIndex });
    };
    for await (const streamEvent of streamResult.stream) {
      if (streamEvent.type === 'text-delta') {
        pending += streamEvent.delta;
        if (pending.length >= ASSISTANT_CHUNK_FLUSH_CHARS) {
          const flushText = pending;
          pending = '';
          await emitChunk(flushText, false);
        }
      } else if (streamEvent.type === 'tool-call') {
        const tc = streamEvent.toolCall;
        streamedToolCalls.push({ id: tc.id, name: tc.name, args: tc.args ?? {} });
      } else if (streamEvent.type === 'error') {
        throw new Error(`model stream error: ${streamEvent.error}`);
      }
      // tool-call-delta / finish are consumed via finalResponse below.
    }
    await emitChunk(pending, true);
    if (streamResult.finalResponse) {
      const final = await streamResult.finalResponse;
      // Never let a lossy finalResponse silently drop the tool loop: if the
      // stream carried tool calls, they must be on the result.
      if (streamedToolCalls.length > 0 && (final.toolCalls ?? []).length === 0) {
        return {
          ...final,
          toolCalls: streamedToolCalls,
          finishReason: 'tool-call',
        };
      }
      return final;
    }
    // Defensive: adapter streamed without a final response — re-run
    // non-streaming rather than reassembling (usage/costing stays canonical).
    incrementCounter('model_route_fallback_total', { reason: 'stream_no_final_response' });
    return gateway.generate(request, { signal: undefined });
  } catch (e) {
    // Streaming is an enhancement; a failed stream must not fail the run.
    incrementCounter('model_route_fallback_total', { reason: 'stream_error' });
    heartbeat({ step: 'callModel:streamFallback', runId: params.runId });
    void e;
    return gateway.generate(request, { signal: undefined });
  }
}

// For tests without DI, use global gateway singleton (created with dummy openai adapter)
let globalGateway: ModelGateway | undefined;
function getGateway(params: ModelCallParams): ModelGateway {
  // If caller passed gateway via param (for DI), use it; else global
  // We store gateway on params via hidden field for test injection — simpler: use global
  if ((params as unknown as { __gateway?: ModelGateway }).__gateway) {
    return (params as unknown as { __gateway: ModelGateway }).__gateway;
  }
  if (!globalGateway) globalGateway = new ModelGateway();
  return globalGateway;
}

/**
 * REL-1.5 (engine release_ledger.md) — Engine-side credential disclosure
 * adapter. The Engine discloses model-provider keys ONLY through its audited
 * GetToolCredential RPC under the pseudo-tool name `model:<provider>` — the
 * SecretRef IS that pseudo-tool name, resolved per call (never cached, never
 * logged). An empty credential means the run's manifest does not pin the
 * provider or the org has no active key: fail loudly as
 * PROVIDER_CREDENTIAL_MISSING instead of silently sending no auth.
 */
export class EngineSecretProvider implements SecretProvider {
  constructor(private readonly client: EngineCredentialClient) {}
  async resolve(ref: SecretRef): Promise<string> {
    const response = (await this.client.getToolCredential({ toolName: ref.ref })) as {
      credential?: unknown;
    } | null;
    const credential = typeof response?.credential === 'string' ? response.credential : '';
    if (credential.length === 0) {
      throw new Error(
        `PROVIDER_CREDENTIAL_MISSING: engine disclosed no credential for ${ref.ref} — pin the provider on the run manifest and provision a key`,
      );
    }
    return credential;
  }
}

/** REL-1.5 — structural surface satisfied by NeryvaMcpClient (no package dependency needed). */
export interface EngineCredentialClient {
  getToolCredential(params: { toolName: string }): Promise<unknown>;
}

/** REL-1.5 — every providerId resolves to the Engine disclosure rail `model:<providerId>`. */
export function engineCredentialRefs(): Record<string, string> {
  return new Proxy({} as Record<string, string>, {
    get: (_target, providerId) => `model:${String(providerId)}`,
  });
}

// Module-global chunk emission wiring (mirrors the __gateway pattern above):
// createModelActivities installs the run-scoped client once; callModel params
// may override per-invocation via the __chunkClient hidden field (tests).
let globalChunkClient: AssistantChunkClient | undefined;
let globalChunkProducerId: string | undefined;

export interface CreateModelActivitiesOptions {
  chunkClient?: AssistantChunkClient | undefined;
  producerId?: string | undefined;
}

export function createModelActivities(
  gateway?: ModelGateway,
  secretProvider?: SecretProvider,
  opts?: CreateModelActivitiesOptions,
) {
  if (gateway) globalGateway = gateway;
  // REL-1.5 — production construction: no test adapters, every provider key
  // resolved per call through the Engine's audited disclosure rail.
  if (!gateway && secretProvider) {
    globalGateway = new ModelGateway({
      allowTestCredentials: false,
      secretProvider,
      credentialRefs: engineCredentialRefs(),
    });
  }
  if (!globalGateway) globalGateway = new ModelGateway();
  if (opts?.chunkClient) globalChunkClient = opts.chunkClient;
  if (opts?.producerId) globalChunkProducerId = opts.producerId;
  return { callModel };
}

export type ModelActivities = ReturnType<typeof createModelActivities>;
