/**
 * real-provider.ts — REAL provider invocation via Vercel AI SDK Core (ai@4.x)
 * Source: agent_studio_architecture.md:428, 442, 877-886; ledger 4.3/4.5
 * All provider SDK types stay inside model-gateway; callers see NeryvaModel* only.
 * Adapter owns: streaming, tool round-trip, structured output success/refusal, usage
 * (incl. cached tokens), timeout, cancellation, rate-limit Retry-After, error normalization.
 * The simulated adapters (tests/conformance) never import this module's network calls.
 */

import type { NeryvaModelRequest } from '@neryva/contracts/provider/model-request';
import type {
  NeryvaModelResponse,
  NeryvaStreamEvent,
  NeryvaStreamResult,
} from '@neryva/contracts/provider/model-response';
import type { NeryvaModelCapabilities } from '../capabilities.js';
import { fromAiSdkResult, mapAiSdkError } from './ai-sdk-adapter.js';
import { normalizeProviderUsage, attachCost } from '../usage.js';
import { NeryvaProviderError } from '@neryva/contracts/provider/errors';

/** Minimal language-model type — the AI SDK's LanguageModel without leaking its module here. */
type LanguageModel = unknown;

export interface RealProviderConfig {
  providerId: string;
  /**
   * Build the AI SDK language model for a model id — created per call so key
   * rotation works. May be async (provider SDKs are dynamically imported);
   * callers MUST await it — passing the bare Promise to generateText/streamText
   * fails at runtime ("Unsupported model version").
   */
  createModel: (modelId: string, apiKey: string) => LanguageModel | Promise<LanguageModel>;
  apiKey: string | (() => Promise<string>);
}

type AiSdkGenerate = (opts: Record<string, unknown>) => Promise<Record<string, unknown>>;
type AiSdkStream = (opts: Record<string, unknown>) => {
  textStream: AsyncIterable<string>;
  fullStream: AsyncIterable<Record<string, unknown>>;
  toolCalls?: Promise<Array<Record<string, unknown>>>;
  finishReason?: Promise<string>;
  usage?: Promise<Record<string, unknown>>;
  text?: Promise<string>;
};

let aiModulePromise:
  | Promise<{
      generateText: AiSdkGenerate;
      streamText: AiSdkStream;
      generateObject: AiSdkGenerate;
      jsonSchema: (s: unknown) => unknown;
    }>
  | undefined;

async function loadAiModule(): Promise<{
  generateText: AiSdkGenerate;
  streamText: AiSdkStream;
  generateObject: AiSdkGenerate;
  jsonSchema: (s: unknown) => unknown;
}> {
  if (!aiModulePromise) {
    aiModulePromise = import('ai') as never;
  }
  return aiModulePromise;
}

async function resolveKey(cfg: RealProviderConfig): Promise<string> {
  if (typeof cfg.apiKey === 'function') return cfg.apiKey();
  return cfg.apiKey;
}

/** Real non-streaming generate. Falls back to generateObject for structured output requests. */
export async function realGenerate(
  cfg: RealProviderConfig,
  request: NeryvaModelRequest,
  cap: NeryvaModelCapabilities,
  callOpts?: { signal?: AbortSignal | undefined },
): Promise<NeryvaModelResponse> {
  const { generateText, generateObject, jsonSchema } = await loadAiModule();
  const apiKey = await resolveKey(cfg);
  const model = await cfg.createModel(request.model, apiKey);
  const signal = callOpts?.signal;

  try {
    if (request.structuredOutput) {
      // Structured output path — provider-agnostic JSON Schema; refusal surfaces as
      // generateObject failure mapped to structuredOutputRefusal by the caller contract.
      const result = await generateObject({
        model: model as never,
        schema: jsonSchema(request.structuredOutput.schema),
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        abortSignal: signal,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        topP: request.topP,
        seed: request.seed,
      });
      const usageRaw = (result['usage'] ?? {}) as Record<string, number | undefined>;
      const usage = attachCost(
        normalizeProviderUsage({
          promptTokens: usageRaw['promptTokens'],
          completionTokens: usageRaw['completionTokens'],
          totalTokens: usageRaw['totalTokens'],
          providerId: cfg.providerId,
          modelId: request.model,
        }),
        cap,
      );
      return {
        id: String(result['id'] ?? `gen_${request.correlationId ?? 'structured'}`),
        model: request.model,
        providerId: cfg.providerId,
        structuredOutput: result['object'],
        finishReason: 'stop',
        usage,
        providerFinishReason: 'stop',
        latencyMs: 0,
      };
    }

    const params: Record<string, unknown> = {
      model: model as never,
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      abortSignal: signal,
      maxTokens: request.maxTokens,
      temperature: request.temperature,
      topP: request.topP,
      seed: request.seed,
    };
    if (request.tools && request.tools.length > 0) {
      // v4 tool schema: zod or JSON-Schema — pass raw JSON Schema via jsonSchema()
      params['tools'] = Object.fromEntries(
        request.tools.map((t) => [
          t.name,
          {
            description: t.description,
            parameters: jsonSchema(
              (t as { parameters?: unknown; inputSchema?: unknown }).parameters ??
                (t as { inputSchema?: unknown }).inputSchema ?? { type: 'object', properties: {} },
            ),
          },
        ]),
      );
    }

    const result = await generateText(params);
    const mapped = fromAiSdkResult({
      text: result['text'] as string | undefined,
      toolCalls: result['toolCalls'] as
        Array<{ toolCallId: string; toolName: string; args: unknown }> | undefined,
      finishReason: result['finishReason'] as string | undefined,
      usage: result['usage'] as
        | {
            promptTokens?: number;
            completionTokens?: number;
            totalTokens?: number;
            cachedInputTokens?: number;
          }
        | undefined,
    });
    const usage = attachCost(mapped.usage, cap);
    return {
      id: String(result['id'] ?? `gen_${request.correlationId ?? 'run'}`),
      model: request.model,
      providerId: cfg.providerId,
      text: mapped.response.text,
      toolCalls: mapped.response.toolCalls,
      finishReason: mapped.response.finishReason,
      usage,
      providerFinishReason: mapped.providerFinishReason,
      latencyMs: 0,
    };
  } catch (e) {
    // Structured-output refusal: provider declined schema — surfaced per contract as refusal
    const mappedErr = mapAiSdkError(e, cfg.providerId);
    throw mappedErr;
  }
}

