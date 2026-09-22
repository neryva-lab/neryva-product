/**
 * litellm.ts — LiteLLM proxy adapter (unified 100+ providers via OpenAI-compatible gateway)
 * Source: LiteLLM docs https://docs.litellm.ai/docs/ (single unified interface to 100+ LLMs using OpenAI format),
 * https://docs.litellm.ai/docs/simple_proxy (Proxy Server/LLM Gateway to call 100+ LLMs, virtual keys, spend tracking, guardrails, load balancing),
 * https://docs.litellm.ai/docs/routing-load-balancing / https://docs.litellm.ai/docs/routing (Router for load balancing, retries, fallbacks across multiple deployments),
 * https://docs.litellm.ai/docs/providers (100+ providers: openai, anthropic, gemini, bedrock, azure, groq, mistral, cohere, together_ai, etc.),
 * agent_studio_architecture.md:444 (LiteLLM may be evaluated as optional self-hosted gateway route for deployments that need separate provider boundary; must remain behind Model Gateway contract, not core), 486 (separate network boundary)
 * LiteLLM is open-source Python SDK + Proxy Server; Studio uses Proxy's OpenAI-compatible endpoint (baseUrl) so TypeScript runtime stays Node LTS without Python dependency.
 * For customers requiring separate network boundary / enterprise self-hosted gateway with virtual keys, cost tracking, guardrails, routing/failover — otherwise direct adapters are used.
 */
import { messageText, type NeryvaModelRequest } from '@neryva/contracts/provider/model-request';
import type {
  NeryvaModelResponse,
  NeryvaStreamResult,
  NeryvaStreamEvent,
} from '@neryva/contracts/provider/model-response';
import type { ProviderAdapter, ProviderFactoryOptions } from './provider.js';
import { isSimulationMode } from './provider.js';
import { realGenerate, realStream } from '../adapters/real-provider.js';
import { NeryvaProviderError } from '@neryva/contracts/provider/errors';
import { normalizeProviderUsage, attachCost } from '../usage.js';
import { redactObject } from '../redaction.js';
import { fromAiSdkResult, mapAiSdkError } from '../adapters/ai-sdk-adapter.js';
import { LITELLM_CAPABILITIES } from '../capabilities.js';

export interface LiteLLMOptions extends ProviderFactoryOptions {
  baseUrl?: string | undefined; // e.g., http://localhost:4000
  virtualKey?: string | undefined; // LiteLLM virtual key (mapped to provider keys via config.yaml)
}

function isLiteLLMModel(modelId: string): boolean {
  return modelId.startsWith('litellm/');
}

function resolveLiteLLMCapability(
  modelId: string,
): (typeof LITELLM_CAPABILITIES)[number] | undefined {
  // Direct match
  const direct = LITELLM_CAPABILITIES.find(
    (c: (typeof LITELLM_CAPABILITIES)[number]) => c.modelId === modelId,
  );
  if (direct) return direct;
  // Generic litellm/* fallback: map underlying provider suffix to closest known
  if (isLiteLLMModel(modelId)) {
    const suffix = modelId.replace('litellm/', '');
    // Try match by suffix containing provider model
    return (
      LITELLM_CAPABILITIES.find((c: (typeof LITELLM_CAPABILITIES)[number]) =>
        suffix.includes(c.modelId.split('/')[1] ?? ''),
      ) ?? LITELLM_CAPABILITIES[0]
    );
  }
  return undefined;
}

