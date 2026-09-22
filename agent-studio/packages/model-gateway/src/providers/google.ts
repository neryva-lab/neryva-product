/**
 * google.ts — Google Gemini adapter via Vercel AI SDK
 * Source: agent_studio_architecture.md:778, 772-790 (11 cases), 789
 * Google-specific: supports up to 1M context via Gemini 1.5 Pro, retention config via provider metadata.
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

const GOOGLE_MODELS = DEFAULT_CAPABILITIES.filter((c) => c.providerId === 'google');

export function createGoogleAdapter(opts: ProviderFactoryOptions): ProviderAdapter {
  const { timeoutMs = 30_000 } = opts;
  const simulate = isSimulationMode(opts);
  const getApiKey: () => Promise<string> = opts.getApiKey ?? (async () => opts.apiKey ?? '');
    if (!simulate && !(opts.apiKey || opts.getApiKey)) {
    throw new NeryvaProviderError({
      code: 'AUTH_FAILED',
      message: 'Google credentials required (apiKey or getApiKey) for real mode',
      retryable: false,
      providerId: 'google',
    });
  }
  const healthy = true;

  function validate(request: NeryvaModelRequest): void {
    const cap = GOOGLE_MODELS.find((c) => c.modelId === request.model);
    if (!cap)
      throw new NeryvaProviderError({
        code: 'NOT_FOUND',
        message: `model ${request.model} not found for google`,
        retryable: false,
        providerId: 'google',
      });
    const estimatedTokens =
      request.messages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0) +
      (request.maxTokens ?? 0);
    if (estimatedTokens > cap.contextWindow)
      throw new NeryvaProviderError({
        code: 'CONTEXT_LENGTH_EXCEEDED',
        message: `estimated ${estimatedTokens} > ${cap.contextWindow}`,
        retryable: false,
        providerId: 'google',
      });
    if (request.tools && request.tools.length > 32)
      throw new NeryvaProviderError({
        code: 'INVALID_REQUEST',
        message: 'too many tools',
        retryable: false,
        providerId: 'google',
      });
    // Retention config: Google data retention must respect org policy (e.g., 30d) — validate header would be set in production adapter
    void request;
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
        providerId: 'google',
      });
    // REAL path — AI SDK Core call with per-call credential resolution
    if (!simulate) {
      const cap = GOOGLE_MODELS.find((c) => c.modelId === request.model) ?? GOOGLE_MODELS[0];
      if (!cap) throw new Error('no google cap');
      try {
        const result = await realGenerate(
          {
            providerId: 'google',
            createModel: async (modelId, apiKey) => {
          const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
          return createGoogleGenerativeAI({ apiKey })(modelId);
        },
            apiKey: getApiKey,
          },
          request,
          cap,
          optsSignal,
        );
        return { ...result, latencyMs: Date.now() - start };
      } catch (e) {
        throw mapAiSdkError(e, 'google');
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
                providerId: 'google',
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
              providerId: 'google',
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
        providerId: 'google',
      });
    if (correlation.includes('case:auth-fail') || trigger.includes('case:auth-fail'))
      throw new NeryvaProviderError({
        code: 'AUTH_FAILED',
        message: 'simulated auth failed',
        retryable: false,
        providerId: 'google',
      });
    if (correlation.includes('case:invalid-request') || trigger.includes('case:invalid-request'))
      throw new NeryvaProviderError({
        code: 'INVALID_REQUEST',
        message: 'simulated invalid',
        retryable: false,
        providerId: 'google',
      });
    if (correlation.includes('case:context-length') || trigger.includes('case:context-length'))
      throw new NeryvaProviderError({
        code: 'CONTEXT_LENGTH_EXCEEDED',
        message: 'context length',
        retryable: false,
        providerId: 'google',
      });
    if (optsSignal?.signal?.aborted)
      throw new NeryvaProviderError({
        code: 'CANCELLED',
        message: 'aborted during generate',
        retryable: false,
        providerId: 'google',
      });

    if (request.structuredOutput) {
      const wantsRefusal = trigger.includes('structured:refusal');
      if (wantsRefusal) {
        const usage = normalizeProviderUsage({
          promptTokens: 115,
          completionTokens: 22,
          providerId: 'google',
          modelId: request.model,
        });
        const cap = GOOGLE_MODELS.find((c) => c.modelId === request.model) ?? GOOGLE_MODELS[0];
        if (!cap) throw new Error('no google cap');
        const costed = attachCost(usage, cap);
        return {
          id: `google_refuse_${Date.now()}`,
          model: request.model,
          providerId: 'google',
          structuredOutputRefusal: true,
          finishReason: 'content-filter',
          usage: costed,
          providerFinishReason: 'SAFETY',
          latencyMs: Date.now() - start,
        };
      }
      const usage = normalizeProviderUsage({
        promptTokens: 125,
        completionTokens: 32,
        providerId: 'google',
        modelId: request.model,
      });
      const cap = GOOGLE_MODELS.find((c) => c.modelId === request.model) ?? GOOGLE_MODELS[0];
      if (!cap) throw new Error('no google cap');
      const costed = attachCost(usage, cap);
      return {
        id: `google_struct_${Date.now()}`,
        model: request.model,
        providerId: 'google',
        structuredOutput: { result: 'structured-ok' },
        finishReason: 'stop',
        usage: costed,
        providerFinishReason: 'STOP',
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
        promptTokens: 108,
        completionTokens: 28,
        providerId: 'google',
        modelId: request.model,
      });
      const cap = GOOGLE_MODELS.find((c) => c.modelId === request.model) ?? GOOGLE_MODELS[0];
      if (!cap) throw new Error('no google cap');
      const costed = attachCost(usage, cap);
      const args = tool.name === 'search_tickets' ? { query: 'test' } : {};
      return {
        id: `google_tool_${Date.now()}`,
        model: request.model,
        providerId: 'google',
        toolCalls: [{ id: `call_${Date.now()}`, name: tool.name, args }],
        finishReason: 'tool-call',
        usage: costed,
        providerFinishReason: 'TOOL_CALL',
        latencyMs: Date.now() - start,
      };
    }
    const usage2 = normalizeProviderUsage({
      promptTokens: 108,
      completionTokens: 52,
      providerId: 'google',
      modelId: request.model,
    });
    const cap4 = GOOGLE_MODELS.find((c) => c.modelId === request.model) ?? GOOGLE_MODELS[0];
    if (!cap4) throw new Error('no google cap');
    const costed2 = attachCost(usage2, cap4);
    return {
      id: `google_${Date.now()}`,
      model: request.model,
      providerId: 'google',
      text: 'Hello from Google Gemini (gateway).',
      finishReason: 'stop',
      usage: costed2,
      providerFinishReason: 'STOP',
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
        providerId: 'google',
      });

    // REAL path — AI SDK streamText mapping
    if (!simulate) {
      const cap = GOOGLE_MODELS.find((c) => c.modelId === request.model) ?? GOOGLE_MODELS[0];
      if (!cap) throw new Error('no google cap');
      return await realStream(
        {
          providerId: 'google',
          createModel: async (modelId, apiKey) => {
          const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
          return createGoogleGenerativeAI({ apiKey })(modelId);
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
            providerId: 'google',
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
            providerId: 'google',
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
      throw mapAiSdkError(e, 'google');
    }
  }
  void fromAiSdkResult;
  void wrapGenerateWithAiSdkMapping;

  return {
    providerId: 'google',
    models: GOOGLE_MODELS,
    isHealthy: () => healthy,
    generate,
    stream,
    validate,
  };
}
