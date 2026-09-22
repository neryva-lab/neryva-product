/**
 * anthropic.ts — Anthropic adapter via Vercel AI SDK (or LiteLLM proxy)
 * Source: agent_studio_implementation_plan.md:777, agent_studio_architecture.md:772-790 (11 cases), 789 (context limits/retention)
 * Checklist: streaming, tool calls, structured output success/refusal, usage, context limits, timeout, error normalization, retention, cancellation, redaction.
 * Uses Vercel AI SDK's @ai-sdk/anthropic behind Neryva contracts; LiteLLM proxy also supports anthropic via same OpenAI-compatible path.
 */
import { messageText, type NeryvaModelRequest } from '@neryva/contracts/provider/model-request';
import type {
  NeryvaModelResponse,
  NeryvaStreamResult,
  NeryvaStreamEvent,
} from '@neryva/contracts/provider/model-response';
import { DEFAULT_CAPABILITIES } from '../capabilities.js';
import type { ProviderAdapter, ProviderFactoryOptions } from './provider.js';
import { isSimulationMode } from './provider.js';
import { NeryvaProviderError } from '@neryva/contracts/provider/errors';
import { normalizeProviderUsage, attachCost } from '../usage.js';
import { redactObject } from '../redaction.js';
import { fromAiSdkResult, mapAiSdkError } from '../adapters/ai-sdk-adapter.js';
import { realGenerate, realStream } from '../adapters/real-provider.js';

const ANTHROPIC_MODELS = DEFAULT_CAPABILITIES.filter((c) => c.providerId === 'anthropic');

