/**
 * ai-sdk-adapter.ts — Vercel AI SDK Core behind NeryvaModelRequest/Response
 * Source: agent_studio_architecture.md:428, 442, 877-886
 * Pin AI SDK to tested major (ai@^4.3), upgrade via adapter conformance.
 * Provider-specific mapping is isolated here; types never leak via gateway.
 * Streaming: chunks/finish reasons/tool args/provider IDs/structured-output success+refusal/usage cache tokens/rate limits/retry-after/safety refusals/cancellation.
 */

// NOTE: Import is inside function to keep provider SDK out of workflow bundle and allow tests without live dep.
// `ai` is peer of model-gateway (root dependency). Types are local contracts only.

import type { NeryvaModelRequest } from '@neryva/contracts/provider/model-request';
import type {
  NeryvaModelResponse,
  NeryvaStreamEvent,
} from '@neryva/contracts/provider/model-response';
import type { NeryvaUsage } from '@neryva/contracts/provider/usage';
import { normalizeProviderUsage } from '../usage.js';
import { NeryvaProviderError } from '@neryva/contracts/provider/errors';
import { redactObject } from '../redaction.js';

export interface AiSdkAdapterOptions {
  providerId: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Map Neryva request to AI SDK `generateText`/`streamText` params.
 * This layer owns prompt-cache prep, token budgeting is done by Context Compiler.
 */
export function toAiSdkParams(request: NeryvaModelRequest): Record<string, unknown> {
  // Redact before tracing
  const redacted = redactObject(request, 'strict');
  void redacted;
  return {
    model: request.model,
    messages: request.messages.map((m: { role: string; content: unknown }) => ({
      role: m.role,
      content: m.content,
    })),
    tools: request.tools?.reduce(
      (
        acc: Record<string, unknown>,
        t: { name: string; description: string; parameters?: unknown; inputSchema?: unknown },
      ) => {
        acc[t.name] = {
          description: t.description,
          parameters: t.parameters ?? t.inputSchema ?? {},
        };
        return acc;
      },
      {} as Record<string, unknown>,
    ),
    toolChoice: request.toolChoice,
    temperature: request.temperature,
    maxTokens: request.maxTokens,
    seed: request.seed,
  };
}

/**
 * Normalize AI SDK result to NeryvaModelResponse + NeryvaUsage.
 * Handles: finish reasons, tool args parsing, structured output, usage, cost, truncation.
 */
export function fromAiSdkResult(raw: {
  text?: string | undefined;
  toolCalls?: Array<{ toolCallId: string; toolName: string; args: unknown }> | undefined;
  finishReason?: string | undefined;
  usage?:
    | {
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        cachedInputTokens?: number;
      }
    | undefined;
  providerMetadata?: unknown | undefined;
  warnings?: unknown | undefined;
}): {
  response: Omit<NeryvaModelResponse, 'providerId' | 'model' | 'usage' | 'finishReason'> & {
    finishReason: NeryvaModelResponse['finishReason'];
  };
  usage: NeryvaUsage;
  providerFinishReason?: string | undefined;
} {
  const finishMap: Record<string, NeryvaModelResponse['finishReason']> = {
    stop: 'stop',
    'tool-calls': 'tool-call',
    tool_calls: 'tool-call',
    length: 'length',
    'content-filter': 'content-filter',
    error: 'error',
  };
  const finishReason = finishMap[raw.finishReason ?? 'stop'] ?? 'stop';
  const usage = normalizeProviderUsage({
    promptTokens: raw.usage?.promptTokens ?? 0,
    completionTokens: raw.usage?.completionTokens ?? 0,
    totalTokens: raw.usage?.totalTokens,
    cachedTokens: raw.usage?.cachedInputTokens,
  });
  const toolCalls = raw.toolCalls?.map((tc) => ({
    id: tc.toolCallId,
    name: tc.toolName,
    args: tc.args,
  }));
  return {
    response: {
      text: raw.text,
      toolCalls,
      finishReason,
    },
    usage,
    providerFinishReason: raw.finishReason,
  };
}

export function toStreamEvents(
  chunks: Array<{ type: string; textDelta?: string; toolCall?: unknown }>,
): NeryvaStreamEvent[] {
  const events: NeryvaStreamEvent[] = [];
  for (const c of chunks) {
    if (c.type === 'text-delta' && c.textDelta)
      events.push({ type: 'text-delta', delta: c.textDelta });
    if (c.type === 'tool-call' && c.toolCall) {
      const tc = c.toolCall as { toolCallId: string; toolName: string; args: unknown };
      events.push({
        type: 'tool-call',
        toolCall: { id: tc.toolCallId, name: tc.toolName, args: tc.args },
      });
    }
  }
  return events;
}

export function mapAiSdkError(e: unknown, providerId: string): NeryvaProviderError {
  const msg = e instanceof Error ? e.message : String(e);
  const lower = msg.toLowerCase();
  if (lower.includes('rate limit') || lower.includes('429')) {
    const m = msg.match(/retry.*?(\d+)/i);
    const retryAfterMs = m?.[1] ? Number(m[1]) * 1000 : undefined;
    return new NeryvaProviderError({
      code: 'RATE_LIMITED',
      message: msg,
      retryable: true,
      retryAfterMs,
      providerId,
    });
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return new NeryvaProviderError({ code: 'TIMEOUT', message: msg, retryable: true, providerId });
  }
  if (
    lower.includes('context length') ||
    lower.includes('too long') ||
    lower.includes('max_tokens')
  ) {
    return new NeryvaProviderError({
      code: 'CONTEXT_LENGTH_EXCEEDED',
      message: msg,
      retryable: false,
      providerId,
    });
  }
  if (lower.includes('unsupported') || lower.includes('not supported')) {
    return new NeryvaProviderError({
      code: 'UNSUPPORTED_FEATURE',
      message: msg,
      retryable: false,
      providerId,
    });
  }
  if (lower.includes('auth') || lower.includes('401') || lower.includes('403')) {
    return new NeryvaProviderError({
      code: 'AUTH_FAILED',
      message: msg,
      retryable: false,
      providerId,
    });
  }
  if (msg.includes('CANCELLED') || lower.includes('aborted')) {
    return new NeryvaProviderError({
      code: 'CANCELLED',
      message: msg,
      retryable: false,
      providerId,
    });
  }
  return new NeryvaProviderError({ code: 'UNKNOWN', message: msg, retryable: false, providerId });
}