/** Real streaming — fullStream mapped to NeryvaStreamEvent; usage/finish via fullStream end. */
export async function realStream(
  cfg: RealProviderConfig,
  request: NeryvaModelRequest,
  cap: NeryvaModelCapabilities,
  callOpts?: { signal?: AbortSignal | undefined },
): Promise<NeryvaStreamResult> {
  const { streamText, jsonSchema } = await loadAiModule();
  const apiKey = await resolveKey(cfg);
  const model = await cfg.createModel(request.model, apiKey);
  const signal = callOpts?.signal;

  let finalResponse: NeryvaModelResponse | undefined;
  let resolveFinal: (v: NeryvaModelResponse) => void = () => {};
  const finalPromise = new Promise<NeryvaModelResponse>((resolve) => {
    resolveFinal = resolve;
  });

  async function* mapEvents(): AsyncIterable<NeryvaStreamEvent> {
    let usageAgg:
      { promptTokens?: number; completionTokens?: number; totalTokens?: number } | undefined;
    let finishReason: string | undefined;
    let textAgg = '';
    // Tool calls observed on the stream (AI SDK shape) — folded into
    // finalResponse via fromAiSdkResult so the tool loop survives streaming.
    let toolCallsAgg: Array<{ toolCallId: string; toolName: string; args: unknown }> = [];
    let aborted = false;
    try {
      const params: Record<string, unknown> = {
        model: model as never,
        messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
        abortSignal: signal,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
        topP: request.topP,
      };
      if (request.tools && request.tools.length > 0) {
        params['tools'] = Object.fromEntries(
          request.tools.map((t) => [
            t.name,
            {
              description: t.description,
              parameters: jsonSchema(
                (t as { parameters?: unknown; inputSchema?: unknown }).parameters ??
                  (t as { inputSchema?: unknown }).inputSchema ?? {
                    type: 'object',
                    properties: {},
                  },
              ),
            },
          ]),
        );
      }
      const stream = streamText(params);
      for await (const part of stream.fullStream) {
        if (signal?.aborted) {
          aborted = true;
          throw new NeryvaProviderError({
            code: 'CANCELLED',
            message: 'stream cancelled by caller',
            retryable: false,
            providerId: cfg.providerId,
          });
        }
        const type = String(part['type']);
        if (type === 'text-delta') {
          const delta = String(part['textDelta'] ?? part['delta'] ?? '');
          textAgg += delta;
          yield { type: 'text-delta', delta };
        } else if (type === 'tool-call') {
          const toolCall = {
            id: String(part['toolCallId'] ?? ''),
            name: String(part['toolName'] ?? ''),
            args: part['args'] ?? part['input'],
          };
          toolCallsAgg.push({
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolCall.args,
          });
          yield {
            type: 'tool-call',
            toolCall,
          };
        } else if (type === 'finish') {
          finishReason = String(part['finishReason'] ?? 'stop');
          usageAgg = part['usage'] as typeof usageAgg;
        } else if (type === 'error') {
          throw mapAiSdkError(part['error'], cfg.providerId);
        }
      }
      const mapped = fromAiSdkResult({
        text: textAgg,
        finishReason,
        usage: usageAgg,
        toolCalls: toolCallsAgg.length > 0 ? toolCallsAgg : undefined,
      });
      finalResponse = {
        id: `stream_${request.correlationId ?? 'run'}`,
        model: request.model,
        providerId: cfg.providerId,
        text: textAgg || undefined,
        // fromAiSdkResult maps the accumulated tool calls — the tool loop
        // survives streaming only because they are included here.
        toolCalls: mapped.response.toolCalls,
        finishReason: mapped.response.finishReason,
        usage: attachCost(mapped.usage, cap),
        providerFinishReason: mapped.providerFinishReason,
        latencyMs: 0,
      };
      yield {
        type: 'finish',
        finishReason: finalResponse.finishReason,
        usage: finalResponse.usage,
      };
      resolveFinal(finalResponse);
    } catch (e) {
      if (!aborted)
        resolveFinal(mapAiSdkError(e, cfg.providerId) as unknown as NeryvaModelResponse);
      throw e;
    }
  }

  return { stream: mapEvents(), finalResponse: finalPromise };
}
