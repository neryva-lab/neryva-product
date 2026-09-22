/**
 * openai.ts — first provider adapter (OpenAI via AI SDK or direct, deterministic for tests)
 * Source: agent_studio_architecture.md:772-790 per-provider checklist
 * Checklist: streaming, tool calls, structured output success/refusal, usage, context limits, timeout, error normalization, retention, cancellation, redaction.
 * Credentials via secret-provider, never in logs/workflow.
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

const OPENAI_MODELS = DEFAULT_CAPABILITIES.filter((c) => c.providerId === 'openai');

/** Build the AI SDK OpenAI client + model for a request (key resolved per call). */
async function openAiModel(modelId: string, apiKey: string): Promise<unknown> {
  const { createOpenAI } = await import('@ai-sdk/openai');
  const provider = createOpenAI({ apiKey, compatibility: 'strict' });
  return provider(modelId);
}

export function createOpenAIAdapter(opts: ProviderFactoryOptions): ProviderAdapter {
  const { timeoutMs = 30_000 } = opts;
  const simulate = isSimulationMode(opts);
  const getApiKey: () => Promise<string> = opts.getApiKey ?? (async () => opts.apiKey ?? '');
  if (!simulate && !(opts.apiKey || opts.getApiKey)) {
    throw new NeryvaProviderError({
      code: 'AUTH_FAILED',
      message: 'OpenAI credentials required (apiKey or getApiKey) for real mode',
      retryable: false,
      providerId: 'openai',
    });
  }

  const healthy = true;

  function validate(request: NeryvaModelRequest): void {
    // Context limits — fail fast before network
    const cap = OPENAI_MODELS.find((c) => c.modelId === request.model);
    if (!cap)
      throw new NeryvaProviderError({
        code: 'NOT_FOUND',
        message: `model ${request.model} not found for openai`,
        retryable: false,
        providerId: 'openai',
      });
    const estimatedTokens =
      request.messages.reduce((acc, m) => acc + Math.ceil(m.content.length / 4), 0) +
      (request.maxTokens ?? 0);
    if (estimatedTokens > cap.contextWindow) {
      throw new NeryvaProviderError({
        code: 'CONTEXT_LENGTH_EXCEEDED',
        message: `estimated ${estimatedTokens} > contextWindow ${cap.contextWindow}`,
        retryable: false,
        providerId: 'openai',
      });
    }
    if (request.tools && request.tools.length > 32) {
      throw new NeryvaProviderError({
        code: 'INVALID_REQUEST',
        message: 'too many tools',
        retryable: false,
        providerId: 'openai',
      });
    }
    if (request.structuredOutput && !cap.supportsStructuredOutput) {
      throw new NeryvaProviderError({
        code: 'UNSUPPORTED_FEATURE',
        message: 'structured output not supported for this model',
        retryable: false,
        providerId: 'openai',
      });
    }
  }

  async function generate(
    request: NeryvaModelRequest,
    optsSignal?: { signal?: AbortSignal | undefined },
  ): Promise<NeryvaModelResponse> {
    const start = Date.now();
    // Validate before network
    validate(request);

    // Redact for tracing (never log raw credential)
    const redacted = redactObject({ ...request, apiKey: '[REDACTED]' }, 'strict');
    void redacted;

    // Cancellation
    if (optsSignal?.signal?.aborted)
      throw new NeryvaProviderError({
        code: 'CANCELLED',
        message: 'request cancelled before send',
        retryable: false,
        providerId: 'openai',
      });

    const cap = OPENAI_MODELS.find((c) => c.modelId === request.model) ?? OPENAI_MODELS[0];
    if (!cap) throw new Error('no openai cap');

    // REAL path — AI SDK Core call with per-call credential resolution
    if (!simulate) {
      try {
        const result = await realGenerate(
          {
            providerId: 'openai',
            createModel: (modelId, apiKey) => openAiModel(modelId, apiKey),
            apiKey: getApiKey,
          },
          request,
          cap,
          optsSignal,
        );
        return { ...result, latencyMs: Date.now() - start };
      } catch (e) {
        throw mapAiSdkError(e, 'openai');
      }
    }

    // SIMULATION path — per-test behavior (deterministic, no live call in unit tests)
    // Tests use correlationId or message content to trigger specific conformance cases
    const trigger = messageText(request.messages.at(-1)?.content ?? '');
    const correlation = request.correlationId ?? '';

    // Injected fault cases for 11 conformance matrix
    if (correlation.includes('case:timeout') || trigger.includes('case:timeout')) {
      // Simulate timeout — respect AbortSignal timeout
      await new Promise((_, reject) => {
        const t = setTimeout(
          () =>
            reject(
              new NeryvaProviderError({
                code: 'TIMEOUT',
                message: 'simulated timeout',
                retryable: true,
                providerId: 'openai',
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
              providerId: 'openai',
            }),
          );
        });
      });
    }
    if (correlation.includes('case:rate-limit') || trigger.includes('case:rate-limit')) {
      throw new NeryvaProviderError({
        code: 'RATE_LIMITED',
        message: 'simulated rate limited',
        retryable: true,
        retryAfterMs: 100,
        providerId: 'openai',
      });
    }
    if (correlation.includes('case:auth-fail') || trigger.includes('case:auth-fail')) {
      throw new NeryvaProviderError({
        code: 'AUTH_FAILED',
        message: 'simulated auth failed',
        retryable: false,
        providerId: 'openai',
      });
    }
    if (correlation.includes('case:invalid-request') || trigger.includes('case:invalid-request')) {
      throw new NeryvaProviderError({
        code: 'INVALID_REQUEST',
        message: 'simulated invalid request',
        retryable: false,
        providerId: 'openai',
      });
    }
    if (correlation.includes('case:context-length') || trigger.includes('case:context-length')) {
      throw new NeryvaProviderError({
        code: 'CONTEXT_LENGTH_EXCEEDED',
        message: 'simulated context length exceeded',
        retryable: false,
        providerId: 'openai',
      });
    }

    // Abort handling during generation
    if (optsSignal?.signal?.aborted)
      throw new NeryvaProviderError({
        code: 'CANCELLED',
        message: 'aborted during generate',
        retryable: false,
        providerId: 'openai',
      });

    // Success paths — deterministic mapping for tests
    // Structured output
    if (request.structuredOutput) {
      const wantsRefusal = trigger.includes('structured:refusal');
      if (wantsRefusal) {
        const usage = normalizeProviderUsage({
          promptTokens: 100,
          completionTokens: 20,
          providerId: 'openai',
          modelId: request.model,
        });
        const found = OPENAI_MODELS.find((c) => c.modelId === request.model);
        const cap = found ?? OPENAI_MODELS[0];
        if (!cap) throw new Error('no openai cap');
        const costed = attachCost(usage, cap);
        return {
          id: `chatcmpl_refuse_${Date.now()}`,
          model: request.model,
          providerId: 'openai',
          text: undefined,
          structuredOutput: undefined,
          structuredOutputRefusal: true,
          finishReason: 'content-filter',
          usage: costed,
          providerFinishReason: 'content_filter',
          latencyMs: Date.now() - start,
        };
      }
      // Success: echo schema with dummy data
      const usage = normalizeProviderUsage({
        promptTokens: 120,
        completionTokens: 30,
        providerId: 'openai',
        modelId: request.model,
      });
      const found2 = OPENAI_MODELS.find((c) => c.modelId === request.model);
      const cap2 = found2 ?? OPENAI_MODELS[0];
      if (!cap2) throw new Error('no openai cap');
      const costed = attachCost(usage, cap2);
      return {
        id: `chatcmpl_struct_${Date.now()}`,
        model: request.model,
        providerId: 'openai',
        structuredOutput: { result: 'structured-ok', echo: request.structuredOutput.schema },
        finishReason: 'stop',
        usage: costed,
        providerFinishReason: 'stop',
        latencyMs: Date.now() - start,
      };
    }

    // Tool call
    if (
      request.tools &&
      request.tools.length > 0 &&
      (trigger.includes('use-tool:') || correlation.includes('use-tool'))
    ) {
      const tool = request.tools[0];
      if (!tool) throw new Error('tool missing');
      const usage = normalizeProviderUsage({
        promptTokens: 100,
        completionTokens: 20,
        providerId: 'openai',
        modelId: request.model,
      });
      const found3 = OPENAI_MODELS.find((c) => c.modelId === request.model);
      const cap = found3 ?? OPENAI_MODELS[0];
      if (!cap) throw new Error('no openai cap');
      const costed = attachCost(usage, cap);
      // Simulate tool args as valid JSON per tool schema
      const args = tool.name === 'search_tickets' ? { query: 'test' } : {};
      return {
        id: `chatcmpl_tool_${Date.now()}`,
        model: request.model,
        providerId: 'openai',
        toolCalls: [{ id: `call_${Date.now()}`, name: tool.name, args }],
        finishReason: 'tool-call',
        usage: costed,
        providerFinishReason: 'tool_calls',
        latencyMs: Date.now() - start,
      };
    }

    // Default text
    const usage2 = normalizeProviderUsage({
      promptTokens: 100,
      completionTokens: 50,
      providerId: 'openai',
      modelId: request.model,
    });
    const found4 = OPENAI_MODELS.find((c) => c.modelId === request.model);
    const cap4 = found4 ?? OPENAI_MODELS[0];
    if (!cap4) throw new Error('no openai cap');
    const costed2 = attachCost(usage2, cap4);
    return {
      id: `chatcmpl_${Date.now()}`,
      model: request.model,
      providerId: 'openai',
      text: 'Hello from OpenAI (gateway).',
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
        providerId: 'openai',
      });

    // REAL path — AI SDK streamText mapping
    if (!simulate) {
      const cap = OPENAI_MODELS.find((c) => c.modelId === request.model) ?? OPENAI_MODELS[0];
      if (!cap) throw new Error('no openai cap');
      const result = await realStream(
        {
          providerId: 'openai',
          createModel: (modelId, apiKey) => openAiModel(modelId, apiKey),
          apiKey: getApiKey,
        },
        request,
        cap,
        optsSignal,
      );
      return result;
    }

    // SIMULATION — stream via generate then chunk
    const full = await generate(request, optsSignal);
    const text = full.text ?? '';
    // Chunk into 3 deltas + finish
    const deltas: NeryvaStreamEvent[] = [];
    if (text) {
      const chunkSize = Math.ceil(text.length / 3) || 1;
      for (let i = 0; i < text.length; i += chunkSize) {
        if (optsSignal?.signal?.aborted)
          throw new NeryvaProviderError({
            code: 'CANCELLED',
            message: 'aborted during stream',
            retryable: false,
            providerId: 'openai',
          });
        deltas.push({ type: 'text-delta', delta: text.slice(i, i + chunkSize) });
      }
    }
    if (full.toolCalls) {
      for (const tc of full.toolCalls) deltas.push({ type: 'tool-call', toolCall: tc });
    }
    deltas.push({ type: 'finish', finishReason: full.finishReason, usage: full.usage });

    async function* gen(): AsyncIterable<NeryvaStreamEvent> {
      for (const d of deltas) {
        // Check cancellation between chunks
        if (optsSignal?.signal?.aborted)
          throw new NeryvaProviderError({
            code: 'CANCELLED',
            message: 'stream cancelled',
            retryable: false,
            providerId: 'openai',
          });
        yield d;
      }
    }

    return { stream: gen(), finalResponse: Promise.resolve(full) };
  }

  // Wrap with AI SDK error mapping example (would call generateText/streamText in production)
  function wrapGenerateWithAiSdkMapping(
    request: NeryvaModelRequest,
    signal?: AbortSignal,
  ): Promise<NeryvaModelResponse> {
    try {
      // In production: const result = await generateText({ model: openai(request.model), ...toAiSdkParams(request), abortSignal: signal })
      // const mapped = fromAiSdkResult({ text: result.text, toolCalls: result.toolCalls, finishReason: result.finishReason, usage: result.usage })
      // Map error via mapAiSdkError
      return generate(request, { signal });
    } catch (e) {
      throw mapAiSdkError(e, 'openai');
    }
  }
  void fromAiSdkResult;
  void wrapGenerateWithAiSdkMapping;

  return {
    providerId: 'openai',
    models: OPENAI_MODELS,
    isHealthy: () => healthy,
    generate,
    stream,
    validate,
  };
}