export function createLiteLLMAdapter(opts: LiteLLMOptions): ProviderAdapter {
  const { apiKey, baseUrl = 'http://localhost:4000', virtualKey, timeoutMs = 30_000 } = opts;
  const simulate = isSimulationMode(opts);
  const getApiKey: () => Promise<string> = opts.getApiKey ?? (async () => apiKey ?? '');
  // LiteLLM proxy uses OpenAI-compatible auth: apiKey is virtual key or provider key; for tests dummy is ok
  const effectiveKey = virtualKey ?? apiKey;
  if (!simulate && !effectiveKey && !opts.getApiKey)
    throw new NeryvaProviderError({
      code: 'AUTH_FAILED',
      message: 'LiteLLM credentials required (virtualKey/apiKey/getApiKey) for real mode',
      retryable: false,
      providerId: 'litellm',
    });
  const healthy = true;

  function validate(request: NeryvaModelRequest): void {
    // LiteLLM fronts 100+ providers (ADR-009) — any model id is routable
    // through the proxy; capability metadata is advisory. The context-window
    // check applies only when the model is in the local capability catalog,
    // so customer-chosen models outside the seed list are not rejected.
    const cap = resolveLiteLLMCapability(request.model);
    if (cap) {
      const estimatedTokens =
        request.messages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0) +
        (request.maxTokens ?? 0);
      if (estimatedTokens > cap.contextWindow)
        throw new NeryvaProviderError({
          code: 'CONTEXT_LENGTH_EXCEEDED',
          message: `estimated ${estimatedTokens} > ${cap.contextWindow}`,
          retryable: false,
          providerId: 'litellm',
        });
    }
    if (request.tools && request.tools.length > 32)
      throw new NeryvaProviderError({
        code: 'INVALID_REQUEST',
        message: 'too many tools',
        retryable: false,
        providerId: 'litellm',
      });
    void baseUrl; // In production, baseUrl is used for fetch to LiteLLM proxy's /v1/chat/completions
  }

  async function callLiteLLMProxy(request: NeryvaModelRequest): Promise<Record<string, unknown>> {
    // Deterministic fake for unit tests (no live Proxy); production would do:
    // const res = await fetch(`${baseUrl}/v1/chat/completions`, { method:'POST', headers:{Authorization:`Bearer ${effectiveKey}`, 'Content-Type':'application/json'}, body: JSON.stringify({model:request.model.replace('litellm/',''), messages:request.messages, tools:request.tools, stream:false}), signal })
    // For tests, return stub mimicking OpenAI-compatible response
    void effectiveKey;
    void request;
    return {
      choices: [{ message: { content: 'Hello via LiteLLM proxy (unified 100+ providers).' } }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
  }

  async function generate(
    request: NeryvaModelRequest,
    optsSignal?: { signal?: AbortSignal | undefined },
  ): Promise<NeryvaModelResponse> {
    const start = Date.now();
    validate(request);
    const redacted = redactObject(
      { ...request, apiKey: '[REDACTED]', virtualKey: '[REDACTED]' },
      'strict',
    );
    void redacted;
    if (optsSignal?.signal?.aborted)
      throw new NeryvaProviderError({
        code: 'CANCELLED',
        message: 'cancelled before send',
        retryable: false,
        providerId: 'litellm',
      });
    // REAL path — LiteLLM is OpenAI-compatible; route via AI SDK openai provider
    if (!simulate) {
      const cap = LITELLM_CAPABILITIES.find((c: { modelId: string }) => c.modelId === request.model) ?? LITELLM_CAPABILITIES[0];
      if (!cap) throw new Error('no litellm cap');
      try {
        const result = await realGenerate(
          {
            providerId: 'litellm',
            createModel: async (modelId, key) => {
              const { createOpenAI } = await import('@ai-sdk/openai');
              return createOpenAI({ apiKey: key, baseURL: baseUrl })(modelId);
            },
            apiKey: getApiKey,
          },
          request,
          cap,
          optsSignal,
        );
        return { ...result, latencyMs: Date.now() - start };
      } catch (e) {
        throw mapAiSdkError(e, 'litellm');
      }
    }

    // SIMULATION — per-test behavior (deterministic)
    const trigger = messageText(request.messages.at(-1)?.content ?? '');
    const correlation = request.correlationId ?? '';
    if (correlation.includes('case:timeout') || trigger.includes('case:timeout')) {
      await new Promise((_, reject) => {
        const t = setTimeout(
          () =>
            reject(
              new NeryvaProviderError({
                code: 'TIMEOUT',
                message: 'simulated timeout',
                retryable: true,
                providerId: 'litellm',
              }),
            ),
          timeoutMs,
        );
        optsSignal?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          reject(
            new NeryvaProviderError({
              code: 'CANCELLED',
              message: 'aborted',
              retryable: false,
              providerId: 'litellm',
            }),
          );
        });
      });
    }
    if (correlation.includes('case:rate-limit') || trigger.includes('case:rate-limit'))
      throw new NeryvaProviderError({
        code: 'RATE_LIMITED',
        message: 'simulated rate limited',
        retryable: true,
        retryAfterMs: 100,
        providerId: 'litellm',
      });
    if (correlation.includes('case:auth-fail') || trigger.includes('case:auth-fail'))
      throw new NeryvaProviderError({
        code: 'AUTH_FAILED',
        message: 'simulated auth failed',
        retryable: false,
        providerId: 'litellm',
      });
    if (correlation.includes('case:invalid-request') || trigger.includes('case:invalid-request'))
      throw new NeryvaProviderError({
        code: 'INVALID_REQUEST',
        message: 'simulated invalid',
        retryable: false,
        providerId: 'litellm',
      });
    if (correlation.includes('case:context-length') || trigger.includes('case:context-length'))
      throw new NeryvaProviderError({
        code: 'CONTEXT_LENGTH_EXCEEDED',
        message: 'context length',
        retryable: false,
        providerId: 'litellm',
      });
    if (optsSignal?.signal?.aborted)
      throw new NeryvaProviderError({
        code: 'CANCELLED',
        message: 'aborted during generate',
        retryable: false,
        providerId: 'litellm',
      });

    // In production, would call Proxy and normalize via fromAiSdkResult; for tests, deterministic mapping
    const proxyRaw = await callLiteLLMProxy(request);
    void proxyRaw;

    if (request.structuredOutput) {
      const wantsRefusal = trigger.includes('structured:refusal');
      if (wantsRefusal) {
        const usage = normalizeProviderUsage({
          promptTokens: 105,
          completionTokens: 22,
          providerId: 'litellm',
          modelId: request.model,
        });
        const cap = resolveLiteLLMCapability(request.model) ?? LITELLM_CAPABILITIES[0];
        if (!cap) throw new Error('no litellm cap');
        const costed = attachCost(usage, cap);
        return {
          id: `litellm_refuse_${Date.now()}`,
          model: request.model,
          providerId: 'litellm',
          structuredOutputRefusal: true,
          finishReason: 'content-filter',
          usage: costed,
          providerFinishReason: 'content_filter',
          latencyMs: Date.now() - start,
        };
      }
      const usage = normalizeProviderUsage({
        promptTokens: 120,
        completionTokens: 30,
        providerId: 'litellm',
        modelId: request.model,
      });
      const cap = resolveLiteLLMCapability(request.model) ?? LITELLM_CAPABILITIES[0];
      if (!cap) throw new Error('no litellm cap');
      const costed = attachCost(usage, cap);
      return {
        id: `litellm_struct_${Date.now()}`,
        model: request.model,
        providerId: 'litellm',
        structuredOutput: { result: 'structured-ok via litellm' },
        finishReason: 'stop',
        usage: costed,
        providerFinishReason: 'stop',
        latencyMs: Date.now() - start,
      };
    }
    if (
      request.tools &&
      request.tools.length > 0 &&
      (trigger.includes('use-tool:') || correlation.includes('use-tool'))
    ) {
      const tool = request.tools[0];
      if (!tool) throw new Error('tool missing');
      const usage = normalizeProviderUsage({
        promptTokens: 102,
        completionTokens: 24,
        providerId: 'litellm',
        modelId: request.model,
      });
      const cap = resolveLiteLLMCapability(request.model) ?? LITELLM_CAPABILITIES[0];
      if (!cap) throw new Error('no litellm cap');
      const costed = attachCost(usage, cap);
      const args = tool.name === 'search_tickets' ? { query: 'test' } : {};
      return {
        id: `litellm_tool_${Date.now()}`,
        model: request.model,
        providerId: 'litellm',
        toolCalls: [{ id: `call_${Date.now()}`, name: tool.name, args }],
        finishReason: 'tool-call',
        usage: costed,
        providerFinishReason: 'tool_calls',
        latencyMs: Date.now() - start,
      };
    }
    const usage2 = normalizeProviderUsage({
      promptTokens: 102,
      completionTokens: 48,
      providerId: 'litellm',
      modelId: request.model,
    });
    const cap4 = resolveLiteLLMCapability(request.model) ?? LITELLM_CAPABILITIES[0];
    if (!cap4) throw new Error('no litellm cap');
    const costed2 = attachCost(usage2, cap4);
    // Demonstrate unified interface: same text regardless of underlying provider (openai, anthropic, gemini, groq, bedrock, azure, mistral, cohere, together_ai, deepseek, etc.)
    return {
      id: `litellm_${Date.now()}`,
      model: request.model,
      providerId: 'litellm',
      text: 'Hello via LiteLLM proxy (unified 100+ providers).',
      finishReason: 'stop',
      usage: costed2,
      providerFinishReason: 'stop',
      latencyMs: Date.now() - start,
    };
  }

  async function stream(
    request: NeryvaModelRequest,
    optsSignal?: { signal?: AbortSignal | undefined },
  ): Promise<NeryvaStreamResult> {
    validate(request);
    if (optsSignal?.signal?.aborted)
      throw new NeryvaProviderError({
        code: 'CANCELLED',
        message: 'aborted before stream',
        retryable: false,
        providerId: 'litellm',
      });

    // REAL path — AI SDK streaming via LiteLLM OpenAI-compatible endpoint
    if (!simulate) {
      const cap = LITELLM_CAPABILITIES.find((c: { modelId: string }) => c.modelId === request.model) ?? LITELLM_CAPABILITIES[0];
      if (!cap) throw new Error('no litellm cap');
      return await realStream(
        {
          providerId: 'litellm',
          createModel: async (modelId, key) => {
            const { createOpenAI } = await import('@ai-sdk/openai');
            return createOpenAI({ apiKey: key, baseURL: baseUrl })(modelId);
          },
          apiKey: getApiKey,
        },
        request,
        cap,
        optsSignal,
      );
    }

    // SIMULATION — stream via generate then chunk
    const full = await generate(request, optsSignal);
    const text = full.text ?? '';
    const deltas: NeryvaStreamEvent[] = [];
    if (text) {
      const chunkSize = Math.ceil(text.length / 3) || 1;
      for (let i = 0; i < text.length; i += chunkSize) {
        if (optsSignal?.signal?.aborted)
          throw new NeryvaProviderError({
            code: 'CANCELLED',
            message: 'aborted during stream',
            retryable: false,
            providerId: 'litellm',
          });
        deltas.push({ type: 'text-delta', delta: text.slice(i, i + chunkSize) });
      }
    }
    if (full.toolCalls)
      for (const tc of full.toolCalls) deltas.push({ type: 'tool-call', toolCall: tc });
    deltas.push({ type: 'finish', finishReason: full.finishReason, usage: full.usage });
    async function* gen(): AsyncIterable<NeryvaStreamEvent> {
      for (const d of deltas) {
        if (optsSignal?.signal?.aborted)
          throw new NeryvaProviderError({
            code: 'CANCELLED',
            message: 'stream cancelled',
            retryable: false,
            providerId: 'litellm',
          });
        yield d;
      }
    }
    return { stream: gen(), finalResponse: Promise.resolve(full) };
  }

  function wrapGenerateWithAiSdkMapping(
    request: NeryvaModelRequest,
    signal?: AbortSignal,
  ): Promise<NeryvaModelResponse> {
    try {
      return generate(request, { signal });
    } catch (e) {
      throw mapAiSdkError(e, 'litellm');
    }
  }
  void fromAiSdkResult;
  void wrapGenerateWithAiSdkMapping;

  return {
    providerId: 'litellm',
    models: [...LITELLM_CAPABILITIES],
    isHealthy: () => healthy,
    generate,
    stream,
    validate,
  };
}
