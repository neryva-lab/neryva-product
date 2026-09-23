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

export interface ModelActivitiesOptions {
  gateway: ModelGateway;
  secretProvider?: SecretProvider | undefined;
}

export interface ModelCallParams extends Omit<NeryvaModelRequest, 'model'> {
  model?: string | undefined;
  runId: string;
  stepId: string;
  organizationId: string;
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
  const result = await gateway.generate(request, { signal: undefined });
  heartbeat({ step: 'callModel:done', runId: params.runId, finishReason: result.finishReason });

  // Usage is normalized by gateway (costCents attached); activities will RecordUsage via MCP separately
  // Here we just return result; caller (workflow) will appendRunEvents and Activities will recordUsage in next step.
  // Boundary: explicit contract projection — the workflow must never see SDK
  // internals that Temporal cannot serialize (see projectModelCallResult).
  return projectModelCallResult(result, params.stepId);
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

export function createModelActivities(gateway?: ModelGateway, secretProvider?: SecretProvider) {
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
  return { callModel };
}

export type ModelActivities = ReturnType<typeof createModelActivities>;
