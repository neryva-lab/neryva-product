/**
 * model-response.ts — NeryvaModelResponse + NeryvaStreamEvent
 * Source: agent_studio_architecture.md:432-439, 877-886
 * Normalized from provider-specific responses; provider metadata is generic.
 */

import { z } from 'zod';
import { NeryvaToolCallSchema } from './tool-call.js';
import { NeryvaUsageSchema } from './usage.js';

export const FinishReasonSchema = z.enum([
  'stop',
  'tool-call',
  'length',
  'content-filter',
  'error',
  'cancelled',
]);

export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const NeryvaModelResponseSchema = z.object({
  /** Provider-assigned id (for audit, not canonical) */
  id: z.string().optional(),
  /** Model that actually generated (may differ from request due to fallback) */
  model: z.string(),
  /** Provider that served */
  providerId: z.string(),
  /** Text content (may be empty if tool-call only) */
  text: z.string().optional(),
  /** Tool calls (if any) */
  toolCalls: z.array(NeryvaToolCallSchema).optional(),
  /** Structured output parsed JSON (if requested) */
  structuredOutput: z.unknown().optional(),
  /** Whether structured output was refused (safety) */
  structuredOutputRefusal: z.boolean().optional(),
  /** Finish reason normalized */
  finishReason: FinishReasonSchema,
  /** Normalized usage */
  usage: NeryvaUsageSchema,
  /** Raw provider finish reason for telemetry */
  providerFinishReason: z.string().optional(),
  /** Latency ms as measured by gateway */
  latencyMs: z.number().int().min(0).optional(),
  /** Whether response was truncated due to context limits */
  isTruncated: z.boolean().optional(),
});

export type NeryvaModelResponse = z.infer<typeof NeryvaModelResponseSchema>;

export const NeryvaStreamEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), delta: z.string(), text: z.string().optional() }),
  z.object({ type: z.literal('tool-call-delta'), toolCallId: z.string(), delta: z.string() }),
  z.object({ type: z.literal('tool-call'), toolCall: NeryvaToolCallSchema }),
  z.object({
    type: z.literal('finish'),
    finishReason: FinishReasonSchema,
    usage: NeryvaUsageSchema.optional(),
  }),
  z.object({ type: z.literal('error'), error: z.string() }),
]);

export type NeryvaStreamEvent = z.infer<typeof NeryvaStreamEventSchema>;

export interface NeryvaStreamResult {
  /** Async iterable of stream events */
  stream: AsyncIterable<NeryvaStreamEvent>;
  /** Final response when stream completes (for testing) */
  finalResponse?: Promise<NeryvaModelResponse> | undefined;
}