export function createAnthropicAdapter(opts: ProviderFactoryOptions): ProviderAdapter {
  const { timeoutMs = 30_000 } = opts;
  const simulate = isSimulationMode(opts);
  const getApiKey: () => Promise<string> = opts.getApiKey ?? (async () => opts.apiKey ?? '');
    if (!simulate && !(opts.apiKey || opts.getApiKey)) {
    throw new NeryvaProviderError({
      code: 'AUTH_FAILED',
      message: 'Anthropic credentials required (apiKey or getApiKey) for real mode',
      retryable: false,
      providerId: 'anthropic',
    });
  }
  const healthy = true;

  function validate(request: NeryvaModelRequest): void {
    const cap = ANTHROPIC_MODELS.find((c) => c.modelId === request.model);
    if (!cap)
      throw new NeryvaProviderError({
        code: 'NOT_FOUND',
        message: `model ${request.model} not found for anthropic`,
        retryable: false,
        providerId: 'anthropic',
      });
    const estimatedTokens =
      request.messages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0) +
      (request.maxTokens ?? 0);
    if (estimatedTokens > cap.contextWindow)
      throw new NeryvaProviderError({
        code: 'CONTEXT_LENGTH_EXCEEDED',
        message: `estimated ${estimatedTokens} > ${cap.contextWindow}`,
        retryable: false,
        providerId: 'anthropic',
      });
    if (request.tools && request.tools.length > 32)
      throw new NeryvaProviderError({
        code: 'INVALID_REQUEST',
        message: 'too many tools',
        retryable: false,
        providerId: 'anthropic',
      });
    if (request.structuredOutput && !cap.supportsStructuredOutput)
      throw new NeryvaProviderError({
        code: 'UNSUPPORTED_FEATURE',
        message: 'structured output not supported',
        retryable: false,
        providerId: 'anthropic',
      });
  }

  async function generate(
    request: NeryvaModelRequest,
    optsSignal?: { signal?: AbortSignal | undefined },
  ): Promise<NeryvaModelResponse> {
    const start = Date.now();
    validate(request);
    const redacted = redactObject({ ...request, apiKey: '[REDACTED]' }, 'strict');
    void redacted;
    if (optsSignal?.signal?.aborted)
      throw new NeryvaProviderError({
        code: 'CANCELLED',
        message: 'cancelled before send',
        retryable: false,
        providerId: 'anthropic',
      });
    // REAL path — AI SDK Core call with per-call credential resolution
    if (!simulate) {
      const cap = ANTHROPIC_MODELS.find((c) => c.modelId === request.model) ?? ANTHROPIC_MODELS[0];
      if (!cap) throw new Error('no anthropic cap');
      try {
        const result = await realGenerate(
          {
            providerId: 'anthropic',
            createModel: async (modelId, apiKey) => {
          const { createAnthropic } = await import('@ai-sdk/anthropic');
          return createAnthropic({ apiKey })(modelId);
        },
            apiKey: getApiKey,
          },
          request,
          cap,
          optsSignal,
        );
        return { ...result, latencyMs: Date.now() - start };
      } catch (e) {
        throw mapAiSdkError(e, 'anthropic');
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
                providerId: 'anthropic',
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
              providerId: 'anthropic',
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
        providerId: 'anthropic',
      });
    if (correlation.includes('case:auth-fail') || trigger.includes('case:auth-fail'))
      throw new NeryvaProviderError({
        code: 'AUTH_FAILED',
        message: 'simulated auth failed',
        retryable: false,
        providerId: 'anthropic',
      });
    if (correlation.includes('case:invalid-request') || trigger.includes('case:invalid-request'))
      throw new NeryvaProviderError({
        code: 'INVALID_REQUEST',
        message: 'simulated invalid',
        retryable: false,
        providerId: 'anthropic',
      });
    if (correlation.includes('case:context-length') || trigger.includes('case:context-length'))
      throw new NeryvaProviderError({
        code: 'CONTEXT_LENGTH_EXCEEDED',
        message: 'context length',
        retryable: false,
        providerId: 'anthropic',
      });
    if (optsSignal?.signal?.aborted)
      throw new NeryvaProviderError({
        code: 'CANCELLED',
        message: 'aborted during generate',
        retryable: false,
        providerId: 'anthropic',
      });

    if (request.structuredOutput) {
      const wantsRefusal = trigger.includes('structured:refusal');
      if (wantsRefusal) {
        const usage = normalizeProviderUsage({
          promptTokens: 110,
          completionTokens: 25,
          providerId: 'anthropic',
          modelId: request.model,
        });
        const cap =
          ANTHROPIC_MODELS.find((c) => c.modelId === request.model) ?? ANTHROPIC_MODELS[0];
        if (!cap) throw new Error('no anthropic cap');
        const costed = attachCost(usage, cap);
        return {
          id: `anth_refuse_${Date.now()}`,
          model: request.model,
          providerId: 'anthropic',
          structuredOutputRefusal: true,
          finishReason: 'content-filter',
          usage: costed,
          providerFinishReason: 'content_filter',
          latencyMs: Date.now() - start,
        };
      }
      const usage = normalizeProviderUsage({
        promptTokens: 130,
        completionTokens: 35,
        providerId: 'anthropic',
        modelId: request.model,
      });
      const cap = ANTHROPIC_MODELS.find((c) => c.modelId === request.model) ?? ANTHROPIC_MODELS[0];
      if (!cap) throw new Error('no anthropic cap');
      const costed = attachCost(usage, cap);
      return {
        id: `anth_struct_${Date.now()}`,
        model: request.model,
        providerId: 'anthropic',
        structuredOutput: { result: 'structured-ok' },
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
        promptTokens: 105,
        completionTokens: 25,
        providerId: 'anthropic',
        modelId: request.model,
      });
      const cap = ANTHROPIC_MODELS.find((c) => c.modelId === request.model) ?? ANTHROPIC_MODELS[0];
      if (!cap) throw new Error('no anthropic cap');
      const costed = attachCost(usage, cap);
      const args = tool.name === 'search_tickets' ? { query: 'test' } : {};
      return {
        id: `anth_tool_${Date.now()}`,
        model: request.model,
        providerId: 'anthropic',
        toolCalls: [{ id: `call_${Date.now()}`, name: tool.name, args }],
        finishReason: 'tool-call',
        usage: costed,
        providerFinishReason: 'tool_use',
        latencyMs: Date.now() - start,
      };
    }
    const usage2 = normalizeProviderUsage({
      promptTokens: 105,
      completionTokens: 55,
      providerId: 'anthropic',
      modelId: request.model,
    });
    const cap4 = ANTHROPIC_MODELS.find((c) => c.modelId === request.model) ?? ANTHROPIC_MODELS[0];
    if (!cap4) throw new Error('no anthropic cap');
    const costed2 = attachCost(usage2, cap4);
    return {
      id: `anth_${Date.now()}`,
      model: request.model,
      providerId: 'anthropic',
      text: 'Hello from Anthropic (gateway).',
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
        providerId: 'anthropic',
      });

    // REAL path — AI SDK streamText mapping
    if (!simulate) {
      const cap = ANTHROPIC_MODELS.find((c) => c.modelId === request.model) ?? ANTHROPIC_MODELS[0];
      if (!cap) throw new Error('no anthropic cap');
      return await realStream(
        {
          providerId: 'anthropic',
          createModel: async (modelId, apiKey) => {
          const { createAnthropic } = await import('@ai-sdk/anthropic');
          return createAnthropic({ apiKey })(modelId);
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
            providerId: 'anthropic',
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
            providerId: 'anthropic',
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
      throw mapAiSdkError(e, 'anthropic');
    }
  }
  void fromAiSdkResult;
  void wrapGenerateWithAiSdkMapping;

  return {
    providerId: 'anthropic',
    models: ANTHROPIC_MODELS,
    isHealthy: () => healthy,
    generate,
    stream,
    validate,
  };
}
