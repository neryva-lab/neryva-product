/**
 * provider-format.ts — maps compiled context to NeryvaModelRequest provider format
 * Source: agent_studio_architecture.md:472-473, 476, agent_studio_implementation_plan.md:943-955 step 10
 * Deterministic ordering, tool schema selection, token budgeting already done, citation tracking, prompt-cache prep.
 */

import type {
  NeryvaModelRequest,
  NeryvaMessage,
  NeryvaTool,
} from '@neryva/contracts/provider/model-request';
import type { ToolDescriptor } from '@neryva/contracts/tool/descriptor';
import { toProviderTools } from './tool-selector.js';
import { hashContent } from './citations.js';

export interface ProviderFormatInput {
  system: string;
  policy: string; // e.g., "Organization: org1, Retention: eu"
  history: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; sequence: number }>;
  summaries: Array<{
    content: string;
    sourceRange: { fromSequence: number; toSequence: number };
    version: number;
  }>;
  memories: Array<{ content: string; memoryId: string }>;
  knowledge: Array<{ content: string; citation: string }>;
  tools: ToolDescriptor[];
  userMessage: string;
  outputSchema?: Record<string, unknown> | undefined;
  providerCapabilities?:
    | { supportsStructuredOutput?: boolean | undefined; supportsToolCalling?: boolean | undefined }
    | undefined;
}

export interface ProviderFormatResult {
  request: NeryvaModelRequest;
  promptCacheKey?: string | undefined; // for prompt-cache prep (476)
  diagnostics: {
    messageCount: number;
    toolCount: number;
    hasStructuredOutput: boolean;
    promptCachePrepared: boolean;
  };
}

/**
 * FL-1.6 — convert a message's string content into multimodal parts: the
 * original text first, then one image part per claim-check-fetched attachment.
 * The compiler stays pure; the executor fetches bytes and calls this helper.
 */
export function toImagePartsMessage(
  message: NeryvaMessage,
  images: Array<{ mediaType: string; dataBase64: string }>,
): NeryvaMessage {
  const textContent = typeof message.content === 'string' ? message.content : '';
  const parts: NeryvaMessage['content'] = [
    ...(textContent ? [{ type: 'text' as const, text: textContent }] : []),
    ...images.map((img) => ({
      type: 'image' as const,
      mediaType: img.mediaType,
      data: img.dataBase64,
    })),
  ];
  return { ...message, content: parts };
}

/** Media types the runtime accepts as vision attachments (mirrors the Engine). */
export const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);
/** Per-attachment byte cap (mirrors the Engine's claim-check gate). */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
/** Per-message attachment count cap (contract BoundedMessage.attachments). */
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;

export function toProviderFormat(
  input: ProviderFormatInput,
  options: { model: string; maxOutputTokens?: number | undefined },
): ProviderFormatResult {
  const messages: NeryvaMessage[] = [];

  // 1. System — always first, never truncated without safe failure (handled in truncation)
  messages.push({ role: 'system', content: input.system });

  // 2. Policy — second, also never truncated without safe failure
  if (input.policy) {
    messages.push({ role: 'system', content: `Policy: ${input.policy}` });
  }

  // 3. Summaries — inserted before history, with source_range/version for citation
  for (const s of input.summaries) {
    messages.push({
      role: 'system',
      content: `[Summary v${s.version} covering ${s.sourceRange.fromSequence}-${s.sourceRange.toSequence}]: ${s.content}`,
    });
  }

  // 4. Memories — as system context
  for (const m of input.memories) {
    messages.push({ role: 'system', content: `[Memory ${m.memoryId}]: ${m.content}` });
  }

  // 5. Knowledge — as system context with citations
  for (const k of input.knowledge) {
    messages.push({ role: 'system', content: `[Knowledge ${k.citation}]: ${k.content}` });
  }

  // 6. History — already sorted by sequence, deterministic
  for (const h of input.history) {
    messages.push({ role: h.role as 'user' | 'assistant', content: h.content });
  }

  // 7. User message — always last before assistant turn
  messages.push({ role: 'user', content: input.userMessage });

  // Tools — FL-2.15: DETERMINISTIC ORDERING (sorted by toolId, not manifest
  // order) so the provider prefix is byte-stable across runs and the
  // provider's prompt cache hits even after an unrelated tool edit. The
  // cache breakpoint is the stable prefix (system + policy + summaries +
  // memories + knowledge); FL-2.16's tool-result clearing only mutates
  // messages AFTER the prefix, so the two mechanisms never invalidate each
  // other.
  const tools: NeryvaTool[] | undefined =
    input.tools.length > 0
      ? toProviderTools([...input.tools].sort((a, b) => a.toolId.localeCompare(b.toolId)))
      : undefined;

  // Structured output — only if provider supports
  let structuredOutput: { schema: Record<string, unknown> } | undefined = undefined;
  if (input.outputSchema && input.providerCapabilities?.supportsStructuredOutput !== false) {
    structuredOutput = { schema: input.outputSchema };
  }

  const request: NeryvaModelRequest = {
    model: options.model,
    messages,
    tools,
    toolChoice: tools ? 'auto' : undefined,
    structuredOutput,
    maxTokens: options.maxOutputTokens,
  };

  // Prompt-cache prep (476) — hash of stable prefix (system + policy + summaries + memories + knowledge) for cache key
  const cachePrefix = [
    input.system,
    input.policy,
    ...input.summaries.map((s) => s.content),
    ...input.memories.map((m) => m.content),
    ...input.knowledge.map((k) => k.content),
  ].join('|');
  const promptCacheKey =
    cachePrefix.length > 0 ? `pc_${hashContent(cachePrefix).slice(0, 16)}` : undefined;

  request.metadata = {
    ...(request.metadata ?? {}),
    ...(promptCacheKey !== undefined ? { prompt_cache_key: promptCacheKey } : {}),
  };

  return {
    request,
    promptCacheKey,
    diagnostics: {
      messageCount: messages.length,
      toolCount: tools?.length ?? 0,
      hasStructuredOutput: !!structuredOutput,
      promptCachePrepared: !!promptCacheKey,
    },
  };
}
